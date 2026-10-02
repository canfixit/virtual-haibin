import { address, getAddressFromPublicKey, getPublicKeyFromAddress } from "@solana/addresses";
import { getBase58Decoder, getBase58Encoder } from "@solana/codecs-strings";
import { isSignature, signatureBytes, signBytes, verifySignature } from "@solana/keys";
import canonicalize from "canonicalize";
import { computePaidRequestDigest } from "@virtual-haibin/payments";
import { artifactDigest } from "./manifest.js";
import { EvidenceFormatError, parseServiceAcknowledgement, parseServiceAuthorization } from "./parse.js";
import type { EvidenceSignature } from "./types.js";

/**
 * Phase 5C: the two signed messages exchanged with the paid service.
 *
 * ServiceAuthorizationV1 (authority -> service, `x-vh-authorization` header
 * on the PAID retry only): "the pinned Virtual Haibin authority authorized
 * invocation X to pay exactly these terms for exactly this HTTP request".
 * A Virtual Haibin-integrated service verifies it against the authority key
 * it pinned BEFORE its payment gate settles anything.
 *
 * ServiceAcknowledgementV1 (service -> authority,
 * `x-vh-service-acknowledgement` response header): "the service accepted
 * that authorization, received exactly this operation, was paid by this
 * transaction, and returned exactly these result bytes", signed with the
 * service's own persistent key.
 *
 * Both are narrow, MVP-specific formats -- not a merchant SDK or a general
 * receipt standard. Neither proves the result is *correct*.
 */
export const SERVICE_AUTHORIZATION_DOMAIN = "virtual-haibin/service-authorization";
export const SERVICE_ACKNOWLEDGEMENT_DOMAIN = "virtual-haibin/service-acknowledgement";
export const SERVICE_AUTHORIZATION_HEADER = "x-vh-authorization";
export const SERVICE_ACKNOWLEDGEMENT_HEADER = "x-vh-service-acknowledgement";
/** Authorizations are short-lived: they only need to survive one paid retry. */
export const SERVICE_AUTHORIZATION_TTL_MS = 120_000;
const MAX_HEADER_CHARS = 4096;

export type UnsignedServiceAuthorizationV1 = {
  version: 1;
  domain: typeof SERVICE_AUTHORIZATION_DOMAIN;
  /** Base58 public key of the authorizing Virtual Haibin authority. */
  authority: string;
  invocationId: string;
  grantId: string;
  /** The exact HTTP request authorized: digest per computePaidRequestDigest(method, url, contentType, body). */
  request: { method: "POST"; url: string; contentType: "application/json"; requestSha256: string };
  /** computeOperationDigest of the human-approved, agent-requested operation. */
  operationDigest: string;
  /** The payment the authority is about to make for it (x402 requirement terms). */
  payment: { network: string; asset: string; payTo: string; amountAtomic: string };
  issuedAt: number;
  expiresAt: number;
};
export type SignedServiceAuthorizationV1 = UnsignedServiceAuthorizationV1 & { signature: EvidenceSignature };

export type UnsignedServiceAcknowledgementV1 = {
  version: 1;
  domain: typeof SERVICE_ACKNOWLEDGEMENT_DOMAIN;
  /** Base58 public key of the paid service. */
  service: string;
  invocationId: string;
  /** serviceAuthorizationDigest of the authorization the service accepted. */
  authorizationDigest: string;
  /** Digest the SERVICE recomputed from the request bytes it received. */
  requestSha256: string;
  /** The operation the service parsed and performed. */
  received: { method: string; resource: string; operation: string; datasetId: string };
  /** The payment the service's own gate settled (transaction id as reported by its facilitator). */
  payment: { transaction: string | null; asset: string; payTo: string; amountAtomic: string };
  /** The exact response the service sent. */
  result: { httpStatus: number; contentType: "application/json"; sha256: string; bytes: number };
  fulfilledAt: number;
};
export type SignedServiceAcknowledgementV1 = UnsignedServiceAcknowledgementV1 & { signature: EvidenceSignature };

function canonicalBytes(domain: string, value: unknown): Uint8Array<ArrayBuffer> {
  const json = canonicalize(value);

  if (json === undefined) {
    throw new Error("Value cannot be canonicalized.");
  }

  return new TextEncoder().encode(`${domain}:v1\n${json}`);
}

async function sign<T extends object>(domain: string, unsigned: T, signer: CryptoKeyPair, expectedKey: string): Promise<T & { signature: EvidenceSignature }> {
  if ((await getAddressFromPublicKey(signer.publicKey)) !== expectedKey) {
    throw new Error(`Signer does not match the ${domain} key field.`);
  }

  const raw = await signBytes(signer.privateKey, canonicalBytes(domain, unsigned));
  return { ...unsigned, signature: { algorithm: "ed25519", signature: getBase58Decoder().decode(raw) } };
}

async function verify(domain: string, signed: { signature: EvidenceSignature }, namedKey: string, pinnedKey: string): Promise<boolean> {
  try {
    // The key a message names is never trusted by itself.
    if (namedKey !== pinnedKey || signed.signature.algorithm !== "ed25519" || !isSignature(signed.signature.signature)) {
      return false;
    }

    const { signature, ...unsigned } = signed;
    const publicKey = await getPublicKeyFromAddress(address(pinnedKey));
    return await verifySignature(publicKey, signatureBytes(getBase58Encoder().encode(signature.signature)), canonicalBytes(domain, unsigned));
  } catch {
    return false;
  }
}

export const signServiceAuthorization = (unsigned: UnsignedServiceAuthorizationV1, signer: CryptoKeyPair) =>
  sign(SERVICE_AUTHORIZATION_DOMAIN, unsigned, signer, unsigned.authority);

