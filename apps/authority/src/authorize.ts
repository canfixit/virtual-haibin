import canonicalize from "canonicalize";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import {
  computeOperationDigest,
  computePermitDigest,
  verifyAuthorizationRequestSignature,
  verifyPurchasePermitV2,
  type AgentRequestSignature,
  type AuthorizationRequestV2,
  type SignedPurchasePermitV2,
} from "@virtual-haibin/mandate";
import {
  PaidServiceUnavailableError,
  PaymentNotSubmittedError,
  type PaidRequest,
  type PaymentChallenge,
  type PaymentProvider,
  type PaymentRequirement,
  type SettlementProfile,
} from "@virtual-haibin/payments";
import { evaluateExactOperation, evaluatePurchasePermit } from "@virtual-haibin/policy";
import {
  AUTHORIZATION_RECEIPT_DOMAIN,
  AUTHORIZATION_RECEIPT_VERSION,
  AUTHORIZATION_RECEIPT_VERSION_2,
  signAuthorizationReceipt,
  type SignedAuthorizationReceipt,
  type UnsignedAuthorizationReceiptV1,
} from "./receipt.js";
import {
  decodeServiceAcknowledgementHeader,
  encodeServiceHeader,
  SERVICE_AUTHORIZATION_DOMAIN,
  SERVICE_AUTHORIZATION_TTL_MS,
  serviceAuthorizationDigest,
  signServiceAuthorization,
  verifyServiceAcknowledgementSignature,
  type EvidenceBundle,
  type SignedServiceAuthorizationV1,
} from "@virtual-haibin/evidence";
import type { ConfirmedSettlement, PaidResult } from "@virtual-haibin/payments";
import { buildEvidenceBundle, EvidenceExportError } from "./evidence-export.js";
import { buildPaidRequest, paidServiceKey, selectAndValidateChallenge, type PaidServiceRegistry } from "./payment-challenge.js";
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
  /** Structurally validated (AuthorizationRequest v2) by the HTTP boundary; not yet authenticated. */
  authorizationRequest: AuthorizationRequestV2;
  /** Untrusted; verified against permit.authorizedAgent. */
  agentSignature: unknown;
};

