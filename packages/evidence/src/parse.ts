import type { ConfirmedSettlement, PaymentAttempt, PaymentRequirement } from "@virtual-haibin/payments";
import type { AuthorizationRequestV2, ExactOperationV1, SignedPurchasePermitV2 } from "@virtual-haibin/mandate";
import type { SignedAuthorizationReceiptV2 } from "./receipt.js";
import type { SignedServiceAcknowledgementV1, SignedServiceAuthorizationV1 } from "./service.js";
import {
  EVIDENCE_BUNDLE_DOMAIN,
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_BUNDLE_VERSION_2,
  EVIDENCE_MANIFEST_DOMAIN,
  EVIDENCE_MANIFEST_VERSION,
  EVIDENCE_MANIFEST_VERSION_2,
  PURCHASE_STATES,
  type EvidenceAuthorizationRequest,
  type EvidenceBundle,
  type EvidenceDigestsV2,
  type EvidenceOutboundRequest,
  type EvidenceResult,
  type PurchaseState,
  type SignedEvidenceManifest,
} from "./types.js";

/**
 * Strict, hostile-input parser for EvidenceBundleV1.
 *
 * - bounded input size, string lengths, array lengths and integer ranges
 * - every object must have exactly its known keys: an unknown key anywhere
 *   fails closed (it could otherwise carry semantics the signatures and
 *   digests do not cover)
 * - returns explicit copies; nothing from the input object graph is reused
 * - no URL is fetched, no file is read, nothing is evaluated
 *
 * Structure only: signatures, digests and relationships are checked by the
 * verifier, which reports them as individual claims.
 */

export const MAX_BUNDLE_BYTES = 512 * 1024;
const MAX_STRING = 512;
const MAX_URL = 2048;
const MAX_BODY = 16 * 1024;
const MAX_TRANSACTION_BASE64 = 4096;
const MAX_RESULT_BASE64 = 96 * 1024;
const MAX_REASON_CODES = 32;

export class EvidenceFormatError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "EvidenceFormatError";
  }
}

type Json = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new EvidenceFormatError(path, message);
}

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }

  const record = value as Json;

  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(path, `unknown field ${JSON.stringify(key)}`);
    }
  }

  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      fail(path, `missing field ${JSON.stringify(key)}`);
    }
  }

  return record;
}

function string(value: unknown, path: string, max = MAX_STRING, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(path, `must be a non-empty string of at most ${max} characters`);
  }

  if (pattern !== undefined && !pattern.test(value)) {
    fail(path, "has an invalid format");
  }

  return value;
}

function integer(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    fail(path, `must be a safe integer >= ${min}`);
  }

  return value;
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    fail(path, `must be ${JSON.stringify(expected)}`);
  }

  return expected;
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,19})$/;

const signature = (value: unknown, path: string) => {
  const record = object(value, path, ["algorithm", "signature"]);
  return { algorithm: literal(record.algorithm, "ed25519", `${path}.algorithm`), signature: string(record.signature, `${path}.signature`, 128, BASE58) };
};

const operation = (value: unknown, path: string): ExactOperationV1 => {
  const record = object(value, path, ["method", "resource", "operation", "datasetId"]);
  // Value checks (enums, patterns) are part of the authorization claims.
  return {
    method: string(record.method, `${path}.method`, 16) as ExactOperationV1["method"],
    resource: string(record.resource, `${path}.resource`, 256),
    operation: string(record.operation, `${path}.operation`, 64) as ExactOperationV1["operation"],
    datasetId: string(record.datasetId, `${path}.datasetId`, 128),
  };
};

const PERMIT_FIELDS = [
  "version",
  "domain",
  "grantId",
  "issuer",
  "authorizedAgent",
  "service",
  "capability",
  "network",
  "mint",
  "recipient",
  "maxPerCallAtomic",
  "maxTotalAtomic",
  "issuedAt",
  "expiresAt",
  "subdelegation",
  "operation",
  "signature",
] as const;

