import { isAddress } from "@solana/addresses";
import { PURCHASE_PERMIT_DOMAIN, PURCHASE_PERMIT_VERSION, PURCHASE_PERMIT_VERSION_2, SUPPORTED_NETWORKS } from "./domain.js";
import type { SupportedNetwork } from "./domain.js";
import { validateExactOperation } from "./operation.js";
import type {
  PermitReasonCode,
  PermitValidationFailure,
  PermitValidationResult,
  UnsignedPurchasePermitV1,
  UnsignedPurchasePermitV2,
} from "./types.js";

const GRANT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Canonical non-negative decimal integer string; no leading zeros, no sign, no decimal point. */
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

/** SPL token amounts are u64; reject anything that could not fit on-chain. */
const MAX_ATOMIC_AMOUNT = 18446744073709551615n;

function fail(reasonCode: PermitReasonCode, message: string): PermitValidationFailure {
  return { valid: false, reasonCode, message };
}

/** The fields PurchasePermit v1 and v2 share, with identical meaning and validation. */
type SharedPermitFields = Omit<UnsignedPurchasePermitV1, "version">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Valid base58-encoded Solana address (decodes to exactly 32 bytes). Uses
 * @solana/addresses' isAddress, which is also the check Solana Kit itself
 * uses everywhere an address is accepted from untrusted input.
 */
