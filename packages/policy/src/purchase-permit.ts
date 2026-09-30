import type { SignedPurchasePermitV1 } from "@virtual-haibin/mandate";

export type PurchaseRequestV1 = {
  service: string;
  capability: string;
  network: string;
  mint: string;
  recipient: string;
  /** Integer atomic units, decimal string (no floating point). */
  amountAtomic: string;
  /**
   * Caller-supplied running total already spent under this grant.
   *
   * TRANSITIONAL: this is not authoritative. Durable, atomically-reserved
   * budget state lands in Phase 3 (see CLAUDE.md §13 / docs/mvp-plan.md
   * MVP-3); until then a caller can misreport this value, so an ALLOW
   * decision here must not be presented as proof of total-budget
   * enforcement.
   */
  alreadySpentAtomic: string;
  now?: number;
};

export type PurchasePermitReasonCode =
  | "PERMIT_EXPIRED"
  | "SERVICE_MISMATCH"
  | "CAPABILITY_MISMATCH"
  | "NETWORK_MISMATCH"
  | "MINT_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "INVALID_AMOUNT"
  | "PER_CALL_LIMIT_EXCEEDED"
  | "TOTAL_BUDGET_EXCEEDED";

export type PurchasePermitDecision = {
  allowed: boolean;
  reasons: string[];
  reasonCodes: PurchasePermitReasonCode[];
};

const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

function isCanonicalAtomicAmount(value: string): boolean {
  return ATOMIC_AMOUNT_PATTERN.test(value);
}

/**
 * Evaluates a purchase request against a signed purchase permit.
 *
 * Precondition: `permit` must already have passed
 * `verifyPurchasePermit` (from @virtual-haibin/mandate) -- this function
 * checks semantic/budget fields only and does not re-verify the
 * cryptographic signature.
 */
export function evaluatePurchasePermit(
  permit: SignedPurchasePermitV1,
  request: PurchaseRequestV1,
): PurchasePermitDecision {
  const now = request.now ?? Date.now();
  const reasons: string[] = [];
  const reasonCodes: PurchasePermitReasonCode[] = [];

  function deny(reasonCode: PurchasePermitReasonCode, message: string): void {
    reasons.push(message);
    reasonCodes.push(reasonCode);
  }

  if (now > permit.expiresAt) {
    deny("PERMIT_EXPIRED", "Purchase permit has expired.");
  }

  if (request.service !== permit.service) {
    deny("SERVICE_MISMATCH", `Service "${request.service}" is not authorized by this permit.`);
  }

  if (request.capability !== permit.capability) {
    deny("CAPABILITY_MISMATCH", `Capability "${request.capability}" is not authorized by this permit.`);
  }

  if (request.network !== permit.network) {
    deny("NETWORK_MISMATCH", `Network "${request.network}" is not authorized by this permit.`);
  }

  if (request.mint !== permit.mint) {
    deny("MINT_MISMATCH", `Mint "${request.mint}" is not authorized by this permit.`);
  }

  if (request.recipient !== permit.recipient) {
    deny("RECIPIENT_MISMATCH", `Recipient "${request.recipient}" is not authorized by this permit.`);
  }

  if (!isCanonicalAtomicAmount(request.amountAtomic) || !isCanonicalAtomicAmount(request.alreadySpentAtomic)) {
    deny("INVALID_AMOUNT", "Requested amount must be a canonical non-negative integer string.");
    return { allowed: false, reasons, reasonCodes };
  }

  const amountAtomic = BigInt(request.amountAtomic);

  if (amountAtomic <= 0n) {
    deny("INVALID_AMOUNT", "Requested amount must be positive.");
    return { allowed: false, reasons, reasonCodes };
  }

  const alreadySpentAtomic = BigInt(request.alreadySpentAtomic);
  const maxPerCallAtomic = BigInt(permit.maxPerCallAtomic);
  const maxTotalAtomic = BigInt(permit.maxTotalAtomic);

  if (amountAtomic > maxPerCallAtomic) {
    deny("PER_CALL_LIMIT_EXCEEDED", "Requested amount exceeds the per-call spending limit.");
  }

  if (alreadySpentAtomic + amountAtomic > maxTotalAtomic) {
    deny("TOTAL_BUDGET_EXCEEDED", "Requested amount exceeds the total delegated budget.");
  }

  return { allowed: reasonCodes.length === 0, reasons, reasonCodes };
}
