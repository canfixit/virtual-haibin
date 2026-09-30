import type { PURCHASE_PERMIT_DOMAIN, PURCHASE_PERMIT_VERSION, SupportedNetwork } from "./domain.js";

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

export type PermitSignature = {
  algorithm: "ed25519";
  /** Base58-encoded 64-byte Ed25519 detached signature. */
  signature: string;
};

export type SignedPurchasePermitV1 = UnsignedPurchasePermitV1 & {
  signature: PermitSignature;
};

export type PermitValidationSuccess = {
  valid: true;
  permit: UnsignedPurchasePermitV1;
};

export type PermitValidationFailure = {
  valid: false;
  reasonCode: PermitReasonCode;
  message: string;
};

export type PermitValidationResult = PermitValidationSuccess | PermitValidationFailure;

export type PermitVerificationSuccess = {
  verified: true;
  permit: SignedPurchasePermitV1;
};

export type PermitVerificationFailure = {
  verified: false;
  reasonCode: PermitReasonCode;
  message: string;
};

export type PermitVerificationResult = PermitVerificationSuccess | PermitVerificationFailure;
