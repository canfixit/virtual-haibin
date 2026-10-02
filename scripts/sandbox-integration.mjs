// EXTERNAL INTEGRATION TEST -- Pay.sh Solana Payment Sandbox.
//
// Drives the running Compose stack end to end against the real hosted sandbox
// (https://402.surfnet.dev:8899; no real funds). Run from the demo-driver
// container, which (like the human's browser) can reach the approver:
//
//   docker compose run --rm -T \
//     -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" \
//     demo-driver node scripts/sandbox-integration.mjs
//
// Exits non-zero on any failed assertion. Sandbox *availability* is checked
// separately (CI preflight) so an outage is reported as such, not hidden.

import { isExternalPaymentFailure, Outcome } from "./lib/outcome.mjs";

const AGENT_URL = process.env.AGENT_URL ?? "http://agent:4000";
const AUTHORITY_URL = process.env.AUTHORITY_URL ?? "http://authority:4002";
const APPROVER_URL = process.env.APPROVER_URL ?? "http://approver:4003";
// The human's approval code (from the approver's private volume), supplied by the operator.
const APPROVER_CODE = process.env.APPROVER_CODE;

if (!APPROVER_CODE) {
  console.error('APPROVER_CODE is required: docker compose run --rm -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" demo-driver ...');
  process.exit(2);
}
const SECRET = process.env.AUTHORITY_SHARED_SECRET;

// Exit 0 pass / 1 integration regression / 3 external environment failure (see lib/outcome.mjs).
const outcome = new Outcome();
const check = (name, condition, detail) => outcome.check(name, condition, detail);