function isBase58PublicKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAddress(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCanonicalAtomicAmount(value: unknown): value is string {
  return typeof value === "string" && ATOMIC_AMOUNT_PATTERN.test(value);
}

/**
 * Validates the unsigned business fields of a purchase permit candidate.
 * Does not touch signature bytes -- see verifyPurchasePermit in crypto.ts for
 * the full cryptographic check. Never spreads the caller-supplied candidate
 * into the returned permit: every field is copied explicitly so unknown/
 * extra input properties can never ride along into the signed payload.
 */
export function validateUnsignedPurchasePermit(candidate: unknown): PermitValidationResult {
  if (!isPlainObject(candidate)) {
    return fail("INVALID_SCHEMA", "Purchase permit must be a JSON object.");
  }

  if (candidate.version !== PURCHASE_PERMIT_VERSION) {
    return fail("UNSUPPORTED_VERSION", `Unsupported purchase permit version: ${JSON.stringify(candidate.version)}.`);
  }

  const shared = validateSharedFields(candidate);

  if ("valid" in shared) {
    return shared;
  }

  return { valid: true, permit: { version: PURCHASE_PERMIT_VERSION, ...shared } };
}

/**
 * Validates a PurchasePermit v2 candidate: every v1 field with identical
 * rules, plus a strictly validated `operation`. Like v1, unknown top-level
 * properties are never copied (so they are neither signed nor read); unknown
 * properties *inside* `operation` are rejected, because that object carries
 * the business arguments.
 */
export function validateUnsignedPurchasePermitV2(candidate: unknown): PermitValidationResult<UnsignedPurchasePermitV2> {
  if (!isPlainObject(candidate)) {
    return fail("INVALID_SCHEMA", "Purchase permit must be a JSON object.");
  }

  if (candidate.version !== PURCHASE_PERMIT_VERSION_2) {
    return fail("UNSUPPORTED_VERSION", `Unsupported purchase permit version: ${JSON.stringify(candidate.version)}.`);
  }

  const shared = validateSharedFields(candidate);

  if ("valid" in shared) {
    return shared;
  }

  const operation = validateExactOperation(candidate.operation);

  if (!operation.valid) {
    return fail("INVALID_OPERATION", operation.message);
  }

  return { valid: true, permit: { version: PURCHASE_PERMIT_VERSION_2, ...shared, operation: operation.operation } };
}

function validateSharedFields(candidate: Record<string, unknown>): SharedPermitFields | PermitValidationFailure {
  if (candidate.domain !== PURCHASE_PERMIT_DOMAIN) {
    return fail("INVALID_DOMAIN", "Purchase permit domain does not match the expected Virtual Haibin domain.");
  }

  if (typeof candidate.grantId !== "string" || !GRANT_ID_PATTERN.test(candidate.grantId)) {
    return fail("INVALID_GRANT_ID", "grantId must be a non-empty identifier.");
  }

  if (!isBase58PublicKey(candidate.issuer)) {
    return fail("INVALID_ISSUER", "issuer must be a valid base58-encoded Ed25519 public key.");
  }

  if (!isBase58PublicKey(candidate.authorizedAgent)) {
    return fail("INVALID_AGENT", "authorizedAgent must be a valid base58-encoded Ed25519 public key.");
  }

  if (typeof candidate.service !== "string" || !SERVICE_PATTERN.test(candidate.service)) {
    return fail("INVALID_SERVICE", "service must be a non-empty identifier.");
  }

  if (typeof candidate.capability !== "string" || !CAPABILITY_PATTERN.test(candidate.capability)) {
    return fail("INVALID_CAPABILITY", "capability must be a non-empty identifier.");
  }

  if (
    typeof candidate.network !== "string" ||
    !SUPPORTED_NETWORKS.includes(candidate.network as SupportedNetwork)
  ) {
    return fail("INVALID_NETWORK", `network must be one of: ${SUPPORTED_NETWORKS.join(", ")}.`);
  }

  if (!isBase58PublicKey(candidate.mint)) {
    return fail("INVALID_MINT", "mint must be a valid base58-encoded token mint address.");
  }

  if (!isBase58PublicKey(candidate.recipient)) {
    return fail("INVALID_RECIPIENT", "recipient must be a valid base58-encoded Solana address.");
  }

  if (!isCanonicalAtomicAmount(candidate.maxPerCallAtomic)) {
    return fail("INVALID_AMOUNT", "maxPerCallAtomic must be a canonical non-negative integer string.");
  }

  if (!isCanonicalAtomicAmount(candidate.maxTotalAtomic)) {
    return fail("INVALID_AMOUNT", "maxTotalAtomic must be a canonical non-negative integer string.");
  }

  const maxPerCallAtomic = BigInt(candidate.maxPerCallAtomic);
  const maxTotalAtomic = BigInt(candidate.maxTotalAtomic);

  if (maxPerCallAtomic <= 0n || maxPerCallAtomic > MAX_ATOMIC_AMOUNT) {
    return fail("INVALID_AMOUNT", "maxPerCallAtomic must be a positive integer within u64 range.");
  }

  if (maxTotalAtomic <= 0n || maxTotalAtomic > MAX_ATOMIC_AMOUNT) {
    return fail("INVALID_AMOUNT", "maxTotalAtomic must be a positive integer within u64 range.");
  }

  if (maxPerCallAtomic > maxTotalAtomic) {
    return fail("INVALID_AMOUNT", "maxPerCallAtomic must not exceed maxTotalAtomic.");
  }

  if (!isSafeTimestamp(candidate.issuedAt)) {
    return fail("INVALID_TIME_RANGE", "issuedAt must be a positive safe-integer Unix millisecond timestamp.");
  }

  if (!isSafeTimestamp(candidate.expiresAt)) {
    return fail("INVALID_TIME_RANGE", "expiresAt must be a positive safe-integer Unix millisecond timestamp.");
  }

  if (candidate.expiresAt <= candidate.issuedAt) {
    return fail("INVALID_TIME_RANGE", "expiresAt must be strictly after issuedAt.");
  }

  if (candidate.subdelegation !== false) {
    return fail("INVALID_SUBDELEGATION", "subdelegation must be false in purchase permits v1 and v2.");
  }

  return {
    domain: PURCHASE_PERMIT_DOMAIN,
    grantId: candidate.grantId,
    issuer: candidate.issuer,
    authorizedAgent: candidate.authorizedAgent,
    service: candidate.service,
    capability: candidate.capability,
    network: candidate.network as SupportedNetwork,
    mint: candidate.mint,
    recipient: candidate.recipient,
    maxPerCallAtomic: candidate.maxPerCallAtomic,
    maxTotalAtomic: candidate.maxTotalAtomic,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    subdelegation: false,
  };
}