function permit(value: unknown, path: string): SignedPurchasePermitV2 {
  const r = object(value, path, PERMIT_FIELDS);

  if (r.subdelegation !== false) {
    fail(`${path}.subdelegation`, "must be false");
  }

  return {
    version: literal(r.version, 2, `${path}.version`),
    domain: string(r.domain, `${path}.domain`) as SignedPurchasePermitV2["domain"],
    grantId: string(r.grantId, `${path}.grantId`, 128),
    issuer: string(r.issuer, `${path}.issuer`, 64, BASE58),
    authorizedAgent: string(r.authorizedAgent, `${path}.authorizedAgent`, 64, BASE58),
    service: string(r.service, `${path}.service`, 128),
    capability: string(r.capability, `${path}.capability`, 128),
    network: string(r.network, `${path}.network`, 64) as SignedPurchasePermitV2["network"],
    mint: string(r.mint, `${path}.mint`, 64, BASE58),
    recipient: string(r.recipient, `${path}.recipient`, 64, BASE58),
    maxPerCallAtomic: string(r.maxPerCallAtomic, `${path}.maxPerCallAtomic`, 20, ATOMIC),
    maxTotalAtomic: string(r.maxTotalAtomic, `${path}.maxTotalAtomic`, 20, ATOMIC),
    issuedAt: integer(r.issuedAt, `${path}.issuedAt`, 1),
    expiresAt: integer(r.expiresAt, `${path}.expiresAt`, 1),
    subdelegation: false,
    operation: operation(r.operation, `${path}.operation`),
    signature: signature(r.signature, `${path}.signature`),
  };
}

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
  "operation",
] as const;

function authorizationRequest(value: unknown, path: string): EvidenceAuthorizationRequest {
  const wrapper = object(value, path, ["request", "agentSignature"]);
  const r = object(wrapper.request, `${path}.request`, REQUEST_FIELDS);
  const p = `${path}.request`;
  const request: AuthorizationRequestV2 = {
    protocol: string(r.protocol, `${p}.protocol`) as AuthorizationRequestV2["protocol"],
    version: literal(r.version, 2, `${p}.version`),
    audience: string(r.audience, `${p}.audience`, 128),
    grantId: string(r.grantId, `${p}.grantId`, 128),
    permitDigest: string(r.permitDigest, `${p}.permitDigest`, 64, HEX64),
    invocationId: string(r.invocationId, `${p}.invocationId`, 128),
    service: string(r.service, `${p}.service`, 128),
    capability: string(r.capability, `${p}.capability`, 128),
    network: string(r.network, `${p}.network`, 64),
    mint: string(r.mint, `${p}.mint`, 64),
    recipient: string(r.recipient, `${p}.recipient`, 64),
    amountAtomic: string(r.amountAtomic, `${p}.amountAtomic`, 20, ATOMIC),
    issuedAt: integer(r.issuedAt, `${p}.issuedAt`, 1),
    operation: operation(r.operation, `${p}.operation`),
  };
  return { request, agentSignature: signature(wrapper.agentSignature, `${path}.agentSignature`) };
}

const RECEIPT_FIELDS = [
  "version",
  "domain",
  "invocationId",
  "grantId",
  "authority",
  "agent",
  "permitDigest",
  "requestFingerprint",
  "service",
  "capability",
  "network",
  "mint",
  "recipient",
  "amountAtomic",
  "decision",
  "reasonCodes",
  "paymentTransactionId",
  "decidedAt",
  "operation",
  "operationDigest",
  "signature",
] as const;

function reasonCodes(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REASON_CODES) {
    fail(path, `must be an array of at most ${MAX_REASON_CODES} codes`);
  }

  return value.map((code, index) => string(code, `${path}[${index}]`, 64, /^[A-Z0-9_]+$/));
}

function decision(value: unknown, path: string): "ALLOW" | "DENY" {
  if (value !== "ALLOW" && value !== "DENY") {
    fail(path, "must be ALLOW or DENY");
  }

  return value;
}

