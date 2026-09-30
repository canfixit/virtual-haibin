import canonicalize from "canonicalize";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import {
  computePermitDigest,
  verifyAuthorizationRequestSignature,
  verifyPurchasePermit,
  type AuthorizationRequestV1,
  type SignedPurchasePermitV1,
} from "@virtual-haibin/mandate";
import {
  PaidServiceUnavailableError,
  PaymentNotSubmittedError,
  type PaidResource,
  type PaymentChallenge,
  type PaymentProvider,
  type PaymentRequirement,
  type SettlementProfile,
} from "@virtual-haibin/payments";
import { evaluatePurchasePermit } from "@virtual-haibin/policy";
import {
  AUTHORIZATION_RECEIPT_DOMAIN,
  AUTHORIZATION_RECEIPT_VERSION,
  signAuthorizationReceipt,
  type SignedAuthorizationReceiptV1,
} from "./receipt.js";
import { paidServiceKey, selectAndValidateChallenge, type PaidServiceRegistry } from "./payment-challenge.js";
import {
  InvalidStateTransitionError,
  type AuthorityStore,
  type BudgetDecision,
  type InvocationRecord,
  type RecoveryResult,
} from "./store/types.js";

export type AuthorizeRequestInput = {
  /** Untrusted; verified with verifyPurchasePermit. */
  permit: unknown;
  /** Structurally validated by the HTTP boundary; not yet authenticated. */
  authorizationRequest: AuthorizationRequestV1;
  /** Untrusted; verified against permit.authorizedAgent. */
  agentSignature: unknown;
};

export type AuthorizeResult = {
  receipt: SignedAuthorizationReceiptV1;
  /** True when this invocationId was already decided (or in flight) with the same fingerprint; no new payment. */
  replay: boolean;
  /** Unsigned payment evidence from durable state (challenge terms, attempt, settlement). */
  payment: PaymentEvidence | null;
  /** The paid service's JSON result, if captured (bounded; untrusted content). */
  result: unknown;
};

export type PaymentEvidence = {
  settlementProfile: string | null;
  protocol: string | null;
  scheme: string | null;
  challengeNetwork: string | null;
  asset: string | null;
  payTo: string | null;
  amountAtomic: string | null;
  resourceUrl: string | null;
  payer: string | null;
  payerSignature: string | null;
  blockhash: string | null;
  transactionId: string | null;
  slot: string | null;
  resultSha256: string | null;
};

export type ReconciliationReport = {
  invocationId: string;
  outcome: "confirmed" | "failed" | "still_pending" | "no_attempt_recorded" | "lookup_error" | "already_resolved";
  detail?: string;
};

export type GrantBudget = {
  maxTotalAtomic: string;
  reservedAtomic: string;
  consumedAtomic: string;
  remainingAtomic: string;
};

export type AuthorityLogEntry = { event: string } & Record<string, unknown>;

export type AuthorityServiceOptions = {
  authoritySigner: CryptoKeyPair;
  authorityAddress: string;
  /** This authority's audience identifier; requests addressed elsewhere are rejected. */
  audience: string;
  paymentProvider: PaymentProvider;
  /** Trusted paid-resource registry; the only URLs the authority will call. */
  paidServices: PaidServiceRegistry;
  /** Trusted settlement profiles keyed by PurchasePermit `network`. */
  settlementProfiles: ReadonlyMap<string, SettlementProfile>;
  /** Durable, authoritative budget and invocation state. */
  store: AuthorityStore;
  auditLog?: InMemoryAuditLog;
  /** Structured log sink. Receives identifiers and decisions only, never key material. */
  log?: (entry: AuthorityLogEntry) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Oldest accepted request signature age. Default 120 s. */
  maxRequestAgeMs?: number;
  /** Largest accepted clock skew into the future. Default 30 s. */
  maxFutureSkewMs?: number;
};

