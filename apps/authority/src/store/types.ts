import type { AuthorizationRequestV1 } from "@virtual-haibin/mandate";
import type { SignedAuthorizationReceiptV1 } from "../receipt.js";

/**
 * Durable authority state. This is the authoritative source of truth for
 * grant budgets and invocation state; the authority service holds none of
 * it in memory.
 *
 * Implementations must provide, for every method:
 * - atomicity: each call is one transaction; partial writes are never visible
 * - serializability for budget changes: two concurrent `reserve` calls on the
 *   same grant must never both observe the same pre-reservation total
 * - durability: a call that resolved is not lost on process/container restart
 *
 * Amounts are canonical non-negative decimal integer strings (u64 range);
 * implementations must not use floating point or silently truncate.
 */
export interface AuthorityStore {
  /**
   * Atomically: look up the invocation; pin/check the grant; evaluate the
   * budget with `evaluate` against the grant's committed (reserved +
   * consumed) total; then either reserve budget (RESERVED) or record a
   * denial (DENIED). Nothing is written when an existing invocation is
   * returned or on a grant conflict.
   *
   * `evaluate` must be pure and synchronous: it runs inside the transaction.
   */
  reserve(input: ReserveInput, evaluate: BudgetEvaluator): Promise<ReserveResult>;

  /** RESERVED -> CONFIRMED; moves the amount from reserved to consumed. */
  confirm(invocationId: string, payment: { transactionId: string; settledAt: number }): Promise<InvocationRecord>;

  /** RESERVED -> FAILED; releases the reservation. Only for payments known never to have been submitted. */
  fail(invocationId: string, reason: string): Promise<void>;

  /** RESERVED -> RECONCILIATION_REQUIRED; the reservation stays held. */
  markReconciliationRequired(invocationId: string, reason: string): Promise<void>;

  /** Stores the signed receipt for a DENIED or CONFIRMED invocation (first receipt wins). */
  attachReceipt(invocationId: string, receipt: SignedAuthorizationReceiptV1): Promise<SignedAuthorizationReceiptV1>;

  getInvocation(invocationId: string): Promise<InvocationRecord | null>;

  getGrant(issuer: string, grantId: string): Promise<GrantRecord | null>;

  /**
   * Startup recovery for a single authority process: any invocation still
   * RESERVED was interrupted mid-payment, so its outcome is unknown. Moves
   * them to RECONCILIATION_REQUIRED (never back to a payable state) and
   * returns their ids.
   */
  recoverInterruptedInvocations(reason: string): Promise<string[]>;

  close(): Promise<void>;
}

export type InvocationState = "RESERVED" | "DENIED" | "CONFIRMED" | "FAILED" | "RECONCILIATION_REQUIRED";

export type GrantTerms = {
  issuer: string;
  grantId: string;
  /** Digest of the permit that first used this grant; later permits must match it. */
  permitDigest: string;
  maxTotalAtomic: string;
};

export type ReserveInput = {
  invocationId: string;
  fingerprint: string;
  grant: GrantTerms;
  agent: string;
  /** The authenticated request, stored so receipts can be (re)built from durable state. */
  request: AuthorizationRequestV1;
  amountAtomic: string;
  decidedAt: number;
};

export type BudgetDecision = { allowed: true } | { allowed: false; reasonCodes: string[] };

/** Receives the grant's committed (reserved + consumed) atomic total. */
export type BudgetEvaluator = (committedAtomic: string) => BudgetDecision;

export type ReserveResult =
  | { kind: "existing"; invocation: InvocationRecord }
  | { kind: "grant_conflict"; grant: GrantRecord }
  | { kind: "reserved"; invocation: InvocationRecord }
  | { kind: "denied"; invocation: InvocationRecord };

export type InvocationRecord = {
  invocationId: string;
  fingerprint: string;
  issuer: string;
  grantId: string;
  agent: string;
  request: AuthorizationRequestV1;
  amountAtomic: string;
  state: InvocationState;
  reasonCodes: string[];
  paymentTransactionId: string | null;
  receipt: SignedAuthorizationReceiptV1 | null;
  stateReason: string | null;
  decidedAt: number;
  createdAt: number;
  updatedAt: number;
};

export type GrantRecord = GrantTerms & {
  reservedAtomic: string;
  consumedAtomic: string;
  createdAt: number;
  updatedAt: number;
};

/** A state transition was attempted from a state that does not allow it. */
export class InvalidStateTransitionError extends Error {
  constructor(invocationId: string, expected: InvocationState, action: string) {
    super(`Invocation ${invocationId} is not ${expected}; cannot ${action}.`);
    this.name = "InvalidStateTransitionError";
  }
}
