import { address, getPublicKeyFromAddress } from "@solana/addresses";
import { getBase58Decoder, getBase58Encoder } from "@solana/codecs-strings";
import { isSignature, signBytes, signatureBytes, verifySignature } from "@solana/keys";
import canonicalize from "canonicalize";
import { PURCHASE_PERMIT_DOMAIN } from "./domain.js";
import type { SignedPurchasePermitV1 } from "./types.js";

/**
 * Agent -> authority authorization request, signed by the agent's
 * *identity* key (the key whose address is the permit's `authorizedAgent`).
 *
 * The identity key only authenticates requests; it can never move funds.
 * The authority, not the agent, constructs and signs any payment. This
 * signature is what proves the caller is the permit's authorized agent -- a
 * transport bearer token does not.
 */
export const AUTHORIZATION_REQUEST_PROTOCOL = "virtual-haibin/authorization-request";
export const AUTHORIZATION_REQUEST_VERSION = 1;

export type AuthorizationRequestV1 = {
  protocol: typeof AUTHORIZATION_REQUEST_PROTOCOL;
  version: typeof AUTHORIZATION_REQUEST_VERSION;
  /** Identifier of the authority this request is meant for; prevents cross-authority reuse. */
  audience: string;
  grantId: string;
  /** Lowercase hex SHA-256 of the exact signed permit (see computePermitDigest). */
  permitDigest: string;
  invocationId: string;
  service: string;
  capability: string;
  network: string;
  /** Authoritative mint address as quoted by the service. */
  mint: string;
  /** Authoritative recipient address as quoted by the service. */
  recipient: string;
  /** Integer atomic units, canonical decimal string (no floating point). */
  amountAtomic: string;
  /** Unix milliseconds when the agent signed the request; bounded by the authority's skew policy. */
  issuedAt: number;
};

export type AgentRequestSignature = {
  algorithm: "ed25519";
  /** Base58-encoded 64-byte Ed25519 detached signature. */
  signature: string;
};

export type AuthorizationRequestValidationResult =
  | { valid: true; request: AuthorizationRequestV1 }
  | { valid: false; message: string };

const REQUEST_FIELDS = [
  "protocol",
  "version",
  "audience",
  "grantId",
  "permitDigest",
  "invocationId",
  "service",
  "capability",
  "network",
  "mint",
  "recipient",
  "amountAtomic",
  "issuedAt",
] as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const MAX_FIELD_LENGTH = 256;

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * Structural validation of an untrusted authorization request. Unknown
 * fields are rejected rather than ignored, so nothing unsigned can ride
 * along with a request. Whether the values are *authorized* is decided
 * later against the permit.
 */
export function validateAuthorizationRequest(candidate: unknown): AuthorizationRequestValidationResult {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { valid: false, message: "authorizationRequest must be a JSON object." };
  }

  const record = candidate as Record<string, unknown>;
  const unknownField = Object.keys(record).find((key) => !(REQUEST_FIELDS as readonly string[]).includes(key));

  if (unknownField !== undefined) {
    return { valid: false, message: `authorizationRequest has unexpected field ${JSON.stringify(unknownField)}.` };
  }

  if (record.protocol !== AUTHORIZATION_REQUEST_PROTOCOL || record.version !== AUTHORIZATION_REQUEST_VERSION) {
    return { valid: false, message: "Unsupported authorization request protocol/version." };
  }

  for (const field of ["audience", "grantId", "invocationId"] as const) {
    if (typeof record[field] !== "string" || !IDENTIFIER_PATTERN.test(record[field])) {
      return { valid: false, message: `authorizationRequest.${field} must be a non-empty identifier.` };
    }
  }

  if (typeof record.permitDigest !== "string" || !DIGEST_PATTERN.test(record.permitDigest)) {
    return { valid: false, message: "authorizationRequest.permitDigest must be a lowercase hex SHA-256 digest." };
  }

  for (const field of ["service", "capability", "network", "mint", "recipient"] as const) {
    if (!isBoundedString(record[field])) {
      return { valid: false, message: `authorizationRequest.${field} must be a non-empty string.` };
    }
  }

  if (typeof record.amountAtomic !== "string" || !ATOMIC_AMOUNT_PATTERN.test(record.amountAtomic)) {
    return { valid: false, message: "authorizationRequest.amountAtomic must be a canonical integer string." };
  }

  if (typeof record.issuedAt !== "number" || !Number.isSafeInteger(record.issuedAt) || record.issuedAt <= 0) {
    return { valid: false, message: "authorizationRequest.issuedAt must be a positive safe-integer Unix millisecond timestamp." };
  }

  return {
    valid: true,
    request: {
      protocol: AUTHORIZATION_REQUEST_PROTOCOL,
      version: AUTHORIZATION_REQUEST_VERSION,
      audience: record.audience as string,
      grantId: record.grantId as string,
      permitDigest: record.permitDigest,
      invocationId: record.invocationId as string,
      service: record.service as string,
      capability: record.capability as string,
      network: record.network as string,
      mint: record.mint as string,
      recipient: record.recipient as string,
      amountAtomic: record.amountAtomic,
      issuedAt: record.issuedAt,
    },
  };
}

