import type { PURCHASE_PERMIT_DOMAIN, PURCHASE_PERMIT_VERSION, PURCHASE_PERMIT_VERSION_2, SupportedNetwork } from "./domain.js";
import type { ExactOperationV1 } from "./operation.js";

/**
 * Stable machine-readable reason codes for permit validation/verification
 * failures. Keep this list narrow and specific; do not add a generic
 * catch-all beyond INVALID_SCHEMA.
 */
export type PermitReasonCode =
  | "INVALID_SCHEMA"
  | "UNSUPPORTED_VERSION"
  | "INVALID_DOMAIN"
  | "INVALID_GRANT_ID"
  | "INVALID_ISSUER"
  | "INVALID_AGENT"
  | "INVALID_SERVICE"
  | "INVALID_CAPABILITY"
  | "INVALID_NETWORK"
  | "INVALID_MINT"
  | "INVALID_RECIPIENT"
  | "INVALID_AMOUNT"
  | "INVALID_TIME_RANGE"
  | "INVALID_SUBDELEGATION"
  | "INVALID_OPERATION"
  | "INVALID_SIGNATURE";

/**
 * The narrow v1 purchase permit. Every field here is authority-relevant and
 * therefore covered by the signature (see canonical.ts) -- there is no
 * unsigned metadata on this type. Do not add fields without also confirming
 * they belong inside the signed payload.
 */
export type UnsignedPurchasePermitV1 = {
  version: typeof PURCHASE_PERMIT_VERSION;
  domain: typeof PURCHASE_PERMIT_DOMAIN;
  grantId: string;
  /** Base58 Ed25519 public key of the issuing human/organization. */
  issuer: string;
  /** Base58 Ed25519 public key of the agent authorized to use this permit. */
  authorizedAgent: string;
  service: string;
  capability: string;
  network: SupportedNetwork;
  /** Base58 SPL token mint address. Authoritative; never a display symbol. */
  mint: string;
  /** Base58 Solana address of the authorized payment recipient. */
  recipient: string;
  /** Integer atomic units, decimal string (no floating point). */
  maxPerCallAtomic: string;
  /** Integer atomic units, decimal string (no floating point). */
  maxTotalAtomic: string;
  /** Unix milliseconds. */
  issuedAt: number;
  /** Unix milliseconds. */
  expiresAt: number;
  /** Always false for v1; no subdelegation support yet. */
  subdelegation: false;
};

/**
 * PurchasePermit v2: every v1 field with unchanged meaning, plus the exact
 * business operation the human approved. A new version (not a mutated v1)
 * because `operation` narrows what the permit authorizes and must be signed.
 */
export type UnsignedPurchasePermitV2 = Omit<UnsignedPurchasePermitV1, "version"> & {
  version: typeof PURCHASE_PERMIT_VERSION_2;
  /** The exact operation (method, resource, action, dataset) the human approved. Signed. */
  operation: ExactOperationV1;
};

export type PermitSignature = {
  algorithm: "ed25519";
  /** Base58-encoded 64-byte Ed25519 detached signature. */
  signature: string;
};

export type SignedPurchasePermitV1 = UnsignedPurchasePermitV1 & {
  signature: PermitSignature;
};

export type SignedPurchasePermitV2 = UnsignedPurchasePermitV2 & {
  signature: PermitSignature;
};

export type PermitValidationSuccess<P = UnsignedPurchasePermitV1> = {
  valid: true;
  permit: P;
};

export type PermitValidationFailure = {
  valid: false;
  reasonCode: PermitReasonCode;
  message: string;
};

export type PermitValidationResult<P = UnsignedPurchasePermitV1> = PermitValidationSuccess<P> | PermitValidationFailure;

export type PermitVerificationSuccess<P = SignedPurchasePermitV1> = {
  verified: true;
  permit: P;
};

export type PermitVerificationFailure = {
  verified: false;
  reasonCode: PermitReasonCode;
  message: string;
};

export type PermitVerificationResult<P = SignedPurchasePermitV1> = PermitVerificationSuccess<P> | PermitVerificationFailure;