export type AuthorizeResult = {
  receipt: SignedAuthorizationReceipt;
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
  /** Digest of the exact HTTP request (method, URL, body) that was paid for. */
  requestSha256: string | null;
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

/**
 * Which human issuer may authorize spending from this authority's payment
 * wallet, and on which settlement profiles. A valid permit signature only
 * proves *who* signed; this pins *whose* signature counts. Single-issuer by
 * design for the MVP -- not an issuer registry.
 */
export type IssuerEntitlement = {
  /** Base58 Ed25519 public key of the trusted issuer (human approval boundary). */
  issuer: string;
  /** Settlement profile names (permit `network` values) this issuer may spend on. */
  settlementProfiles: readonly string[];
};

export type AuthorityServiceOptions = {
  authoritySigner: CryptoKeyPair;
  authorityAddress: string;
  /** This authority's audience identifier; requests addressed elsewhere are rejected. */
  audience: string;
  /** Trust root: the only issuer whose permits may spend from this authority. */
  issuerEntitlement: IssuerEntitlement;
  /**
   * Pinned public keys of paid services, by serviceId. A service's signed
   * acknowledgement is kept only if it verifies against its pinned key.
   */
  trustedServiceKeys?: ReadonlyMap<string, string>;
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
  | "ISSUER_NOT_ENTITLED"
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
  | "OUTBOUND_REQUEST_MISMATCH"
  | "RECONCILIATION_REQUIRED"
  | "INVOCATION_NOT_FOUND"
  | "EVIDENCE_NOT_FINAL"
  | "EVIDENCE_UNAVAILABLE";

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
 * The permit is cryptographically valid but signed by an issuer this
 * authority does not trust to spend its payment wallet (or for a settlement
 * profile outside that issuer's entitlement). Refused before any state is
 * read or written: no reservation, no service contact, no payment signing.
 */
export class IssuerNotEntitledError extends AuthorityRequestError {
  constructor(issuer: string) {
    super(403, "ISSUER_NOT_ENTITLED", "The permit issuer is not entitled to authorize spending from this authority.", { issuer });
  }
}

/**
 * Defense in depth: the HTTP request about to be paid for no longer matches
 * the operation durably recorded at authorization. Indicates a bug; the
 * reservation is released and nothing is transmitted.
 */
export class OutboundRequestMismatchError extends AuthorityRequestError {
  constructor(readonly invocationId: string) {
    super(500, "OUTBOUND_REQUEST_MISMATCH", `Outbound request for invocation ${invocationId} does not match the authorized operation.`, {
      invocationId,
    });
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
  permit: SignedPurchasePermitV2;
  request: AuthorizationRequestV2;
  /** The verified agent signature, normalized; kept for evidence export. */
  agentSignature: AgentRequestSignature;
  operationDigest: string;
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
 * permit (by digest), the agent, every payment-relevant field and the exact
 * business operation (by digest). The signing timestamp and audience are
 * deliberately excluded, so an honest retry re-signed with a fresh timestamp
 * is recognised as the same request.
 */
async function computeRequestFingerprint(
  permit: SignedPurchasePermitV2,
  request: AuthorizationRequestV2,
  operationDigest: string,
): Promise<string> {
  const canonicalJson = canonicalize({
    version: 2,
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
    operationDigest,
  });

  if (canonicalJson === undefined) {
    throw new Error("Request fingerprint input cannot be canonicalized.");
  }

  return sha256Hex(new TextEncoder().encode(`virtual-haibin/invocation-fingerprint:v2\n${canonicalJson}`));
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
  readonly #issuerEntitlement: IssuerEntitlement;
  readonly #trustedServiceKeys: ReadonlyMap<string, string>;
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
    this.#issuerEntitlement = options.issuerEntitlement;
    this.#trustedServiceKeys = options.trustedServiceKeys ?? new Map();
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
   * Exports the portable EvidenceBundleV1 for a decided invocation, with a
   * manifest signed by this authority's (persistent) receipt key. Reads only
   * the one invocation; there is no general query surface.
   */
  async exportEvidence(invocationId: string, options: { bundleVersion?: 1 | 2 } = {}): Promise<EvidenceBundle> {
    const invocation = await this.#store.getInvocation(invocationId);

    if (invocation === null) {
      throw new AuthorityRequestError(404, "INVOCATION_NOT_FOUND", `Invocation ${invocationId} does not exist.`, { invocationId });
    }

    try {
      const bundle = await buildEvidenceBundle({
        invocation,
        paidServices: this.#paidServices,
        authorityAddress: this.#authorityAddress,
        signer: this.#authoritySigner,
        issuedAt: this.#now(),
        bundleVersion: options.bundleVersion ?? 2,
      });
      this.#log({ event: "authority.evidence_exported", invocationId, grantId: invocation.grantId, purchaseState: invocation.state });
      return bundle;
    } catch (error) {
      if (error instanceof EvidenceExportError) {
        this.#log({ event: "authority.evidence_refused", invocationId, reasonCode: error.reasonCode });
        throw new AuthorityRequestError(409, error.reasonCode, error.message, { invocationId });
      }

      throw error;
    }
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
   * Proves the permit comes from the entitled human issuer, that the caller
   * is the permit's authorized agent, and that the signed request is bound
   * to this exact permit and this authority. A transport bearer token is
   * never treated as this proof. Nothing here reads or writes durable state.
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

    // PurchasePermit v2 only: a v1 permit binds no business operation, so it
    // cannot authorize any paid call here (fails closed, UNSUPPORTED_VERSION).
    const verification = await verifyPurchasePermitV2(input.permit);

    if (!verification.verified) {
      return reject("PERMIT_INVALID", `Purchase permit is invalid: ${verification.message}`, {
        permitReasonCode: verification.reasonCode,
      });
    }

    const permit = verification.permit;

    // A valid signature is not entitlement: anyone can mint a key and sign a
    // well-formed permit. Only the configured issuer may authorize spending
    // from this authority's wallet, and only on its entitled profiles.
    if (permit.issuer !== this.#issuerEntitlement.issuer || !this.#issuerEntitlement.settlementProfiles.includes(permit.network)) {
      this.#log({
        event: "authority.issuer_not_entitled",
        reasonCode: "ISSUER_NOT_ENTITLED",
        ...logContext,
        issuer: permit.issuer,
        network: permit.network,
      });
      throw new IssuerNotEntitledError(permit.issuer);
    }

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

    const operationDigest = await computeOperationDigest(request.operation);
    // Verified above, so it is exactly {algorithm: "ed25519", signature: <base58>}.
    const agentSignature: AgentRequestSignature = { algorithm: "ed25519", signature: (input.agentSignature as { signature: string }).signature };
    return { permit, request, agentSignature, operationDigest, fingerprint: await computeRequestFingerprint(permit, request, operationDigest) };
  }

  async #process({ permit, request, agentSignature, operationDigest, fingerprint }: AuthenticatedRequest): Promise<AuthorizeResult> {
    const { invocationId } = request;

    // Known invocation: replay/conflict/reconciliation straight from durable
    // state, without contacting the paid service again.
    const known = await this.#store.getInvocation(invocationId);

    if (known !== null && !(known.state === "FAILED" && known.fingerprint === fingerprint)) {
      return this.#resolveExisting(known, fingerprint);
    }

    const decidedAt = this.#now();
    // The exact-operation check is independent of payment terms: two requests
    // with identical amount/mint/recipient differ here only by what the human
    // approved them to buy.
    const operationCodes = evaluateExactOperation(permit.operation, request.operation).reasonCodes;
    const policy = (values: { mint: string; recipient: string; amountAtomic: string }, committedAtomic: string) => [
      ...operationCodes,
      ...evaluatePurchasePermit(permit, {
        service: request.service,
        capability: request.capability,
        network: request.network,
        mint: values.mint,
        recipient: values.recipient,
        amountAtomic: values.amountAtomic,
        alreadySpentAtomic: committedAtomic,
        now: decidedAt,
      }).reasonCodes,
    ];

    // 1. Is the *signed request itself* permitted -- including the exact
    //    business operation -- ignoring shared budget? If not, deny without
    //    contacting the service at all.
    const requestAllowed = policy({ mint: request.mint, recipient: request.recipient, amountAtomic: request.amountAtomic }, "0").length === 0;
    let challenge: PaymentChallenge | null = null;
    let requirement: PaymentRequirement | null = null;
    let paidRequest: PaidRequest | null = null;
    const challengeCodes: string[] = [];

    if (requestAllowed) {
      // 2. Build the outbound request from the verified operation (never from
      //    agent-supplied bytes) and obtain the real 402 challenge for exactly
      //    that request from the trusted registry URL.
      const profile = this.#settlementProfiles.get(permit.network);
      const resource = this.#paidServices.get(paidServiceKey(request.service, request.capability)) ?? null;
      paidRequest = resource === null ? null : buildPaidRequest(resource, request.operation);

      if (!profile || profile.name !== this.#paymentProvider.settlementProfile) {
        challengeCodes.push("SETTLEMENT_PROFILE_UNAVAILABLE");
      } else if (paidRequest === null) {
        challengeCodes.push("PAID_SERVICE_NOT_CONFIGURED");
      } else {
        let result;

        try {
          result = await this.#paymentProvider.fetchChallenge(paidRequest, { reference: invocationId });
        } catch (error) {
          if (error instanceof PaidServiceUnavailableError) {
            this.#log({ event: "authority.paid_service_unavailable", invocationId, error: error.message });
            throw new PaidServiceUnavailableFailure(error.message);
          }

          throw error;
        }

        const selection = selectAndValidateChallenge(result, {
          profile,
          paidRequest,
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
          operation: request.operation.operation,
          datasetId: request.operation.datasetId,
          requestSha256: paidRequest.sha256,
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
      const codes = new Set<string>(policy({ mint: request.mint, recipient: request.recipient, amountAtomic: request.amountAtomic }, committedAtomic));

      for (const code of challengeCodes) {
        codes.add(code);
      }

      if (requirement !== null) {
        for (const code of policy({ mint: requirement.asset, recipient: requirement.payTo, amountAtomic: requirement.amountAtomic }, committedAtomic)) {
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
        authorization: { permit, agentSignature },
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
          operation: request.operation.operation,
          datasetId: request.operation.datasetId,
          operationDigest,
          decision: "DENY",
          reasonCodes: result.invocation.reasonCodes,
        });
        return this.#result(result.invocation, await this.#ensureReceipt(result.invocation), false);
      }

      case "reserved": {
        this.#auditDecision(permit, result.invocation);

        if (challenge === null || requirement === null || paidRequest === null) {
          // Unreachable: an allowed decision requires a valid requirement.
          await this.#store.fail(invocationId, "internal: reserved without a payment requirement");
          throw new Error("Reserved an invocation without a payment requirement.");
        }

        const confirmed = await this.#pay(permit, result.invocation, paidRequest, challenge, requirement);
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
    permit: SignedPurchasePermitV2,
    invocation: InvocationRecord,
    paidRequest: PaidRequest,
    challenge: PaymentChallenge,
    requirement: PaymentRequirement,
  ): Promise<InvocationRecord> {
    const { invocationId } = invocation;

    // Outbound binding: re-derive the request from the durably recorded,
    // authenticated operation and require the exact bytes about to be paid
    // for to match. The agent cannot authorize operation A and have the
    // authority transmit operation B. (The provider separately refuses to
    // pay for anything but the request the challenge was issued for.)
    if (!this.#outboundMatchesAuthorization(invocation, paidRequest)) {
      await this.#store.fail(invocationId, "outbound request does not match the authorized operation");
      this.#log({ event: "authority.outbound_request_mismatch", invocationId, grantId: permit.grantId });
      throw new OutboundRequestMismatchError(invocationId);
    }

    const budget = await this.getGrantBudget(permit.issuer, permit.grantId);

    this.#log({
      event: "authority.reserved",
      invocationId,
      grantId: permit.grantId,
      agent: permit.authorizedAgent,
      serviceId: permit.service,
      requestBody: paidRequest.body,
      requestSha256: paidRequest.sha256,
      decision: "ALLOW",
      protocol: requirement.protocol,
      scheme: requirement.scheme,
      network: requirement.network,
      recipient: requirement.payTo,
      reservedAtomic: invocation.amountAtomic,
      remainingAtomic: budget?.remainingAtomic,
    });

    // Tells a Virtual Haibin-integrated service that THIS paid request was
    // authorized by THIS authority, so it can refuse anything else before its
    // gate settles. Sent only with the paid retry; persisted with the attempt
    // before the credential leaves. Built before anything is transmitted, so a
    // failure here provably paid nothing.
    let serviceAuthorization: SignedServiceAuthorizationV1;

    try {
      serviceAuthorization = await this.#signServiceAuthorization(invocation, permit, paidRequest, requirement);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      await this.#store.fail(invocationId, `service authorization not built: ${message}`);
      this.#log({ event: "authority.payment_not_submitted", invocationId, grantId: permit.grantId, error: message });
      throw new PaymentNotSubmittedFailure(invocationId);
    }

    let execution;

    try {
      execution = await this.#paymentProvider.execute({
        request: paidRequest,
        challenge,
        requirement,
        reference: invocationId,
        serviceAuthorizationHeader: encodeServiceHeader(serviceAuthorization),
        // Persisted before the credential leaves, so a crash afterwards can
        // still be reconciled from the payer signature + blockhash.
        beforeSubmit: (attempt) => this.#store.recordPaymentAttempt(invocationId, attempt, serviceAuthorization),
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
      const result = await this.#acceptAcknowledgement(invocation, permit, serviceAuthorization, paidRequest, requirement, execution.settlement, execution.result);
      const confirmed = await this.#store.confirm(invocationId, {
        transactionId: execution.settlement.transactionId,
        settledAt: execution.settlement.confirmedAt,
        settlement: execution.settlement,
        result,
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

  async #signServiceAuthorization(
    invocation: InvocationRecord,
    permit: SignedPurchasePermitV2,
    paidRequest: PaidRequest,
    requirement: PaymentRequirement,
  ): Promise<SignedServiceAuthorizationV1> {
    if (invocation.request.version !== 2) {
      throw new Error("cannot authorize a service request for a pre-v2 invocation");
    }

    const issuedAt = this.#now();
    return signServiceAuthorization(
      {
        version: 1,
        domain: SERVICE_AUTHORIZATION_DOMAIN,
        authority: this.#authorityAddress,
        invocationId: invocation.invocationId,
        grantId: permit.grantId,
        request: { method: paidRequest.method, url: paidRequest.url, contentType: paidRequest.contentType, requestSha256: paidRequest.sha256 },
        operationDigest: await computeOperationDigest(invocation.request.operation),
        payment: { network: requirement.network, asset: requirement.asset, payTo: requirement.payTo, amountAtomic: requirement.amountAtomic },
        issuedAt,
        expiresAt: issuedAt + SERVICE_AUTHORIZATION_TTL_MS,
      },
      this.#authoritySigner,
    );
  }

  /**
   * Keeps the service's acknowledgement header only if it verifies against
   * the service's PINNED key and states exactly this invocation, the
   * authorization we sent, the request we sent, the operation, the payment
   * terms, the confirmed transaction and the result bytes we received.
   * Otherwise it is dropped (and logged). The payment itself is already
   * settled and confirmed; an acknowledgement never changes payment state.
   */
  async #acceptAcknowledgement(
    invocation: InvocationRecord,
    permit: SignedPurchasePermitV2,
    authorization: SignedServiceAuthorizationV1,
    paidRequest: PaidRequest,
    requirement: PaymentRequirement,
    settlement: ConfirmedSettlement,
    result: PaidResult,
  ): Promise<PaidResult> {
    const { serviceAcknowledgementHeader: header, ...withoutAcknowledgement } = result;
    const reject = (reason: string) => {
      this.#log({ event: "authority.service_acknowledgement_rejected", invocationId: invocation.invocationId, reason });
      return withoutAcknowledgement;
    };

    if (header === undefined) {
      return reject("service sent no acknowledgement");
    }

    const pinned = this.#trustedServiceKeys.get(permit.service);

    if (pinned === undefined) {
      return reject(`no pinned key for service ${permit.service}`);
    }

    try {
      const ack = decodeServiceAcknowledgementHeader(header);
      const op = invocation.request.version === 2 ? invocation.request.operation : null;
      const problems = [
        !(await verifyServiceAcknowledgementSignature(ack, pinned)) && "signature",
        ack.invocationId !== invocation.invocationId && "invocation",
        ack.authorizationDigest !== (await serviceAuthorizationDigest(authorization)) && "authorization",
        ack.requestSha256 !== paidRequest.sha256 && "request",
        (op === null ||
          ack.received.method !== op.method ||
          ack.received.resource !== op.resource ||
          ack.received.operation !== op.operation ||
          ack.received.datasetId !== op.datasetId) &&
          "operation",
        (ack.payment.asset !== requirement.asset || ack.payment.payTo !== requirement.payTo || ack.payment.amountAtomic !== requirement.amountAtomic) && "payment",
        ack.payment.transaction !== settlement.transactionId && "transaction",
        (ack.result.sha256 !== result.sha256 || ack.result.bytes !== result.bytes || ack.result.httpStatus !== result.httpStatus) && "result",
      ].filter((problem): problem is string => typeof problem === "string");

      if (problems.length > 0) {
        return reject(`acknowledgement mismatch: ${problems.join(", ")}`);
      }

      this.#log({ event: "authority.service_acknowledged", invocationId: invocation.invocationId, service: ack.service, transactionId: settlement.transactionId });
      return { ...withoutAcknowledgement, serviceAcknowledgementHeader: header };
    } catch (error) {
      return reject(error instanceof Error ? error.message : "malformed acknowledgement");
    }
  }

  #outboundMatchesAuthorization(invocation: InvocationRecord, paidRequest: PaidRequest): boolean {
    const stored = invocation.request;

    if (stored.version !== 2) {
      return false;
    }

    const resource = this.#paidServices.get(paidServiceKey(stored.service, stored.capability));
    const expected = resource === undefined ? null : buildPaidRequest(resource, stored.operation);

    return (
      expected !== null &&
      expected.sha256 === paidRequest.sha256 &&
      expected.url === paidRequest.url &&
      expected.method === paidRequest.method &&
      expected.body === paidRequest.body
    );
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

  #result(invocation: InvocationRecord, receipt: SignedAuthorizationReceipt, replay: boolean): AuthorizeResult {
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
            requestSha256: attempt?.requestSha256 ?? null,
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
   * produced after a restart describes exactly what was recorded. v2
   * requests get v2 receipts (with the operation); invocations recorded
   * before operation binding keep the v1 receipt format.
   */
  async #ensureReceipt(invocation: InvocationRecord): Promise<SignedAuthorizationReceipt> {
    if (invocation.receipt !== null) {
      return invocation.receipt;
    }

    if (invocation.state !== "DENIED" && invocation.state !== "CONFIRMED") {
      throw new Error(`Invocation ${invocation.invocationId} in state ${invocation.state} has no decision receipt.`);
    }

    const { request } = invocation;
    const fields: Omit<UnsignedAuthorizationReceiptV1, "version"> = {
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
    };

    const receipt =
      request.version === 2
        ? await signAuthorizationReceipt(
            {
              version: AUTHORIZATION_RECEIPT_VERSION_2,
              ...fields,
              operation: request.operation,
              operationDigest: await computeOperationDigest(request.operation),
            },
            this.#authoritySigner,
          )
        : await signAuthorizationReceipt({ version: AUTHORIZATION_RECEIPT_VERSION, ...fields }, this.#authoritySigner);

    return this.#store.attachReceipt(invocation.invocationId, receipt);
  }

  #auditDecision(permit: SignedPurchasePermitV2, invocation: InvocationRecord): void {
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
