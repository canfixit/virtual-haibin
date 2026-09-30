import canonicalize from "canonicalize";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import {
  computePermitDigest,
  verifyAuthorizationRequestSignature,
  verifyPurchasePermit,
  type AuthorizationRequestV1,
  type SignedPurchasePermitV1,
} from "@virtual-haibin/mandate";
import type { PaymentProvider } from "@virtual-haibin/payments";
import { evaluatePurchasePermit } from "@virtual-haibin/policy";
import {
  AUTHORIZATION_RECEIPT_DOMAIN,
  AUTHORIZATION_RECEIPT_VERSION,
  signAuthorizationReceipt,
  type SignedAuthorizationReceiptV1,
  type UnsignedAuthorizationReceiptV1,
} from "./receipt.js";

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
};

export type AuthorityLogEntry = { event: string } & Record<string, unknown>;

export type AuthorityServiceOptions = {
  authoritySigner: CryptoKeyPair;
  authorityAddress: string;
  /** This authority's audience identifier; requests addressed elsewhere are rejected. */
  audience: string;
  paymentProvider: PaymentProvider;
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
 * Thrown when a payment for this invocation was attempted but its outcome is
 * unknown (the provider threw, or the receipt could not be produced after
 * paying). Retrying must not pay again -- a timeout is not permission to
 * re-submit (CLAUDE.md security invariants 12/13). The invocation stays
 * blocked, and its budget stays reserved, until it is reconciled; durable
 * reconciliation lands with Phase 3/4.
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

type InvocationRecord =
  | { state: "in_flight"; fingerprint: string; promise: Promise<SignedAuthorizationReceiptV1> }
  | { state: "decided"; fingerprint: string; receipt: SignedAuthorizationReceiptV1 }
  | { state: "reconciliation_required"; fingerprint: string };

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
 * State here (per-grant spend, per-invocation records) lives only in this
 * process's memory. That's a deliberate, documented Phase 2 limitation: it
 * demonstrates atomic-within-a-process budget reservation and idempotent
 * invocation handling, but does not survive a restart and does not
 * coordinate across authority processes. Phase 3 replaces it with durable,
 * atomically-reserved storage.
 */
export class AuthorityService {
  readonly #authoritySigner: CryptoKeyPair;
  readonly #authorityAddress: string;
  readonly #audience: string;
  readonly #paymentProvider: PaymentProvider;
  readonly #auditLog: InMemoryAuditLog;
  readonly #log: (entry: AuthorityLogEntry) => void;
  readonly #now: () => number;
  readonly #maxRequestAgeMs: number;
  readonly #maxFutureSkewMs: number;

  readonly #grantSpentAtomic = new Map<string, bigint>();
  readonly #invocations = new Map<string, InvocationRecord>();

  constructor(options: AuthorityServiceOptions) {
    this.#authoritySigner = options.authoritySigner;
    this.#authorityAddress = options.authorityAddress;
    this.#audience = options.audience;
    this.#paymentProvider = options.paymentProvider;
    this.#auditLog = options.auditLog ?? new InMemoryAuditLog();
    this.#log = options.log ?? defaultLog;
    this.#now = options.now ?? Date.now;
    this.#maxRequestAgeMs = options.maxRequestAgeMs ?? 120_000;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 30_000;
  }

  get auditLog(): InMemoryAuditLog {
    return this.#auditLog;
  }

  /** Atomic units spent or reserved under a grant in this process (read-only view). */
  getGrantSpentAtomic(grantId: string): string {
    return (this.#grantSpentAtomic.get(grantId) ?? 0n).toString();
  }

  async authorize(input: AuthorizeRequestInput): Promise<AuthorizeResult> {
    const authenticated = await this.#authenticate(input);
    const { invocationId } = authenticated.request;
    const { fingerprint } = authenticated;

    // From here to `set` below there is no `await`, so claiming the
    // invocationId is atomic with respect to concurrent requests.
    const existing = this.#invocations.get(invocationId);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.#log({ event: "authority.invocation_conflict", invocationId, grantId: authenticated.permit.grantId });
        throw new InvocationConflictError(invocationId);
      }

      if (existing.state === "reconciliation_required") {
        this.#log({ event: "authority.reconciliation_blocked", invocationId });
        throw new ReconciliationRequiredError(invocationId);
      }

      const receipt = existing.state === "decided" ? existing.receipt : await existing.promise;
      this.#log({ event: "authority.replay", invocationId, grantId: receipt.grantId, decision: receipt.decision });
      return { receipt, replay: true };
    }

    const promise = this.#decide(authenticated);
    this.#invocations.set(invocationId, { state: "in_flight", fingerprint, promise });

    try {
      const receipt = await promise;
      this.#invocations.set(invocationId, { state: "decided", fingerprint, receipt });
      return { receipt, replay: false };
    } catch (error) {
      if (error instanceof ReconciliationRequiredError) {
        this.#invocations.set(invocationId, { state: "reconciliation_required", fingerprint });
      } else {
        // Failed before any payment attempt (reservation happens only
        // immediately before paying), so the invocation may be retried.
        this.#invocations.delete(invocationId);
      }

      throw error;
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

  async #decide({ permit, request, fingerprint }: AuthenticatedRequest): Promise<SignedAuthorizationReceiptV1> {
    const currentSpentAtomic = this.#grantSpentAtomic.get(permit.grantId) ?? 0n;

    const decision = evaluatePurchasePermit(permit, {
      service: request.service,
      capability: request.capability,
      network: request.network,
      mint: request.mint,
      recipient: request.recipient,
      amountAtomic: request.amountAtomic,
      alreadySpentAtomic: currentSpentAtomic.toString(),
      now: this.#now(),
    });

    this.#auditLog.append({
      type: "policy.decision",
      actor: permit.authorizedAgent,
      mandateId: permit.grantId,
      data: {
        allowed: decision.allowed,
        reasonCodes: decision.reasonCodes,
        invocationId: request.invocationId,
        amountAtomic: request.amountAtomic,
      },
    });

    if (!decision.allowed) {
      return this.#recordDenial(permit, request, fingerprint, decision.reasonCodes);
    }

    // Reserve budget with no `await` between reading currentSpentAtomic and
    // writing the new total, so a concurrent authorize() call for the same
    // grantId cannot observe a stale value -- this is what keeps a burst of
    // concurrent requests from collectively exceeding maxTotalAtomic within
    // this process (demo Case 5).
    const amountAtomic = BigInt(request.amountAtomic);
    const spentAfterReservation = currentSpentAtomic + amountAtomic;
    this.#grantSpentAtomic.set(permit.grantId, spentAfterReservation);

    this.#log({
      event: "authority.reserved",
      invocationId: request.invocationId,
      grantId: permit.grantId,
      agent: permit.authorizedAgent,
      serviceId: permit.service,
      decision: "ALLOW",
      reservedAtomic: amountAtomic.toString(),
      remainingAtomic: (BigInt(permit.maxTotalAtomic) - spentAfterReservation).toString(),
    });

    try {
      // Payment facts come from the verified permit, not the caller's request
      // (they are equal after a successful policy check, but the permit is
      // the authoritative source).
      const payment = await this.#paymentProvider.pay({
        from: this.#authorityAddress,
        to: permit.recipient,
        mint: permit.mint,
        network: permit.network,
        amountAtomic: amountAtomic.toString(),
        reference: request.invocationId,
      });

      this.#auditLog.append({
        type: "payment.completed",
        actor: this.#authorityAddress,
        mandateId: permit.grantId,
        data: payment,
      });

      const receipt = await signAuthorizationReceipt(
        {
          ...this.#receiptBase(permit, request, fingerprint),
          service: permit.service,
          capability: permit.capability,
          network: permit.network,
          mint: permit.mint,
          recipient: permit.recipient,
          amountAtomic: amountAtomic.toString(),
          decision: "ALLOW",
          reasonCodes: [],
          paymentTransactionId: payment.transactionId,
        },
        this.#authoritySigner,
      );

      this.#log({
        event: "authority.paid",
        invocationId: request.invocationId,
        grantId: permit.grantId,
        transactionId: payment.transactionId,
        settlement: payment.status,
      });

      return receipt;
    } catch (error) {
      // A payment may or may not have been submitted. Block this invocation
      // and keep its budget reserved rather than risk paying twice.
      this.#log({
        event: "authority.reconciliation_required",
        invocationId: request.invocationId,
        grantId: permit.grantId,
        error: error instanceof Error ? error.message : "unknown",
      });
      throw new ReconciliationRequiredError(request.invocationId);
    }
  }

  #receiptBase(
    permit: SignedPurchasePermitV1,
    request: AuthorizationRequestV1,
    fingerprint: string,
  ): Pick<
    UnsignedAuthorizationReceiptV1,
    "version" | "domain" | "invocationId" | "grantId" | "authority" | "agent" | "permitDigest" | "requestFingerprint" | "decidedAt"
  > {
    return {
      version: AUTHORIZATION_RECEIPT_VERSION,
      domain: AUTHORIZATION_RECEIPT_DOMAIN,
      invocationId: request.invocationId,
      grantId: permit.grantId,
      authority: this.#authorityAddress,
      agent: permit.authorizedAgent,
      permitDigest: request.permitDigest,
      requestFingerprint: fingerprint,
      decidedAt: this.#now(),
    };
  }

  async #recordDenial(
    permit: SignedPurchasePermitV1,
    request: AuthorizationRequestV1,
    fingerprint: string,
    reasonCodes: string[],
  ): Promise<SignedAuthorizationReceiptV1> {
    const receipt = await signAuthorizationReceipt(
      {
        ...this.#receiptBase(permit, request, fingerprint),
        service: request.service,
        capability: request.capability,
        network: request.network,
        mint: request.mint,
        recipient: request.recipient,
        amountAtomic: request.amountAtomic,
        decision: "DENY",
        reasonCodes,
        paymentTransactionId: null,
      },
      this.#authoritySigner,
    );

    this.#log({
      event: "authority.denied",
      invocationId: request.invocationId,
      grantId: permit.grantId,
      agent: permit.authorizedAgent,
      serviceId: request.service,
      decision: "DENY",
      reasonCodes,
    });

    return receipt;
  }
}
