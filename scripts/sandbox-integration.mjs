// EXTERNAL INTEGRATION TEST -- Pay.sh Solana Payment Sandbox.
//
// Drives the running Compose stack end to end against the real hosted sandbox
// (https://402.surfnet.dev:8899; no real funds). Run inside the agent
// container so service names resolve:
//
//   docker compose exec -T agent node scripts/sandbox-integration.mjs
//
// Exits non-zero on any failed assertion. Sandbox *availability* is checked
// separately (CI preflight) so an outage is reported as such, not hidden.

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:4000";
const AUTHORITY_URL = process.env.AUTHORITY_URL ?? "http://authority:4002";
const SECRET = process.env.AUTHORITY_SHARED_SECRET;

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}: ${JSON.stringify(detail)}`);
  }
}

async function demo(body) {
  const response = await fetch(`${AGENT_URL}/demo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  };
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

// Case 1: ALLOW -> real sandbox settlement + paid result.
const allow = await demo({ invocationId: `${run}-allow` });
check("ALLOW settles on the sandbox and returns the paid result", allow.http === 200 && allow.decision === "ALLOW" && typeof allow.tx === "string" && allow.result !== null, allow);

// Case 4: replay -> same stored result, no new settlement.
const replay = await demo({ invocationId: `${run}-allow` });
check("replay returns the same transaction without paying again", replay.http === 200 && replay.replay === true && replay.tx === allow.tx, replay);

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
for (let attempt = 0; attempt < 12 && resolved === null; attempt += 1) {
  const reports = await reconcile();
  resolved = reports.find((report) => report.invocationId === `${run}-lost` && report.outcome === "confirmed") ?? null;
  if (resolved === null) await new Promise((resolve) => setTimeout(resolve, 5_000));
}
check("reconciliation confirms the landed sandbox transaction", resolved !== null, resolved);

const afterReconcile = await demo({ invocationId: `${run}-lost` });
check("replay after reconciliation returns the reconciled transaction", afterReconcile.http === 200 && afterReconcile.tx === resolved?.detail, afterReconcile);

if (failures > 0) {
  console.log(`\n${failures} integration check(s) FAILED`);
  process.exit(1);
}

console.log("\nAll sandbox integration checks passed.");