function receipt(value: unknown, path: string): SignedAuthorizationReceiptV2 {
  const r = object(value, path, RECEIPT_FIELDS);
  return {
    version: literal(r.version, 2, `${path}.version`),
    domain: string(r.domain, `${path}.domain`) as SignedAuthorizationReceiptV2["domain"],
    invocationId: string(r.invocationId, `${path}.invocationId`, 128),
    grantId: string(r.grantId, `${path}.grantId`, 128),
    authority: string(r.authority, `${path}.authority`, 64, BASE58),
    agent: string(r.agent, `${path}.agent`, 64, BASE58),
    permitDigest: string(r.permitDigest, `${path}.permitDigest`, 64, HEX64),
    requestFingerprint: string(r.requestFingerprint, `${path}.requestFingerprint`, 64, HEX64),
    service: string(r.service, `${path}.service`, 128),
    capability: string(r.capability, `${path}.capability`, 128),
    network: string(r.network, `${path}.network`, 64),
    mint: string(r.mint, `${path}.mint`, 64),
    recipient: string(r.recipient, `${path}.recipient`, 64),
    amountAtomic: string(r.amountAtomic, `${path}.amountAtomic`, 20, ATOMIC),
    decision: decision(r.decision, `${path}.decision`),
    reasonCodes: reasonCodes(r.reasonCodes, `${path}.reasonCodes`),
    paymentTransactionId: nullable(r.paymentTransactionId, (v) => string(v, `${path}.paymentTransactionId`, 128, BASE58)),
    decidedAt: integer(r.decidedAt, `${path}.decidedAt`, 1),
    operation: operation(r.operation, `${path}.operation`),
    operationDigest: string(r.operationDigest, `${path}.operationDigest`, 64, HEX64),
    signature: signature(r.signature, `${path}.signature`),
  };
}

function outboundRequest(value: unknown, path: string): EvidenceOutboundRequest {
  const r = object(value, path, ["method", "url", "contentType", "body", "sha256"]);
  return {
    method: literal(r.method, "POST", `${path}.method`),
    url: string(r.url, `${path}.url`, MAX_URL),
    contentType: literal(r.contentType, "application/json", `${path}.contentType`),
    body: string(r.body, `${path}.body`, MAX_BODY),
    sha256: string(r.sha256, `${path}.sha256`, 64, HEX64),
  };
}

const REQUIREMENT_FIELDS = [
  "protocol",
  "x402Version",
  "acceptsIndex",
  "scheme",
  "network",
  "asset",
  "payTo",
  "amountAtomic",
  "feePayer",
  "maxTimeoutSeconds",
  "resourceUrl",
] as const;

function paymentRequirement(value: unknown, path: string): PaymentRequirement {
  const r = object(value, path, REQUIREMENT_FIELDS);
  return {
    protocol: literal(r.protocol, "x402", `${path}.protocol`),
    x402Version: integer(r.x402Version, `${path}.x402Version`),
    acceptsIndex: integer(r.acceptsIndex, `${path}.acceptsIndex`),
    scheme: string(r.scheme, `${path}.scheme`, 32),
    network: string(r.network, `${path}.network`, 128),
    asset: string(r.asset, `${path}.asset`, 64),
    payTo: string(r.payTo, `${path}.payTo`, 64),
    amountAtomic: string(r.amountAtomic, `${path}.amountAtomic`, 20, ATOMIC),
    feePayer: nullable(r.feePayer, (v) => string(v, `${path}.feePayer`, 64)),
    maxTimeoutSeconds: nullable(r.maxTimeoutSeconds, (v) => integer(v, `${path}.maxTimeoutSeconds`)),
    resourceUrl: nullable(r.resourceUrl, (v) => string(v, `${path}.resourceUrl`, MAX_URL)),
  };
}

const ATTEMPT_FIELDS = [
  "protocol",
  "scheme",
  "settlementProfile",
  "network",
  "payer",
  "payerSignature",
  "feePayer",
  "asset",
  "payTo",
  "amountAtomic",
  "blockhash",
  "lastValidBlockHeight",
  "resourceUrl",
  "requestSha256",
  "preparedAt",
] as const;

function paymentAttempt(value: unknown, path: string): PaymentAttempt {
  const r = object(value, path, ATTEMPT_FIELDS, ["transactionBase64"]);
  const attempt: PaymentAttempt = {
    protocol: literal(r.protocol, "x402", `${path}.protocol`),
    scheme: string(r.scheme, `${path}.scheme`, 32),
    settlementProfile: string(r.settlementProfile, `${path}.settlementProfile`, 64),
    network: string(r.network, `${path}.network`, 128),
    payer: string(r.payer, `${path}.payer`, 64),
    payerSignature: string(r.payerSignature, `${path}.payerSignature`, 128),
    feePayer: string(r.feePayer, `${path}.feePayer`, 64),
    asset: string(r.asset, `${path}.asset`, 64),
    payTo: string(r.payTo, `${path}.payTo`, 64),
    amountAtomic: string(r.amountAtomic, `${path}.amountAtomic`, 20, ATOMIC),
    blockhash: string(r.blockhash, `${path}.blockhash`, 64),
    lastValidBlockHeight: string(r.lastValidBlockHeight, `${path}.lastValidBlockHeight`, 20, ATOMIC),
    resourceUrl: string(r.resourceUrl, `${path}.resourceUrl`, MAX_URL),
    requestSha256: string(r.requestSha256, `${path}.requestSha256`, 64, HEX64),
    preparedAt: integer(r.preparedAt, `${path}.preparedAt`),
  };

  if (Object.hasOwn(r, "transactionBase64")) {
    attempt.transactionBase64 = string(r.transactionBase64, `${path}.transactionBase64`, MAX_TRANSACTION_BASE64, BASE64);
  }

  return attempt;
}

