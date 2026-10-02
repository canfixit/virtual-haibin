import type { AgentRequestSignature, AuthorizationRequestV1, AuthorizationRequestV2, SignedPurchasePermitV2 } from "@virtual-haibin/mandate";
import type { ConfirmedSettlement, PaidResult, PaymentAttempt, PaymentRequirement } from "@virtual-haibin/payments";
import type { SignedAuthorizationReceipt } from "../receipt.js";

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

  /**
   * Records the payment attempt (payer signature, blockhash, expiry) on a
   * RESERVED invocation. Must succeed *before* the credential is transmitted,
   * so a crash afterwards can still be reconciled.
   */
  recordPaymentAttempt(invocationId: string, attempt: PaymentAttempt): Promise<void>;

  /** RESERVED -> CONFIRMED; moves the amount from reserved to consumed and stores settlement evidence. */
  confirm(invocationId: string, payment: ConfirmPayment): Promise<InvocationRecord>;

  /** RESERVED -> FAILED; releases the reservation. Only for payments known never to have been submitted. */
  fail(invocationId: string, reason: string): Promise<void>;

  /** RESERVED -> RECONCILIATION_REQUIRED; the reservation stays held. */
  markReconciliationRequired(invocationId: string, reason: string): Promise<void>;

  /**
   * RECONCILIATION_REQUIRED -> CONFIRMED (reserved becomes consumed) or
   * -> FAILED (reservation released), based on an on-chain lookup.
   */
  resolveReconciliation(invocationId: string, outcome: ReconciliationOutcome): Promise<InvocationRecord>;

  listReconciliationRequired(): Promise<InvocationRecord[]>;

  /** Stores the signed receipt for a DENIED or CONFIRMED invocation (first receipt wins). */
  attachReceipt(invocationId: string, receipt: SignedAuthorizationReceipt): Promise<SignedAuthorizationReceipt>;

  getInvocation(invocationId: string): Promise<InvocationRecord | null>;

  getGrant(issuer: string, grantId: string): Promise<GrantRecord | null>;

  /**
   * Startup recovery for invocations left RESERVED by an interrupted process,
   * decided atomically per row:
   * - a payment attempt was recorded -> the credential may have been
   *   transmitted -> RECONCILIATION_REQUIRED (reservation kept);
   * - no attempt recorded -> by the PaymentProvider ordering contract the
   *   credential was never transmitted -> FAILED (reservation released).
   * Because recordPaymentAttempt only succeeds on RESERVED rows, a process
   * still in flight cannot transmit after its row was released here.
   */
  recoverInterruptedInvocations(reason: string): Promise<RecoveryResult>;

  close(): Promise<void>;
}

/**
 * A request as stored with its invocation. New invocations always store an
 * AuthorizationRequest v2; v1 rows exist only from before operation binding
 * (Phase 4.5) and are still readable for replay/reconciliation.
 */
export type StoredAuthorizationRequest = AuthorizationRequestV1 | AuthorizationRequestV2;

/**
 * The signed artifacts behind an invocation, kept verbatim for portable
 * evidence: the human's signed permit and the agent's request signature.
 */
export type StoredAuthorizationEvidence = {
  permit: SignedPurchasePermitV2;
  agentSignature: AgentRequestSignature;
};

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
  /** The authenticated request, stored so receipts and the outbound request can be (re)built from durable state. */
  request: AuthorizationRequestV2;
  amountAtomic: string;
  decidedAt: number;
  /** The validated payment requirement from the service's 402 challenge, if one was obtained. */
  paymentRequirement: PaymentRequirement | null;
  /** Signed permit + agent signature, kept for evidence export (Phase 5+). */
  authorization?: StoredAuthorizationEvidence;
};

export type ConfirmPayment = {
  transactionId: string;
  settledAt: number;
  settlement?: ConfirmedSettlement;
  result?: PaidResult | null;
};

export type ReconciliationOutcome =
  | { kind: "confirmed"; settlement: ConfirmedSettlement }
  | { kind: "failed"; reason: string };

export type RecoveryResult = {
  reconciliationRequired: string[];
  releasedNeverSubmitted: string[];
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
  request: StoredAuthorizationRequest;
  amountAtomic: string;
  state: InvocationState;
  reasonCodes: string[];
  paymentTransactionId: string | null;
  paymentRequirement: PaymentRequirement | null;
  paymentAttempt: PaymentAttempt | null;
  settlement: ConfirmedSettlement | null;
  result: PaidResult | null;
  receipt: SignedAuthorizationReceipt | null;
  /** NULL for invocations recorded before evidence capture (schema < v3). */
  authorization: StoredAuthorizationEvidence | null;
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
  constructor(invocationId: string, expected: InvocationState | string, action: string) {
    super(`Invocation ${invocationId} is not ${expected}; cannot ${action}.`);
    this.name = "InvalidStateTransitionError";
  }
}