function canonicalBytes(domainPrefix: string, value: unknown): Uint8Array<ArrayBuffer> {
  const canonicalJson = canonicalize(value);

  if (canonicalJson === undefined) {
    throw new Error("Value cannot be canonicalized.");
  }

  return new TextEncoder().encode(domainPrefix + canonicalJson);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Digest of the exact signed permit, including its signature, so a request
 * signed for one permit can never be presented with another (even another
 * valid permit for the same agent and grant). Fields are copied explicitly
 * so extra properties on the input object cannot change the digest.
 */
export async function computePermitDigest(permit: SignedPurchasePermitV1): Promise<string> {
  const exact: SignedPurchasePermitV1 = {
    version: permit.version,
    domain: permit.domain,
    grantId: permit.grantId,
    issuer: permit.issuer,
    authorizedAgent: permit.authorizedAgent,
    service: permit.service,
    capability: permit.capability,
    network: permit.network,
    mint: permit.mint,
    recipient: permit.recipient,
    maxPerCallAtomic: permit.maxPerCallAtomic,
    maxTotalAtomic: permit.maxTotalAtomic,
    issuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
    subdelegation: permit.subdelegation,
    signature: { algorithm: permit.signature.algorithm, signature: permit.signature.signature },
  };

  return sha256Hex(canonicalBytes(`${PURCHASE_PERMIT_DOMAIN}:v${permit.version}:digest\n`, exact));
}

/** Exact bytes the agent signs: domain-separated RFC 8785 JSON of the request. */
export function canonicalizeAuthorizationRequest(request: AuthorizationRequestV1): Uint8Array {
  return canonicalBytes(`${AUTHORIZATION_REQUEST_PROTOCOL}:v${request.version}\n`, request);
}

export async function signAuthorizationRequest(
  request: AuthorizationRequestV1,
  agentIdentity: CryptoKeyPair,
): Promise<AgentRequestSignature> {
  const validation = validateAuthorizationRequest(request);

  if (!validation.valid) {
    throw new Error(`Cannot sign an invalid authorization request: ${validation.message}`);
  }

  const rawSignature = await signBytes(agentIdentity.privateKey, canonicalizeAuthorizationRequest(validation.request));
  return { algorithm: "ed25519", signature: getBase58Decoder().decode(rawSignature) };
}

/**
 * Verifies an untrusted agent signature over an already-validated request
 * against the expected agent address (the permit's `authorizedAgent`).
 * Fails closed: any malformed input returns false rather than throwing.
 */
export async function verifyAuthorizationRequestSignature(
  request: AuthorizationRequestV1,
  candidateSignature: unknown,
  expectedAgent: string,
): Promise<boolean> {
  try {
    if (typeof candidateSignature !== "object" || candidateSignature === null || Array.isArray(candidateSignature)) {
      return false;
    }

    const record = candidateSignature as Record<string, unknown>;

    if (record.algorithm !== "ed25519" || typeof record.signature !== "string" || !isSignature(record.signature)) {
      return false;
    }

    const publicKey = await getPublicKeyFromAddress(address(expectedAgent));
    const rawSignature = signatureBytes(getBase58Encoder().encode(record.signature));
    return await verifySignature(publicKey, rawSignature, canonicalizeAuthorizationRequest(request));
  } catch {
    return false;
  }
}