function settlement(value: unknown, path: string): ConfirmedSettlement {
  const r = object(value, path, ["transactionId", "slot", "facilitatorReportedTransaction", "confirmedAt"]);
  return {
    transactionId: string(r.transactionId, `${path}.transactionId`, 128, BASE58),
    slot: nullable(r.slot, (v) => string(v, `${path}.slot`, 20, ATOMIC)),
    facilitatorReportedTransaction: nullable(r.facilitatorReportedTransaction, (v) => string(v, `${path}.facilitatorReportedTransaction`, 128)),
    confirmedAt: integer(r.confirmedAt, `${path}.confirmedAt`),
  };
}

function result(value: unknown, path: string): EvidenceResult {
  const r = object(value, path, ["httpStatus", "contentType", "bodyBase64", "bytes", "sha256"]);
  return {
    httpStatus: integer(r.httpStatus, `${path}.httpStatus`, 100),
    contentType: literal(r.contentType, "application/json", `${path}.contentType`),
    bodyBase64: typeof r.bodyBase64 === "string" && r.bodyBase64.length <= MAX_RESULT_BASE64 && BASE64.test(r.bodyBase64)
      ? r.bodyBase64
      : fail(`${path}.bodyBase64`, "must be base64 of a bounded body"),
    bytes: integer(r.bytes, `${path}.bytes`),
    sha256: string(r.sha256, `${path}.sha256`, 64, HEX64),
  };
}

const DIGEST_FIELDS = [
  "purchasePermit",
  "authorizationRequest",
  "operation",
  "authorityDecision",
  "outboundRequest",
  "paymentRequirement",
  "paymentAttempt",
  "settlement",
  "result",
] as const;

function manifest(value: unknown, path: string, version: 1 | 2): SignedEvidenceManifest {
  const r = object(value, path, [
    "version",
    "domain",
    "authority",
    "issuedAt",
    "settlementProfile",
    "grantId",
    "invocationId",
    "purchaseState",
    "decision",
    "reasonCodes",
    "digests",
    "signature",
  ]);
  const d = object(r.digests, `${path}.digests`, version === 2 ? [...DIGEST_FIELDS, "serviceAuthorization", "serviceAcknowledgement"] : DIGEST_FIELDS);
  const hex = (v: unknown, p: string) => string(v, p, 64, HEX64);
  const digests: EvidenceDigestsV2 = {
    purchasePermit: hex(d.purchasePermit, `${path}.digests.purchasePermit`),
    authorizationRequest: hex(d.authorizationRequest, `${path}.digests.authorizationRequest`),
    operation: hex(d.operation, `${path}.digests.operation`),
    authorityDecision: nullable(d.authorityDecision, (v) => hex(v, `${path}.digests.authorityDecision`)),
    outboundRequest: nullable(d.outboundRequest, (v) => hex(v, `${path}.digests.outboundRequest`)),
    paymentRequirement: nullable(d.paymentRequirement, (v) => hex(v, `${path}.digests.paymentRequirement`)),
    paymentAttempt: nullable(d.paymentAttempt, (v) => hex(v, `${path}.digests.paymentAttempt`)),
    settlement: nullable(d.settlement, (v) => hex(v, `${path}.digests.settlement`)),
    result: nullable(d.result, (v) => hex(v, `${path}.digests.result`)),
    serviceAuthorization: version === 2 ? nullable(d.serviceAuthorization, (v) => hex(v, `${path}.digests.serviceAuthorization`)) : null,
    serviceAcknowledgement: version === 2 ? nullable(d.serviceAcknowledgement, (v) => hex(v, `${path}.digests.serviceAcknowledgement`)) : null,
  };

  if (typeof r.purchaseState !== "string" || !(PURCHASE_STATES as readonly string[]).includes(r.purchaseState)) {
    fail(`${path}.purchaseState`, `must be one of ${PURCHASE_STATES.join(", ")}`);
  }

  const common = {
    domain: literal(r.domain, EVIDENCE_MANIFEST_DOMAIN, `${path}.domain`),
    authority: string(r.authority, `${path}.authority`, 64, BASE58),
    issuedAt: integer(r.issuedAt, `${path}.issuedAt`, 1),
    settlementProfile: string(r.settlementProfile, `${path}.settlementProfile`, 64),
    grantId: string(r.grantId, `${path}.grantId`, 128),
    invocationId: string(r.invocationId, `${path}.invocationId`, 128),
    purchaseState: r.purchaseState as PurchaseState,
    decision: decision(r.decision, `${path}.decision`),
    reasonCodes: reasonCodes(r.reasonCodes, `${path}.reasonCodes`),
    signature: signature(r.signature, `${path}.signature`),
  };

  if (version === 2) {
    return { ...common, version: literal(r.version, EVIDENCE_MANIFEST_VERSION_2, `${path}.version`), digests };
  }

  const { serviceAuthorization: _a, serviceAcknowledgement: _b, ...v1Digests } = digests;
  return { ...common, version: literal(r.version, EVIDENCE_MANIFEST_VERSION, `${path}.version`), digests: v1Digests };
}