export const verifyServiceAuthorizationSignature = (authorization: SignedServiceAuthorizationV1, pinnedAuthority: string) =>
  verify(SERVICE_AUTHORIZATION_DOMAIN, authorization, authorization.authority, pinnedAuthority);

export const signServiceAcknowledgement = (unsigned: UnsignedServiceAcknowledgementV1, signer: CryptoKeyPair) =>
  sign(SERVICE_ACKNOWLEDGEMENT_DOMAIN, unsigned, signer, unsigned.service);

export const verifyServiceAcknowledgementSignature = (acknowledgement: SignedServiceAcknowledgementV1, pinnedService: string) =>
  verify(SERVICE_ACKNOWLEDGEMENT_DOMAIN, acknowledgement, acknowledgement.service, pinnedService);

export const serviceAuthorizationDigest = (authorization: SignedServiceAuthorizationV1) => artifactDigest("service-authorization", authorization);

/** Header encoding: base64url of the canonical JSON. */
export function encodeServiceHeader(value: SignedServiceAuthorizationV1 | SignedServiceAcknowledgementV1): string {
  const json = canonicalize(value);

  if (json === undefined) {
    throw new Error("Value cannot be canonicalized.");
  }

  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeHeader(header: string): unknown {
  if (header.length === 0 || header.length > MAX_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(header)) {
    throw new EvidenceFormatError("header", "must be bounded base64url");
  }

  try {
    return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new EvidenceFormatError("header", "is not base64url JSON");
  }
}

/** Strictly decodes an untrusted header. Throws EvidenceFormatError only. */
export const decodeServiceAuthorizationHeader = (header: string) => parseServiceAuthorization(decodeHeader(header), "serviceAuthorization");
export const decodeServiceAcknowledgementHeader = (header: string) => parseServiceAcknowledgement(decodeHeader(header), "serviceAcknowledgement");

export type ServiceAuthorizationReasonCode =
  | "SERVICE_AUTHORIZATION_REQUIRED"
  | "SERVICE_AUTHORIZATION_INVALID"
  | "SERVICE_AUTHORIZATION_EXPIRED"
  | "SERVICE_AUTHORIZATION_REQUEST_MISMATCH"
  | "SERVICE_AUTHORIZATION_PAYMENT_MISMATCH";

export type ServiceAuthorizationCheck =
  | { ok: true; authorization: SignedServiceAuthorizationV1; requestSha256: string; authorizationDigest: string }
  | { ok: false; reasonCode: ServiceAuthorizationReasonCode; message: string };

/**
 * What a Virtual Haibin-integrated service checks on a PAID request, before
 * its payment gate may settle: a valid authorization signed by the pinned
 * authority, unexpired, for exactly the request bytes received (method,
 * path, body via the request digest), this invocation, and exactly the
 * service's own price / recipient / asset. Pure; fails closed.
 */
export async function checkServiceAuthorization(context: {
  header: string | undefined;
  pinnedAuthority: string;
  method: string;
  path: string;
  /** Exact request body bytes as received. */
  rawBody: Uint8Array;
  invocationIdHeader: string | undefined;
  expectedPayment: { asset: string; payTo: string; amountAtomic: string };
  now: number;
}): Promise<ServiceAuthorizationCheck> {
  const fail = (reasonCode: ServiceAuthorizationReasonCode, message: string): ServiceAuthorizationCheck => ({ ok: false, reasonCode, message });

  if (context.header === undefined || context.header.length === 0) {
    return fail("SERVICE_AUTHORIZATION_REQUIRED", "A paid request must carry a Virtual Haibin service authorization.");
  }

  let authorization: SignedServiceAuthorizationV1;

  try {
    authorization = decodeServiceAuthorizationHeader(context.header);
  } catch (error) {
    return fail("SERVICE_AUTHORIZATION_INVALID", error instanceof Error ? error.message : "malformed authorization");
  }

  if (!(await verifyServiceAuthorizationSignature(authorization, context.pinnedAuthority))) {
    return fail("SERVICE_AUTHORIZATION_INVALID", "Authorization is not signed by the pinned Virtual Haibin authority.");
  }

  if (context.now < authorization.issuedAt - 30_000 || context.now > authorization.expiresAt) {
    return fail("SERVICE_AUTHORIZATION_EXPIRED", "Authorization is outside its validity window.");
  }

  let path: string;

  try {
    path = new URL(authorization.request.url).pathname;
  } catch {
    return fail("SERVICE_AUTHORIZATION_INVALID", "Authorization URL is malformed.");
  }

  const body = new TextDecoder("utf-8", { fatal: false }).decode(context.rawBody);
  const requestSha256 = computePaidRequestDigest({ method: "POST", url: authorization.request.url, contentType: "application/json", body });

  if (
    context.method !== authorization.request.method ||
    context.path !== path ||
    Buffer.compare(Buffer.from(body, "utf8"), Buffer.from(context.rawBody)) !== 0 ||
    requestSha256 !== authorization.request.requestSha256 ||
    context.invocationIdHeader !== authorization.invocationId
  ) {
    return fail("SERVICE_AUTHORIZATION_REQUEST_MISMATCH", "Received request is not the request the authority authorized.");
  }

  const { asset, payTo, amountAtomic } = context.expectedPayment;

  if (authorization.payment.asset !== asset || authorization.payment.payTo !== payTo || authorization.payment.amountAtomic !== amountAtomic) {
    return fail("SERVICE_AUTHORIZATION_PAYMENT_MISMATCH", "Authorized payment terms differ from this service's price.");
  }

  return { ok: true, authorization, requestSha256, authorizationDigest: await serviceAuthorizationDigest(authorization) };
}