export type AuthorityReasonCode =
  | "PERMIT_INVALID"
  | "AGENT_SIGNATURE_MISSING"
  | "AGENT_SIGNATURE_INVALID"
  | "REQUEST_AUDIENCE_MISMATCH"
  | "REQUEST_GRANT_MISMATCH"
  | "REQUEST_PERMIT_DIGEST_MISMATCH"
  | "REQUEST_TIMESTAMP_OUT_OF_RANGE"
  | "INVOCATION_CONFLICT"
  | "INVOCATION_IN_PROGRESS"
  | "GRANT_PERMIT_CONFLICT"
  | "PAYMENT_NOT_SUBMITTED"
  | "PAID_SERVICE_UNAVAILABLE"
  | "RECONCILIATION_REQUIRED";

/** A request the authority refused before (or instead of) producing a decision receipt. */
export class AuthorityRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reasonCode: AuthorityReasonCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The caller could not be authenticated as the permit's authorized agent.
 * No invocation state is created or read for such a request, so a caller
 * holding only the transport bearer token cannot claim or probe
 * invocationIds.
 */
export class AgentAuthenticationError extends AuthorityRequestError {
  constructor(reasonCode: AuthorityReasonCode, message: string, details: Record<string, unknown> = {}) {
    super(401, reasonCode, message, details);
  }
}

/**
 * The invocationId was already used for a different request fingerprint.
 * Nothing is paid and no budget changes; the original receipt is not
 * returned for a payload it does not describe.
 */
export class InvocationConflictError extends AuthorityRequestError {
  constructor(readonly invocationId: string) {
    super(409, "INVOCATION_CONFLICT", `invocationId ${invocationId} was already used for a different request.`, {
      invocationId,
    });
  }
}

/**
 * The same request is RESERVED but not being processed by this process
 * (e.g. another authority process holds it). The caller should retry later;
 * nothing is paid by this call.
 */
export class InvocationInProgressError extends AuthorityRequestError {
  constructor(readonly invocationId: string) {
    super(409, "INVOCATION_IN_PROGRESS", `Invocation ${invocationId} is already being processed.`, { invocationId });
  }
}

/**
 * The grant (issuer + grantId) is already bound to a different permit.
 * Issuers must use a fresh grantId for new terms, so budgets of different
 * permits can never be mixed.
 */
export class GrantPermitConflictError extends AuthorityRequestError {
  constructor(grantId: string) {
    super(409, "GRANT_PERMIT_CONFLICT", `Grant ${grantId} is already bound to a different permit.`, { grantId });
  }
}

/**
 * The payment provider reported that the payment was definitely never
 * submitted. The reservation was released and the same request may be
 * retried with the same invocationId.
 */
export class PaymentNotSubmittedFailure extends AuthorityRequestError {
  constructor(readonly invocationId: string) {
    super(502, "PAYMENT_NOT_SUBMITTED", `Payment for invocation ${invocationId} was not submitted; it may be retried.`, {
      invocationId,
    });
  }
}

/**
 * The configured paid service could not be reached for its 402 challenge.
 * Nothing was reserved or signed; the same request may simply be retried.
 */
export class PaidServiceUnavailableFailure extends AuthorityRequestError {
  constructor(message: string) {
    super(502, "PAID_SERVICE_UNAVAILABLE", message);
  }
}

/**
 * Thrown when a payment for this invocation was attempted but its outcome is
 * unknown (the provider threw, the process crashed mid-payment, or the
 * result could not be recorded). Retrying must not pay again -- a timeout
 * is not permission to re-submit (CLAUDE.md security invariants 12/13). The
 * invocation stays blocked, and its budget stays reserved, in durable state
 * until it is reconciled.
 */
export class ReconciliationRequiredError extends AuthorityRequestError {
  constructor(readonly invocationId: string) {
    super(
      409,
      "RECONCILIATION_REQUIRED",
      `Payment outcome for invocation ${invocationId} is unknown; reconciliation is required before any retry.`,
      { invocationId },
    );
  }
}

type AuthenticatedRequest = {
  permit: SignedPurchasePermitV1;
  request: AuthorizationRequestV1;
  fingerprint: string;
};