async function demo(body) {
  const response = await fetch(`${AGENT_URL}/demo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "summarize", datasetId: "dataset-a", ...body }),
    signal: AbortSignal.timeout(90_000),
  });
  const json = await response.json();
  const authorization = json.authorization ?? {};
  return {
    http: response.status,
    status: json.status,
    decision: authorization.decision ?? null,
    reasons: authorization.receipt?.reasonCodes ?? [],
    refusal: json.authority?.reasonCode ?? null,
    tx: authorization.payment?.transactionId ?? null,
    replay: authorization.replay ?? null,
    result: authorization.result ?? null,
    received: authorization.result?.received ?? null,
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, json: await response.json() };
}

async function reconcile() {
  const response = await fetch(`${AUTHORITY_URL}/reconcile`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(60_000),
  });
  return (await response.json()).reports ?? [];
}

const run = `it-${Date.now()}`;
console.log(`Pay.sh Solana Payment Sandbox integration run ${run}`);

// Human approval: the approver (not the agent) issues a permit for exactly
// summarize(dataset-a); the agent only installs the signed permit.
const identity = await (await fetch(`${AGENT_URL}/identity`)).json();
const withoutCode = await postJson(`${APPROVER_URL}/approvals`, { agent: identity.agent, operation: "export", datasetId: "dataset-a" });
check("an approval without the human's approval code is refused", withoutCode.status === 401, withoutCode);
const issued = await postJson(
  `${APPROVER_URL}/approvals`,
  { agent: identity.agent, operation: "summarize", datasetId: "dataset-a" },
  { authorization: `Bearer ${APPROVER_CODE}` },
);
check("approver issues a permit for summarize(dataset-a)", issued.status === 201 && issued.json.permit?.operation?.operation === "summarize", issued);
const installed = await postJson(`${AGENT_URL}/permit`, { permit: issued.json.permit });
check("agent installs the human-signed permit", installed.status === 200, installed);

// Case 1: ALLOW -> real sandbox settlement + paid result.
const allow = await demo({ invocationId: `${run}-allow` });
const allowSettled = allow.http === 200 && allow.decision === "ALLOW" && typeof allow.tx === "string" && allow.result !== null;
const allowExternal = !allowSettled && isExternalPaymentFailure(allow);

if (allowExternal) {
  // Correct product behavior (blocked, not retried); the environment failed.
  outcome.external("ALLOW settles on the sandbox and returns the paid result", "payment outcome uncertain or paid service unavailable", allow);
  outcome.skip("the service received exactly the approved operation", "depends on the ALLOW settlement");
} else {
  check("ALLOW settles on the sandbox and returns the paid result", allowSettled, allow);
  check("the service received exactly the approved operation", allow.received?.operation === "summarize" && allow.received?.datasetId === "dataset-a", allow.received);
}

// Phase 4.5: same price/payTo/asset, different business operation or argument.
const exportDeny = await demo({ operation: "export" });
check("export (same price, not approved) -> DENY OPERATION_NOT_AUTHORIZED, no payment", exportDeny.http === 403 && JSON.stringify(exportDeny.reasons) === '["OPERATION_NOT_AUTHORIZED"]' && exportDeny.tx === null, exportDeny);

const argumentDeny = await demo({ datasetId: "dataset-b" });
check("summarize(dataset-b) -> DENY OPERATION_ARGUMENT_NOT_AUTHORIZED, no payment", argumentDeny.http === 403 && JSON.stringify(argumentDeny.reasons) === '["OPERATION_ARGUMENT_NOT_AUTHORIZED"]' && argumentDeny.tx === null, argumentDeny);

// Case 4: replay -> same stored result, no new settlement.
const replay = await demo({ invocationId: `${run}-allow` });
if (allowExternal) {
  // Still a product check: an uncertain invocation must stay blocked, never be paid again.
  check("replay of the uncertain ALLOW stays RECONCILIATION_REQUIRED (no second payment)", replay.http === 409 && replay.refusal === "RECONCILIATION_REQUIRED", replay);
  outcome.skip("replay returns the same transaction without paying again", "depends on the ALLOW settlement");
} else {
  check("replay returns the same transaction without paying again", replay.http === 200 && replay.replay === true && replay.tx === allow.tx, replay);
}

// Case 5: conflict.
const conflict = await demo({ invocationId: `${run}-allow`, amountAtomic: "15000" });
check("same invocationId + different request -> 409 INVOCATION_CONFLICT", conflict.http === 409 && conflict.refusal === "INVOCATION_CONFLICT", conflict);

// Case 2/3: misbehaving merchant -> real 402 validated, nothing signed.
const overcharge = await demo({ scenario: "overcharge" });
check("overcharged challenge denied (per-call limit)", overcharge.http === 403 && overcharge.reasons.includes("PER_CALL_LIMIT_EXCEEDED") && overcharge.tx === null, overcharge);

const wrongRecipient = await demo({ scenario: "wrong-recipient" });
check("wrong payTo denied (RECIPIENT_MISMATCH)", wrongRecipient.http === 403 && wrongRecipient.reasons.includes("RECIPIENT_MISMATCH") && wrongRecipient.tx === null, wrongRecipient);

const wrongAsset = await demo({ scenario: "wrong-asset" });
check("wrong asset denied (ASSET_NOT_ALLOWED + MINT_MISMATCH)", wrongAsset.http === 403 && wrongAsset.reasons.includes("ASSET_NOT_ALLOWED") && wrongAsset.reasons.includes("MINT_MISMATCH"), wrongAsset);

// Case 7: settled on-chain but the response was lost -> reconcile from the payer signature.
const lost = await demo({ invocationId: `${run}-lost`, scenario: "lost-response" });
check("lost response -> 409 RECONCILIATION_REQUIRED", lost.http === 409 && lost.refusal === "RECONCILIATION_REQUIRED", lost);

const retry = await demo({ invocationId: `${run}-lost`, scenario: "lost-response" });
check("retry while unresolved does not pay again", retry.http === 409 && retry.refusal === "RECONCILIATION_REQUIRED", retry);

let resolved = null;
let lastReport = null;
for (let attempt = 0; attempt < 12 && resolved === null; attempt += 1) {
  const reports = await reconcile();
  lastReport = reports.find((report) => report.invocationId === `${run}-lost`) ?? lastReport;
  resolved = reports.find((report) => report.invocationId === `${run}-lost` && report.outcome === "confirmed") ?? null;
  if (resolved === null) await new Promise((resolve) => setTimeout(resolve, 5_000));
}
// The lost-response payment is submitted by the sandbox facilitator. If it
// never landed (or is still pending), that is the environment, provided the
// authority kept it blocked rather than confirming or re-paying it.
const lostNeverLanded = resolved === null && lastReport !== null && ["failed", "still_pending"].includes(lastReport.outcome);
if (lostNeverLanded) {
  outcome.external("reconciliation confirms the landed sandbox transaction", "the facilitator-submitted transaction did not land on the sandbox", lastReport);
} else {
  check("reconciliation confirms the landed sandbox transaction", resolved !== null, { resolved, lastReport });
}

const afterReconcile = await demo({ invocationId: `${run}-lost` });
if (lostNeverLanded) {
  // Product check that still applies: an unresolved/failed uncertain payment is never paid again.
  check("the unlanded lost-response invocation is not paid again", afterReconcile.tx === null, afterReconcile);
  outcome.skip("replay after reconciliation returns the reconciled transaction", "depends on the lost-response transaction landing");
} else {
  check("replay after reconciliation returns the reconciled transaction", afterReconcile.http === 200 && afterReconcile.tx === resolved?.detail, afterReconcile);
}

outcome.finish("Sandbox integration");
