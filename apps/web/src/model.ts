// Pure view-model helpers. Everything shown in the UI is derived from REAL
// backend responses (agent /demo, the authority's signed receipt, the
// exported evidence bundle and the verifier's report). Nothing is simulated:
// a step without backing data is shown as not reached / pending, never as done.

export type Operation = { method: string; resource: string; operation: string; datasetId: string };

export type Permit = {
  grantId: string;
  issuer: string;
  authorizedAgent: string;
  service: string;
  recipient: string;
  mint: string;
  maxPerCallAtomic: string;
  maxTotalAtomic: string;
  expiresAt: number;
  operation: Operation;
};

export type Receipt = {
  decision: "ALLOW" | "DENY";
  reasonCodes: string[];
  service: string;
  capability: string;
  network: string;
  mint: string;
  recipient: string;
  amountAtomic: string;
  permitDigest: string;
  paymentTransactionId: string | null;
  operation?: Operation;
};

export type Payment = {
  protocol: string | null;
  asset: string | null;
  payTo: string | null;
  amountAtomic: string | null;
  payerSignature: string | null;
  transactionId: string | null;
  requestSha256: string | null;
  settlementProfile: string | null;
};

export type DemoResponse = {
  status?: string;
  invocationId?: string;
  operation?: Operation;
  quote?: { service: string; method: string; resource: string; network: string; mint: string; recipient: string; amountAtomic: string; display?: { tokenLabel?: string; decimals?: number } };
  authorization?: { decision: "ALLOW" | "DENY"; replay: boolean; receipt: Receipt; payment: Payment | null; result: unknown };
  authority?: { reasonCode?: string; error?: string };
};

export type ClaimStatus =
  | "VERIFIED"
  | "INVALID"
  | "NOT_SATISFIED"
  | "AUTHORITY_ATTESTED"
  | "SERVICE_ATTESTED"
  | "NOT_CHECKED"
  | "NOT_PROVABLE_FROM_BUNDLE"
  | "INDETERMINATE";

export type Claim = { id: string; category: string; status: ClaimStatus; required: boolean; detail?: string };