function defaultLog(entry: AuthorityLogEntry): void {
  console.log(JSON.stringify({ component: "authority", ...entry }));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic identity of "what this invocation asks for": the exact
 * permit (by digest), the agent, and every payment-relevant field. The
 * signing timestamp and audience are deliberately excluded, so an honest
 * retry re-signed with a fresh timestamp is recognised as the same request.
 */
async function computeRequestFingerprint(permit: SignedPurchasePermitV1, request: AuthorizationRequestV1): Promise<string> {
  const canonicalJson = canonicalize({
    version: 1,
    permitDigest: request.permitDigest,
    grantId: permit.grantId,
    agent: permit.authorizedAgent,
    invocationId: request.invocationId,
    service: request.service,
    capability: request.capability,
    network: request.network,
    mint: request.mint,
    recipient: request.recipient,
    amountAtomic: request.amountAtomic,
  });

  if (canonicalJson === undefined) {
    throw new Error("Request fingerprint input cannot be canonicalized.");
  }

  return sha256Hex(new TextEncoder().encode(`virtual-haibin/invocation-fingerprint:v1\n${canonicalJson}`));
}

/**
 * Authenticates, decides and (on ALLOW) pays out purchase requests against
 * signed permits.
 *
 * All security-critical state -- grant budgets, reservations, invocation
 * ids/fingerprints/states and receipts -- lives in the injected
 * AuthorityStore, which is the source of truth and survives restarts. The
 * only in-process state is `#pending`, a non-authoritative map that lets
 * concurrent duplicates within this process wait for the first request's
 * outcome instead of receiving INVOCATION_IN_PROGRESS.
 */
export class AuthorityService {
  readonly #authoritySigner: CryptoKeyPair;
  readonly #authorityAddress: string;
  readonly #audience: string;
  readonly #paymentProvider: PaymentProvider;
  readonly #paidServices: PaidServiceRegistry;
  readonly #settlementProfiles: ReadonlyMap<string, SettlementProfile>;
  readonly #store: AuthorityStore;
  readonly #auditLog: InMemoryAuditLog;
  readonly #log: (entry: AuthorityLogEntry) => void;
  readonly #now: () => number;
  readonly #maxRequestAgeMs: number;
  readonly #maxFutureSkewMs: number;

  readonly #pending = new Map<string, { fingerprint: string; promise: Promise<AuthorizeResult> }>();
  #reconciliation: Promise<ReconciliationReport[]> | null = null;

  constructor(options: AuthorityServiceOptions) {
    this.#authoritySigner = options.authoritySigner;
    this.#authorityAddress = options.authorityAddress;
    this.#audience = options.audience;
    this.#paymentProvider = options.paymentProvider;
    this.#paidServices = options.paidServices;
    this.#settlementProfiles = options.settlementProfiles;
    this.#store = options.store;
    this.#auditLog = options.auditLog ?? new InMemoryAuditLog();
    this.#log = options.log ?? defaultLog;
    this.#now = options.now ?? Date.now;
    this.#maxRequestAgeMs = options.maxRequestAgeMs ?? 120_000;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 30_000;
  }

  get auditLog(): InMemoryAuditLog {
    return this.#auditLog;
  }

  /** Durable budget view for a grant, or null if the grant has never been used. */
  async getGrantBudget(issuer: string, grantId: string): Promise<GrantBudget | null> {
    const grant = await this.#store.getGrant(issuer, grantId);

    if (grant === null) {
      return null;
    }

    const committed = BigInt(grant.reservedAtomic) + BigInt(grant.consumedAtomic);
    return {
      maxTotalAtomic: grant.maxTotalAtomic,
      reservedAtomic: grant.reservedAtomic,
      consumedAtomic: grant.consumedAtomic,
      remainingAtomic: (BigInt(grant.maxTotalAtomic) - committed).toString(),
    };
  }

  /**
   * Startup recovery for invocations left RESERVED by a previous process:
   * with a recorded payment attempt they may have been paid, so they become
   * RECONCILIATION_REQUIRED and are never paid again automatically; without
   * one the credential was provably never transmitted (PaymentProvider
   * ordering contract), so the reservation is released.
   */
  async recoverInterruptedInvocations(): Promise<RecoveryResult> {
    const result = await this.#store.recoverInterruptedInvocations("authority restarted while payment was in progress");

    for (const invocationId of result.reconciliationRequired) {
      this.#log({ event: "authority.reconciliation_required", invocationId, cause: "interrupted_after_attempt_recorded" });
    }

    for (const invocationId of result.releasedNeverSubmitted) {
      this.#log({ event: "authority.released_never_submitted", invocationId, cause: "interrupted_before_attempt_recorded" });
    }

    return result;
  }

  async authorize(input: AuthorizeRequestInput): Promise<AuthorizeResult> {
    const authenticated = await this.#authenticate(input);
    const { invocationId } = authenticated.request;
    const { fingerprint } = authenticated;

    // From here to `set` there is no `await`: concurrent duplicates in this
    // process attach to the first request instead of racing it. Durable
    // uniqueness across processes/restarts is enforced by the store.
    const pending = this.#pending.get(invocationId);

    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        this.#log({ event: "authority.invocation_conflict", invocationId, grantId: authenticated.permit.grantId });
        throw new InvocationConflictError(invocationId);
      }

      const result = await pending.promise;
      this.#log({ event: "authority.replay", invocationId, grantId: result.receipt.grantId, decision: result.receipt.decision });
      return { ...result, replay: true };
    }

    const promise = this.#process(authenticated);
    this.#pending.set(invocationId, { fingerprint, promise });

    try {
      return await promise;
    } finally {
      this.#pending.delete(invocationId);
    }
  }

  /**
   * Proves the caller is the permit's authorized agent and that the signed
   * request is bound to this exact permit and this authority. A transport
   * bearer token is never treated as this proof.
   */
  async #authenticate(input: AuthorizeRequestInput): Promise<AuthenticatedRequest> {
    const request = input.authorizationRequest;
    const logContext = { invocationId: request.invocationId, grantId: request.grantId };

    const reject = (reasonCode: AuthorityReasonCode, message: string, details: Record<string, unknown> = {}): never => {
      this.#log({ event: "authority.authentication_failed", reasonCode, ...logContext, ...details });
      throw new AgentAuthenticationError(reasonCode, message, details);
    };

    if (input.agentSignature === undefined || input.agentSignature === null) {
      reject("AGENT_SIGNATURE_MISSING", "agentSignature is required.");
    }

    const verification = await verifyPurchasePermit(input.permit);

    if (!verification.verified) {
      return reject("PERMIT_INVALID", `Purchase permit is invalid: ${verification.message}`, {
        permitReasonCode: verification.reasonCode,
      });
    }

    const permit = verification.permit;

    // Verified against the permit's authorizedAgent: only the holder of that
    // identity key can produce this signature over these exact fields.
    const signatureValid = await verifyAuthorizationRequestSignature(request, input.agentSignature, permit.authorizedAgent);

    if (!signatureValid) {
      reject("AGENT_SIGNATURE_INVALID", "Agent signature does not verify against the permit's authorizedAgent.");
    }

    if (request.audience !== this.#audience) {
      reject("REQUEST_AUDIENCE_MISMATCH", "Authorization request is addressed to a different authority.");
    }

    if (request.grantId !== permit.grantId) {
      reject("REQUEST_GRANT_MISMATCH", "Authorization request grantId does not match the permit.");
    }

    if (request.permitDigest !== (await computePermitDigest(permit))) {
      reject("REQUEST_PERMIT_DIGEST_MISMATCH", "Authorization request was signed for a different permit.");
    }

    const now = this.#now();

    if (request.issuedAt < now - this.#maxRequestAgeMs || request.issuedAt > now + this.#maxFutureSkewMs) {
      reject("REQUEST_TIMESTAMP_OUT_OF_RANGE", "Authorization request timestamp is outside the accepted window.");
    }

    return { permit, request, fingerprint: await computeRequestFingerprint(permit, request) };
  }

  async #process({ permit, request, fingerprint }: AuthenticatedRequest): Promise<AuthorizeResult> {
    const { invocationId } = request;

    // Known invocation: replay/conflict/reconciliation straight from durable
    // state, without contacting the paid service again.
    const known = await this.#store.getInvocation(invocationId);

    if (known !== null && !(known.state === "FAILED" && known.fingerprint === fingerprint)) {
      return this.#resolveExisting(known, fingerprint);
    }

    const decidedAt = this.#now();
    const policy = (values: { mint: string; recipient: string; amountAtomic: string }, committedAtomic: string) =>
      evaluatePurchasePermit(permit, {
        service: request.service,
        capability: request.capability,
        network: request.network,
        mint: values.mint,
        recipient: values.recipient,
        amountAtomic: values.amountAtomic,
        alreadySpentAtomic: committedAtomic,
        now: decidedAt,
      });

    // 1. Is the *signed request itself* permitted (ignoring shared budget)?
    //    If not, deny without contacting the service at all.
    const requestCheck = policy({ mint: request.mint, recipient: request.recipient, amountAtomic: request.amountAtomic }, "0");
    let challenge: PaymentChallenge | null = null;
    let requirement: PaymentRequirement | null = null;
    let resource: PaidResource | null = null;
    const challengeCodes: string[] = [];

    if (requestCheck.allowed) {
      // 2. Obtain the real 402 challenge from the trusted registry URL.
      const profile = this.#settlementProfiles.get(permit.network);
      resource = this.#paidServices.get(paidServiceKey(request.service, request.capability)) ?? null;

      if (!profile || profile.name !== this.#paymentProvider.settlementProfile) {
        challengeCodes.push("SETTLEMENT_PROFILE_UNAVAILABLE");
      } else if (resource === null) {
        challengeCodes.push("PAID_SERVICE_NOT_CONFIGURED");
      } else {
        let result;

        try {
          result = await this.#paymentProvider.fetchChallenge(resource, { reference: invocationId });
        } catch (error) {
          if (error instanceof PaidServiceUnavailableError) {
            this.#log({ event: "authority.paid_service_unavailable", invocationId, error: error.message });
            throw new PaidServiceUnavailableFailure(error.message);
          }

          throw error;
        }

        const selection = selectAndValidateChallenge(result, {
          profile,
          resource,
          request,
          payerAddress: this.#paymentProvider.payerAddress,
        });

        challenge = result.kind === "challenge" ? result : null;
        requirement = selection.requirement;
        challengeCodes.push(...selection.reasonCodes);

        this.#log({
          event: "authority.challenge",
          invocationId,
          grantId: permit.grantId,
          protocol: requirement?.protocol ?? null,
          scheme: requirement?.scheme ?? null,
          network: requirement?.network ?? null,
          asset: requirement?.asset ?? null,
          payTo: requirement?.payTo ?? null,
          amountAtomic: requirement?.amountAtomic ?? null,
          reasonCodes: selection.reasonCodes,
        });
      }
    }

    // 3. One atomic decision against the durable budget: the signed request
    //    AND the real challenge terms must both be permitted.
    const evaluate = (committedAtomic: string): BudgetDecision => {
      const codes = new Set<string>(
        policy({ mint: request.mint, recipient: request.recipient, amountAtomic: request.amountAtomic }, committedAtomic).reasonCodes,
      );

      for (const code of challengeCodes) {
        codes.add(code);
      }

      if (requirement !== null) {
        for (const code of policy({ mint: requirement.asset, recipient: requirement.payTo, amountAtomic: requirement.amountAtomic }, committedAtomic).reasonCodes) {
          codes.add(code);
        }
      } else if (codes.size === 0) {
        codes.add("CHALLENGE_MALFORMED");
      }

      return codes.size === 0 ? { allowed: true } : { allowed: false, reasonCodes: [...codes] };
    };

    const result = await this.#store.reserve(
      {
        invocationId,
        fingerprint,
        grant: {
          issuer: permit.issuer,
          grantId: permit.grantId,
          permitDigest: request.permitDigest,
          maxTotalAtomic: permit.maxTotalAtomic,
        },
        agent: permit.authorizedAgent,
        request,
        amountAtomic: request.amountAtomic,
        decidedAt,
        paymentRequirement: requirement,
      },
      evaluate,
    );

    switch (result.kind) {
      case "grant_conflict":
        this.#log({ event: "authority.grant_conflict", invocationId, grantId: permit.grantId });
        throw new GrantPermitConflictError(permit.grantId);

      case "existing":
        return this.#resolveExisting(result.invocation, fingerprint);

      case "denied": {
        this.#auditDecision(permit, result.invocation);
        this.#log({
          event: "authority.denied",
          invocationId,
          grantId: permit.grantId,
          agent: permit.authorizedAgent,
          serviceId: request.service,
          decision: "DENY",
          reasonCodes: result.invocation.reasonCodes,
        });
        return this.#result(result.invocation, await this.#ensureReceipt(result.invocation), false);
      }

      case "reserved": {
        this.#auditDecision(permit, result.invocation);

        if (challenge === null || requirement === null || resource === null) {
          // Unreachable: an allowed decision requires a valid requirement.
          await this.#store.fail(invocationId, "internal: reserved without a payment requirement");
          throw new Error("Reserved an invocation without a payment requirement.");
        }

        const confirmed = await this.#pay(permit, result.invocation, resource, challenge, requirement);
        return this.#result(confirmed, await this.#ensureReceipt(confirmed), false);
      }
    }
  }

  async #resolveExisting(invocation: InvocationRecord, fingerprint: string): Promise<AuthorizeResult> {
    const { invocationId } = invocation;

    if (invocation.fingerprint !== fingerprint) {
      this.#log({ event: "authority.invocation_conflict", invocationId, grantId: invocation.grantId });
      throw new InvocationConflictError(invocationId);
    }

    switch (invocation.state) {
      case "DENIED":
      case "CONFIRMED": {
        const receipt = await this.#ensureReceipt(invocation);
        this.#log({ event: "authority.replay", invocationId, grantId: invocation.grantId, decision: receipt.decision });
        return this.#result(invocation, receipt, true);
      }

      case "RECONCILIATION_REQUIRED":
        this.#log({ event: "authority.reconciliation_blocked", invocationId });
        throw new ReconciliationRequiredError(invocationId);

      case "RESERVED":
        this.#log({ event: "authority.in_progress", invocationId });
        throw new InvocationInProgressError(invocationId);

      case "FAILED":
        // A FAILED invocation with the same fingerprint is retried by
        // #process; with a different one it is a conflict (handled above).
        throw new Error(`Unexpected FAILED invocation ${invocationId}.`);
    }
  }

  async #pay(
    permit: SignedPurchasePermitV1,
    invocation: InvocationRecord,
    resource: PaidResource,
    challenge: PaymentChallenge,
    requirement: PaymentRequirement,
  ): Promise<InvocationRecord> {
    const { invocationId } = invocation;
    const budget = await this.getGrantBudget(permit.issuer, permit.grantId);

    this.#log({
      event: "authority.reserved",
      invocationId,
      grantId: permit.grantId,
      agent: permit.authorizedAgent,
      serviceId: permit.service,
      decision: "ALLOW",
      protocol: requirement.protocol,
      scheme: requirement.scheme,
      network: requirement.network,
      recipient: requirement.payTo,
      reservedAtomic: invocation.amountAtomic,
      remainingAtomic: budget?.remainingAtomic,
    });

    let execution;

    try {
      execution = await this.#paymentProvider.execute({
        resource,
        challenge,
        requirement,
        reference: invocationId,
        // Persisted before the credential leaves, so a crash afterwards can
        // still be reconciled from the payer signature + blockhash.
        beforeSubmit: (attempt) => this.#store.recordPaymentAttempt(invocationId, attempt),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";

      if (error instanceof PaymentNotSubmittedError) {
        // Provably never transmitted: release the reservation; same request may retry.
        await this.#store.fail(invocationId, message).catch((failError: unknown) => {
          // Startup recovery in another process may already have released it.
          if (!(failError instanceof InvalidStateTransitionError)) {
            throw failError;
          }
        });
        this.#log({ event: "authority.payment_not_submitted", invocationId, grantId: permit.grantId, error: message });
        throw new PaymentNotSubmittedFailure(invocationId);
      }

      // Possibly transmitted: keep the reservation, never retry automatically.
      await this.#store.markReconciliationRequired(invocationId, message);
      this.#log({ event: "authority.reconciliation_required", invocationId, grantId: permit.grantId, error: message });
      throw new ReconciliationRequiredError(invocationId);
    }

    try {
      const confirmed = await this.#store.confirm(invocationId, {
        transactionId: execution.settlement.transactionId,
        settledAt: execution.settlement.confirmedAt,
        settlement: execution.settlement,
        result: execution.result,
      });

      this.#auditLog.append({
        type: "payment.confirmed",
        actor: this.#authorityAddress,
        mandateId: permit.grantId,
        data: { invocationId, transactionId: execution.settlement.transactionId },
      });
      this.#log({
        event: "authority.paid",
        invocationId,
        grantId: permit.grantId,
        protocol: requirement.protocol,
        scheme: requirement.scheme,
        network: requirement.network,
        amountAtomic: requirement.amountAtomic,
        recipient: requirement.payTo,
        transactionId: execution.settlement.transactionId,
        payerSignature: execution.attempt.payerSignature,
        settlement: "confirmed",
      });
      return confirmed;
    } catch (error) {
      // Paid, but the settlement could not be recorded: never pay this again.
      const message = error instanceof Error ? error.message : "unknown";
      this.#log({ event: "authority.reconciliation_required", invocationId, transactionId: execution.settlement.transactionId, error: message });
      await this.#store
        .markReconciliationRequired(invocationId, `payment ${execution.settlement.transactionId} not recorded: ${message}`)
        .catch(() => {
          // The row stays RESERVED, which startup recovery also treats as unknown.
        });
      throw new ReconciliationRequiredError(invocationId);
    }
  }

  /**
   * Resolves RECONCILIATION_REQUIRED invocations from the pinned settlement
   * RPC. Read-only toward the chain: it never submits or re-submits a
   * payment. Invocations without a recorded attempt stay blocked.
   */
  async reconcile(): Promise<ReconciliationReport[]> {
    // Single-flight: concurrent callers (timer, operator endpoint) share one run.
    if (this.#reconciliation === null) {
      this.#reconciliation = this.#reconcileOnce().finally(() => {
        this.#reconciliation = null;
      });
    }

    return this.#reconciliation;
  }

  async #reconcileOnce(): Promise<ReconciliationReport[]> {
    const reports: ReconciliationReport[] = [];

    for (const invocation of await this.#store.listReconciliationRequired()) {
      const { invocationId } = invocation;

      if (invocation.paymentAttempt === null) {
        reports.push({ invocationId, outcome: "no_attempt_recorded" });
        continue;
      }

      let lookup;

      try {
        lookup = await this.#paymentProvider.lookupSettlement(invocation.paymentAttempt);
      } catch (error) {
        reports.push({ invocationId, outcome: "lookup_error", detail: error instanceof Error ? error.message : "unknown" });
        continue;
      }

      try {
        if (lookup.status === "confirmed") {
          const confirmed = await this.#store.resolveReconciliation(invocationId, { kind: "confirmed", settlement: lookup.settlement });
          await this.#ensureReceipt(confirmed);
          this.#log({ event: "authority.reconciled", invocationId, outcome: "CONFIRMED", transactionId: lookup.settlement.transactionId });
          reports.push({ invocationId, outcome: "confirmed", detail: lookup.settlement.transactionId });
          continue;
        }

        if (lookup.status === "failed_onchain" || lookup.status === "expired") {
          const reason =
            lookup.status === "expired"
              ? `no matching transaction and blockhash expired (height ${lookup.currentBlockHeight})`
              : `transaction ${lookup.transactionId} failed on-chain`;
          await this.#store.resolveReconciliation(invocationId, { kind: "failed", reason });
          this.#log({ event: "authority.reconciled", invocationId, outcome: "FAILED", reason });
          reports.push({ invocationId, outcome: "failed", detail: reason });
          continue;
        }
      } catch (error) {
        // Resolved concurrently (e.g. by another authority process): the
        // store's guarded transition already applied it exactly once.
        if (error instanceof InvalidStateTransitionError) {
          reports.push({ invocationId, outcome: "already_resolved" });
          continue;
        }

        throw error;
      }

      {
        reports.push({
          invocationId,
          outcome: "still_pending",
          detail: lookup.status === "pending" ? `blockhash may still be valid (height ${lookup.currentBlockHeight})` : lookup.detail,
        });
      }
    }

    return reports;
  }

  #result(invocation: InvocationRecord, receipt: SignedAuthorizationReceiptV1, replay: boolean): AuthorizeResult {
    const requirement = invocation.paymentRequirement;
    const attempt = invocation.paymentAttempt;
    const payment: PaymentEvidence | null =
      requirement === null
        ? null
        : {
            settlementProfile: attempt?.settlementProfile ?? this.#paymentProvider.settlementProfile,
            protocol: requirement.protocol,
            scheme: requirement.scheme,
            challengeNetwork: requirement.network,
            asset: requirement.asset,
            payTo: requirement.payTo,
            amountAtomic: requirement.amountAtomic,
            resourceUrl: requirement.resourceUrl,
            payer: attempt?.payer ?? null,
            payerSignature: attempt?.payerSignature ?? null,
            blockhash: attempt?.blockhash ?? null,
            transactionId: invocation.settlement?.transactionId ?? invocation.paymentTransactionId,
            slot: invocation.settlement?.slot ?? null,
            resultSha256: invocation.result?.sha256 ?? null,
          };

    return { receipt, replay, payment, result: invocation.result?.json ?? null };
  }

  /**
   * Returns the stored receipt, or builds and stores one from durable state.
   * Receipts are derived only from the stored invocation, so a receipt
   * produced after a restart describes exactly what was recorded.
   */
  async #ensureReceipt(invocation: InvocationRecord): Promise<SignedAuthorizationReceiptV1> {
    if (invocation.receipt !== null) {
      return invocation.receipt;
    }

    if (invocation.state !== "DENIED" && invocation.state !== "CONFIRMED") {
      throw new Error(`Invocation ${invocation.invocationId} in state ${invocation.state} has no decision receipt.`);
    }

    const { request } = invocation;
    const receipt = await signAuthorizationReceipt(
      {
        version: AUTHORIZATION_RECEIPT_VERSION,
        domain: AUTHORIZATION_RECEIPT_DOMAIN,
        invocationId: invocation.invocationId,
        grantId: invocation.grantId,
        authority: this.#authorityAddress,
        agent: invocation.agent,
        permitDigest: request.permitDigest,
        requestFingerprint: invocation.fingerprint,
        service: request.service,
        capability: request.capability,
        network: request.network,
        mint: request.mint,
        recipient: request.recipient,
        amountAtomic: invocation.amountAtomic,
        decision: invocation.state === "CONFIRMED" ? "ALLOW" : "DENY",
        reasonCodes: invocation.reasonCodes,
        paymentTransactionId: invocation.paymentTransactionId,
        decidedAt: invocation.decidedAt,
      },
      this.#authoritySigner,
    );

    return this.#store.attachReceipt(invocation.invocationId, receipt);
  }

  #auditDecision(permit: SignedPurchasePermitV1, invocation: InvocationRecord): void {
    this.#auditLog.append({
      type: "policy.decision",
      actor: permit.authorizedAgent,
      mandateId: permit.grantId,
      data: {
        allowed: invocation.state === "RESERVED",
        reasonCodes: invocation.reasonCodes,
        invocationId: invocation.invocationId,
        amountAtomic: invocation.amountAtomic,
      },
    });
  }
}