export function parseServiceAuthorization(value: unknown, path: string): SignedServiceAuthorizationV1 {
  const r = object(value, path, ["version", "domain", "authority", "invocationId", "grantId", "request", "operationDigest", "payment", "issuedAt", "expiresAt", "signature"]);
  const q = object(r.request, `${path}.request`, ["method", "url", "contentType", "requestSha256"]);
  const pay = object(r.payment, `${path}.payment`, ["network", "asset", "payTo", "amountAtomic"]);
  return {
    version: literal(r.version, 1, `${path}.version`),
    domain: literal(r.domain, "virtual-haibin/service-authorization", `${path}.domain`),
    authority: string(r.authority, `${path}.authority`, 64, BASE58),
    invocationId: string(r.invocationId, `${path}.invocationId`, 128),
    grantId: string(r.grantId, `${path}.grantId`, 128),
    request: {
      method: literal(q.method, "POST", `${path}.request.method`),
      url: string(q.url, `${path}.request.url`, MAX_URL),
      contentType: literal(q.contentType, "application/json", `${path}.request.contentType`),
      requestSha256: string(q.requestSha256, `${path}.request.requestSha256`, 64, HEX64),
    },
    operationDigest: string(r.operationDigest, `${path}.operationDigest`, 64, HEX64),
    payment: {
      network: string(pay.network, `${path}.payment.network`, 128),
      asset: string(pay.asset, `${path}.payment.asset`, 64),
      payTo: string(pay.payTo, `${path}.payment.payTo`, 64),
      amountAtomic: string(pay.amountAtomic, `${path}.payment.amountAtomic`, 20, ATOMIC),
    },
    issuedAt: integer(r.issuedAt, `${path}.issuedAt`, 1),
    expiresAt: integer(r.expiresAt, `${path}.expiresAt`, 1),
    signature: signature(r.signature, `${path}.signature`),
  };
}

export function parseServiceAcknowledgement(value: unknown, path: string): SignedServiceAcknowledgementV1 {
  const r = object(value, path, ["version", "domain", "service", "invocationId", "authorizationDigest", "requestSha256", "received", "payment", "result", "fulfilledAt", "signature"]);
  const rec = object(r.received, `${path}.received`, ["method", "resource", "operation", "datasetId"]);
  const pay = object(r.payment, `${path}.payment`, ["transaction", "asset", "payTo", "amountAtomic"]);
  const res = object(r.result, `${path}.result`, ["httpStatus", "contentType", "sha256", "bytes"]);
  return {
    version: literal(r.version, 1, `${path}.version`),
    domain: literal(r.domain, "virtual-haibin/service-acknowledgement", `${path}.domain`),
    service: string(r.service, `${path}.service`, 64, BASE58),
    invocationId: string(r.invocationId, `${path}.invocationId`, 128),
    authorizationDigest: string(r.authorizationDigest, `${path}.authorizationDigest`, 64, HEX64),
    requestSha256: string(r.requestSha256, `${path}.requestSha256`, 64, HEX64),
    received: {
      method: string(rec.method, `${path}.received.method`, 16),
      resource: string(rec.resource, `${path}.received.resource`, 256),
      operation: string(rec.operation, `${path}.received.operation`, 64),
      datasetId: string(rec.datasetId, `${path}.received.datasetId`, 128),
    },
    payment: {
      transaction: nullable(pay.transaction, (v) => string(v, `${path}.payment.transaction`, 128, BASE58)),
      asset: string(pay.asset, `${path}.payment.asset`, 64),
      payTo: string(pay.payTo, `${path}.payment.payTo`, 64),
      amountAtomic: string(pay.amountAtomic, `${path}.payment.amountAtomic`, 20, ATOMIC),
    },
    result: {
      httpStatus: integer(res.httpStatus, `${path}.result.httpStatus`, 100),
      contentType: literal(res.contentType, "application/json", `${path}.result.contentType`),
      sha256: string(res.sha256, `${path}.result.sha256`, 64, HEX64),
      bytes: integer(res.bytes, `${path}.result.bytes`),
    },
    fulfilledAt: integer(r.fulfilledAt, `${path}.fulfilledAt`, 1),
    signature: signature(r.signature, `${path}.signature`),
  };
}

