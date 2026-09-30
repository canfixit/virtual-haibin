export * from "./domain.js";
export * from "./types.js";
export { canonicalizeUnsignedPurchasePermit } from "./canonical.js";
export { validateUnsignedPurchasePermit } from "./validate.js";
export { signPurchasePermit, verifyPurchasePermit } from "./crypto.js";

/**
 * @deprecated Legacy scaffold mandate, kept only so the existing demo agent
 * keeps compiling until the authority service replaces it (Phase 2). It is
 * unsigned and uses floating-point money; do not use it for new code. Use
 * SignedPurchasePermitV1 instead.
 */
export type SpendingLimit = {
  token: string;
  maxPerTransaction: number;
  maxTotal: number;
};

/** @deprecated Legacy scaffold mandate; see SpendingLimit. Use SignedPurchasePermitV1. */
export type Mandate = {
  id: string;
  issuer: string;
  agent: string;
  capabilities: string[];
  spending: SpendingLimit;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
};
