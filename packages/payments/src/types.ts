/**
 * Payment-rail abstraction owned by the authority. The authority decides
 * *whether* a payment may happen (permit, agent identity, budget, replay);
 * a PaymentProvider only performs the protocol interaction it is told to.
 *
 * All amounts are canonical non-negative integer strings in the asset's base
 * units. No provider converts decimals or display prices.
 */

import type { PaidRequest } from "./paid-request.js";

/** A paid HTTP resource from the authority's trusted registry (never agent/service supplied). */
export type PaidResource = {
  serviceId: string;
  capability: string;
  url: string;
  method: "POST";
};

/**
 * One payment option from a service's 402 challenge, normalized. Values are
 * copied verbatim from the (untrusted) challenge; validating them against the
 * settlement profile and PurchasePermit is the authority's job.
 */
export type PaymentRequirement = {
  protocol: "x402";
  x402Version: number;
  /** Position in the challenge's `accepts[]`, used to build the credential for exactly this entry. */
  acceptsIndex: number;
  scheme: string;
  /** Network identifier exactly as advertised (CAIP-2 for x402 v2). */
  network: string;
  /** Token mint address exactly as advertised. */
  asset: string;
  payTo: string;
  amountAtomic: string;
  feePayer: string | null;
  maxTimeoutSeconds: number | null;
  /** `resource.url` from the challenge envelope. */
  resourceUrl: string | null;
};

export type ChallengeRejectionCode =
  | "CHALLENGE_NOT_PAYMENT_REQUIRED"
  | "CHALLENGE_REDIRECT"
  | "CHALLENGE_MALFORMED"
  | "UNSUPPORTED_PAYMENT_PROTOCOL";

export type PaymentChallenge = {
  kind: "challenge";
  requirements: PaymentRequirement[];
  /** Digest of the exact PaidRequest that produced this challenge; execute() pays only for that request. */
  requestSha256: string;
  /** Provider-private decoded challenge, needed to build the credential. Never persisted or logged. */
  raw: unknown;
};

export type ChallengeResult =
  | PaymentChallenge
  | { kind: "rejected"; reasonCode: ChallengeRejectionCode; message: string };

/**
 * Everything needed to find this payment on-chain later, recorded durably
 * *before* the credential leaves the authority.
 */
export type PaymentAttempt = {
  protocol: "x402";
  scheme: string;
  settlementProfile: string;
  network: string;
  payer: string;
  /** The payer's own signature over the transfer (base58); the facilitator's tx id is unknown until settlement. */
  payerSignature: string;
  feePayer: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  /** Authority-fetched blockhash the transfer is bound to, and its expiry height. */
  blockhash: string;
  lastValidBlockHeight: string;
  resourceUrl: string;
  /** Digest of the exact HTTP request (method, URL, body) this payment pays for. */
  requestSha256: string;
  /**
   * The exact signed wire transaction (base64) as transmitted, so evidence
   * can show offline that the payer signed exactly this transfer. Absent on
   * attempts recorded before Phase 5.
   */
  transactionBase64?: string;
  preparedAt: number;
};

export type ConfirmedSettlement = {
  transactionId: string;
  slot: string | null;
  /** Transaction id the facilitator reported, if any (untrusted; the on-chain lookup is authoritative). */
  facilitatorReportedTransaction: string | null;
  confirmedAt: number;
};

export type PaidResult = {
  httpStatus: number;
  /** Parsed JSON body when it is JSON and within the size limit, else null. */
  json: unknown;
  /** SHA-256 (hex) of the exact response body bytes. */
  sha256: string;
  bytes: number;
  /** The exact response body (base64) when within the size limit; lets evidence re-hash it. */
  bodyBase64?: string;
};

export type PaymentExecution = {
  attempt: PaymentAttempt;
  settlement: ConfirmedSettlement;
  result: PaidResult;
};

export type SettlementLookup =
  | { status: "confirmed"; settlement: ConfirmedSettlement }
  | { status: "failed_onchain"; transactionId: string; error: string }
  | { status: "expired"; currentBlockHeight: string }
  | { status: "pending"; currentBlockHeight: string | null }
  | { status: "inconclusive"; detail: string };

export type ExecuteInput = {
  /** Must be the same request (same digest) the challenge was fetched with. */
  request: PaidRequest;
  challenge: PaymentChallenge;
  requirement: PaymentRequirement;
  /** Correlation id sent to the service (the invocationId). */
  reference: string;
  /** Called after the credential is built and checked, before it is transmitted. Must persist the attempt. */
  beforeSubmit: (attempt: PaymentAttempt) => Promise<void>;
};

export interface PaymentProvider {
  /** Settlement profile this provider is pinned to. */
  readonly settlementProfile: string;
  /** Public address of the payment wallet (never the key). */
  readonly payerAddress: string;

  /** Sends `request` unpaid; returns the parsed challenge bound to the request digest. Signs nothing. */
  fetchChallenge(request: PaidRequest, context: { reference: string }): Promise<ChallengeResult>;

  /**
   * Builds, checks and transmits the payment credential for exactly
   * `requirement`, attached to exactly `request`, then confirms settlement
   * independently. Refuses (PaymentNotSubmittedError, nothing transmitted)
   * if `request` is not the request the challenge was fetched for.
   *
   * ORDERING CONTRACT (relied on by crash recovery): the credential must not
   * be transmitted, and no transaction bytes may leave the provider, until
   * `beforeSubmit` has resolved. If `beforeSubmit` rejects, the provider must
   * throw PaymentNotSubmittedError without transmitting. Consequently an
   * invocation with no recorded attempt was provably never submitted.
   *
   * @throws PaymentNotSubmittedError when the credential provably never left.
   * @throws PaymentOutcomeUnknownError for anything after transmission.
   */
  execute(input: ExecuteInput): Promise<PaymentExecution>;

  /** Read-only on-chain lookup for reconciliation. Never submits anything. */
  lookupSettlement(attempt: PaymentAttempt): Promise<SettlementLookup>;
}

/**
 * Thrown only when it is certain no credential/payment was transmitted (e.g.
 * failure while building or checking the credential). The authority may then
 * release the reservation. Anything later must be PaymentOutcomeUnknownError.
 */
export class PaymentNotSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentNotSubmittedError";
  }
}

/**
 * The credential may have been transmitted and the payment may or may not
 * settle (timeout, connection reset, non-200, missing/unverifiable
 * settlement). Never a reason to pay again; the authority must reconcile.
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly attempt: PaymentAttempt,
  ) {
    super(message);
    this.name = "PaymentOutcomeUnknownError";
  }
}

/** The paid service could not be reached for its challenge (transient; nothing was signed). */
export class PaidServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidServiceUnavailableError";
  }
}