/** Parses an untrusted bundle (JSON text or already-parsed value), v1 or v2. Throws EvidenceFormatError only. */
export function parseEvidenceBundle(input: unknown): EvidenceBundle {
  let value = input;

  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_BUNDLE_BYTES) {
      fail("$", `bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    }

    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail("$", "is not valid JSON");
    }
  }

  // Version/domain first: an unknown format is rejected before anything else.
  const peek = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json).version : undefined;
  const version = peek === EVIDENCE_BUNDLE_VERSION_2 ? 2 : peek === EVIDENCE_BUNDLE_VERSION ? 1 : fail("$.version", "must be 1 or 2");
  const v1Fields = [
    "version",
    "domain",
    "environment",
    "identifiers",
    "purchasePermit",
    "authorizationRequest",
    "authorityDecision",
    "outboundRequest",
    "paymentRequirement",
    "paymentAttempt",
    "settlement",
    "result",
    "manifest",
  ];
  const r = object(value, "$", version === 2 ? [...v1Fields, "serviceAuthorization", "serviceAcknowledgement"] : v1Fields);
  const domain = literal(r.domain, EVIDENCE_BUNDLE_DOMAIN, "$.domain");
  const environment = object(r.environment, "$.environment", ["settlementProfile"]);
  const identifiers = object(r.identifiers, "$.identifiers", ["grantId", "invocationId"]);

  const common = {
    domain,
    environment: { settlementProfile: string(environment.settlementProfile, "$.environment.settlementProfile", 64) },
    identifiers: {
      grantId: string(identifiers.grantId, "$.identifiers.grantId", 128),
      invocationId: string(identifiers.invocationId, "$.identifiers.invocationId", 128),
    },
    purchasePermit: permit(r.purchasePermit, "$.purchasePermit"),
    authorizationRequest: authorizationRequest(r.authorizationRequest, "$.authorizationRequest"),
    authorityDecision: nullable(r.authorityDecision, (v) => receipt(v, "$.authorityDecision")),
    outboundRequest: nullable(r.outboundRequest, (v) => outboundRequest(v, "$.outboundRequest")),
    paymentRequirement: nullable(r.paymentRequirement, (v) => paymentRequirement(v, "$.paymentRequirement")),
    paymentAttempt: nullable(r.paymentAttempt, (v) => paymentAttempt(v, "$.paymentAttempt")),
    settlement: nullable(r.settlement, (v) => settlement(v, "$.settlement")),
    result: nullable(r.result, (v) => result(v, "$.result")),
  };

  const parsedManifest = manifest(r.manifest, "$.manifest", version);

  if (version === 2 && parsedManifest.version === 2) {
    return {
      ...common,
      version: 2,
      serviceAuthorization: nullable(r.serviceAuthorization, (v) => parseServiceAuthorization(v, "$.serviceAuthorization")),
      serviceAcknowledgement: nullable(r.serviceAcknowledgement, (v) => parseServiceAcknowledgement(v, "$.serviceAcknowledgement")),
      manifest: parsedManifest,
    };
  }

  if (version === 1 && parsedManifest.version === 1) {
    return { ...common, version: 1, manifest: parsedManifest };
  }

  return fail("$.manifest.version", "must match the bundle version");
}