export type VerificationReport = {
  overall: "VALID" | "INVALID" | "INDETERMINATE";
  mode: "offline" | "online";
  decision: "ALLOW" | "DENY" | null;
  purchaseState: string | null;
  invocationId: string | null;
  claims: Claim[];
  notProven: string[];
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "AbCd…WxYz" for long base58/hex identifiers; short strings unchanged. */
export function shorten(value: string | null | undefined, keep = 4): string {
  if (!value) return "—";
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Integer base units -> "10,000" (string arithmetic only; never floating point). */
export function formatUnits(atomic: string | null | undefined): string {
  if (!atomic || !/^\d+$/.test(atomic)) return "—";
  return atomic.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Integer base units -> decimal token amount, e.g. "10000" with 6 decimals -> "0.01". */
export function formatToken(atomic: string | null | undefined, decimals = 6): string {
  if (!atomic || !/^\d+$/.test(atomic)) return "—";
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export const opLabel = (operation: Operation | undefined | null) => (operation ? `${operation.operation}(${operation.datasetId})` : "—");

// ---------------------------------------------------------------------------
// Purchase timeline
// ---------------------------------------------------------------------------

export type StepState = "done" | "blocked" | "not-reached" | "pending";

export type TimelineStep = { id: string; label: string; state: StepState; value: string; detail?: string };

const OPERATION_CODES = ["OPERATION_NOT_AUTHORIZED", "OPERATION_ARGUMENT_NOT_AUTHORIZED", "OPERATION_METHOD_MISMATCH", "OPERATION_RESOURCE_MISMATCH"];
const BUDGET_CODES = ["PER_CALL_LIMIT_EXCEEDED", "TOTAL_BUDGET_EXCEEDED", "INVALID_AMOUNT"];

function claimStatus(report: VerificationReport | null, id: string): ClaimStatus | null {
  return report?.claims.find((claim) => claim.id === id)?.status ?? null;
}

/**
 * The purchase as a sequence of checks, each backed by real data:
 * the authority's signed receipt (decision + reason codes), the payment
 * evidence it returned, the service result, and -- once fetched -- the
 * exported evidence and the verifier's report.
 */
export function buildTimeline(run: DemoResponse, evidence: { bundleFetched: boolean; report: VerificationReport | null }): TimelineStep[] {
  const authorization = run.authorization;
  const receipt = authorization?.receipt;
  const payment = authorization?.payment ?? null;
  const codes = receipt?.reasonCodes ?? [];
  const operationBlocked = codes.some((code) => OPERATION_CODES.includes(code));
  const budgetBlocked = codes.some((code) => BUDGET_CODES.includes(code));
  const denied = authorization?.decision === "DENY";
  const reached = (condition: boolean, value: string, detail?: string): Pick<TimelineStep, "state" | "value" | "detail"> =>
    condition ? { state: "done", value, ...(detail ? { detail } : {}) } : { state: "not-reached", value: denied ? "NOT REACHED" : "—" };

  const steps: TimelineStep[] = [
    { id: "permission", label: "Human permission", ...(receipt ? { state: "done", value: "VERIFIED", detail: "Signed by the trusted issuer" } : { state: "not-reached", value: "—" }) },
    { id: "agent", label: "Agent identity", ...(receipt ? { state: "done", value: "VERIFIED", detail: "Request signed by the permitted agent" } : { state: "not-reached", value: "—" }) },
    {
      id: "operation",
      label: "Operation",
      ...(receipt === undefined
        ? { state: "not-reached", value: "—" }
        : operationBlocked
          ? { state: "blocked", value: "NOT AUTHORIZED", detail: codes.filter((code) => OPERATION_CODES.includes(code)).join(", ") }
          : { state: "done", value: "AUTHORIZED", detail: opLabel(run.operation) }),
    },
    {
      id: "budget",
      label: "Budget",
      ...(receipt === undefined || operationBlocked
        ? { state: "not-reached", value: operationBlocked ? "NOT REACHED" : "—" }
        : budgetBlocked
          ? { state: "blocked", value: "EXCEEDED", detail: codes.filter((code) => BUDGET_CODES.includes(code)).join(", ") }
          : { state: "done", value: "AVAILABLE" }),
    },
    { id: "challenge", label: "x402 challenge", ...reached(payment?.protocol === "x402", "VERIFIED", "Payment terms match the human permit") },
    {
      id: "service-authorization",
      label: "Service authorization",
      ...(payment?.transactionId
        ? claimStatus(evidence.report, "service_authorization") === "VERIFIED"
          ? { state: "done", value: "VERIFIED", detail: "Service checked Virtual Haibin's signature before settling" }
          : { state: "pending", value: evidence.report ? "NOT VERIFIED" : "CHECKING…" }
        : { state: "not-reached", value: denied ? "NOT REACHED" : "—" }),
    },
    { id: "payment", label: "Payment", ...reached(Boolean(payment?.transactionId), "SETTLED", payment?.transactionId ? `Transaction ${shorten(payment.transactionId, 6)}` : undefined) },
    { id: "result", label: "Service result", ...reached(authorization?.result != null && !denied, "RECEIVED") },
    {
      id: "evidence",
      label: "Evidence",
      ...(denied
        ? { state: "not-reached", value: "—" }
        : evidence.bundleFetched
          ? { state: "done", value: "AVAILABLE", detail: "Signed, portable bundle exported" }
          : { state: payment?.transactionId ? "pending" : "not-reached", value: payment?.transactionId ? "EXPORTING…" : "—" }),
    },
  ];

  return steps;
}

// ---------------------------------------------------------------------------
// ALLOWED vs BLOCKED comparison
// ---------------------------------------------------------------------------

export type ComparisonRow = { label: string; allowed: string; blocked: string; same: boolean | null; emphasis?: "decision" | "payment" };

/**
 * Side-by-side comparison of the two REAL requests. Payment terms come from
 * the authority's signed receipts (fallback: the merchant quote). `same` is
 * computed from the raw values, never asserted.
 */
export function buildComparison(permit: Permit | null, allowed: DemoResponse | null, blocked: DemoResponse | null): ComparisonRow[] {
  const facts = (run: DemoResponse | null) => {
    const receipt = run?.authorization?.receipt;
    const quote = run?.quote;
    return {
      // Only compared for a request that actually happened.
      permit: permit && run ? opLabel(permit.operation) : null,
      asks: run?.operation?.operation ?? null,
      dataset: run?.operation?.datasetId ?? null,
      merchant: receipt?.service ?? quote?.service ?? null,
      endpoint: quote ? `${quote.method} ${quote.resource}` : run?.operation ? `${run.operation.method} ${run.operation.resource}` : null,
      token: receipt?.mint ?? quote?.mint ?? null,
      recipient: receipt?.recipient ?? quote?.recipient ?? null,
      price: receipt?.amountAtomic ?? quote?.amountAtomic ?? null,
      decision: run?.authorization?.decision ?? null,
      payment: run ? (run.authorization?.payment?.transactionId ? "SETTLED" : "NONE") : null,
    };
  };

  const a = facts(allowed);
  const b = facts(blocked);
  const row = (label: string, key: keyof typeof a, display: (value: string) => string = (value) => value, emphasis?: ComparisonRow["emphasis"]): ComparisonRow => ({
    label,
    allowed: a[key] === null ? "—" : display(a[key]),
    blocked: b[key] === null ? "—" : display(b[key]),
    same: a[key] === null || b[key] === null ? null : a[key] === b[key],
    ...(emphasis ? { emphasis } : {}),
  });

  return [
    row("Human permit", "permit"),
    row("Agent asks", "asks"),
    row("Dataset", "dataset"),
    row("Merchant", "merchant"),
    row("Endpoint", "endpoint"),
    row("Token", "token", (value) => `Sandbox USDC ${shorten(value)}`),
    row("Recipient", "recipient", (value) => shorten(value, 6)),
    row("Price", "price", (value) => `${formatUnits(value)} units`),
    row("Decision", "decision", (value) => value, "decision"),
    row("Payment", "payment", (value) => value, "payment"),
  ];
}

// ---------------------------------------------------------------------------
// Verifier claims, grouped for people
// ---------------------------------------------------------------------------

export type ClaimGroup = { id: string; title: string; claims: Array<Claim & { label: string }> };

const GROUPS: Array<{ id: string; title: string; claims: Record<string, string> }> = [
  {
    id: "identity",
    title: "Identity & authority",
    claims: {
      issuer_trusted: "Trusted human issuer",
      permit_signature: "Human permission signature",
      agent_request_signature: "Agent signature",
      request_bound_to_permit: "Request bound to this permit",
      authority_trusted: "Trusted Virtual Haibin authority",
      authority_decision_signature: "Authority decision signature",
      manifest_signature: "Evidence manifest signature",
      artifact_digests: "Evidence integrity (digests)",
      state_consistent: "Evidence consistency",
      bundle_format: "Evidence format",
    },
  },
  {
    id: "request",
    title: "Request vs human permission",
    claims: {
      operation_matches_permit: "Operation",
      operation_arguments_match: "Dataset",
      method_resource_match: "Method & endpoint",
      service_capability_match: "Service",
      network_profile_match: "Network",
      mint_match: "Token",
      recipient_match: "Recipient",
      per_call_limit: "Per-call limit",
      permit_time_bounds: "Within permit validity",
      decision_matches_static_policy: "Decision matches policy",
    },
  },
  {
    id: "service",
    title: "Service",
    claims: {
      service_authorization: "Service authorization",
      service_trusted: "Trusted service key",
      service_acknowledgement: "Service acknowledgement",
      service_result_attestation: "Result attestation",
    },
  },
  {
    id: "payment",
    title: "Payment",
    claims: {
      settlement_profile_match: "Sandbox settlement profile",
      x402_asset_matches: "x402 token",
      x402_recipient_matches: "x402 recipient",
      x402_amount_matches: "x402 amount",
      outbound_request_matches_operation: "Paid request = approved operation",
      payment_attempt_matches_requirement: "Payment requirement",
      payment_transaction: "Signed transfer",
      settlement: "Settlement",
      result_digest: "Result bytes",
    },
  },
  {
    id: "limits",
    title: "Limits of proof",
    claims: {
      result_correctness: "Result correctness",
      global_budget_completeness: "Global budget history",
      total_budget_decision: "Total budget decision",
      result_observed_by_authority: "Result observed by authority",
    },
  },
];

/** Groups every claim for display; unknown claim ids are kept (group "other"), never dropped. */
export function groupClaims(report: VerificationReport): ClaimGroup[] {
  const placed = new Set<string>();
  const groups: ClaimGroup[] = GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    claims: report.claims
      .filter((claim) => claim.id in group.claims)
      .map((claim) => {
        placed.add(claim.id);
        return { ...claim, label: group.claims[claim.id] ?? claim.id };
      }),
  }));
  const other = report.claims.filter((claim) => !placed.has(claim.id)).map((claim) => ({ ...claim, label: claim.id }));

  if (other.length > 0) {
    groups.push({ id: "other", title: "Other checks", claims: other });
  }

  return groups.filter((group) => group.claims.length > 0);
}

/** Short human wording for each verifier status. */
export const STATUS_LABEL: Record<ClaimStatus, string> = {
  VERIFIED: "Verified",
  INVALID: "Invalid",
  NOT_SATISFIED: "Not satisfied",
  AUTHORITY_ATTESTED: "Authority-attested",
  SERVICE_ATTESTED: "Service-attested",
  NOT_CHECKED: "Not checked",
  NOT_PROVABLE_FROM_BUNDLE: "Not provable",
  INDETERMINATE: "Indeterminate",
};
