// PHASE 4.5 LIVE DEMO -- same payment terms, different business operation.
//
// Runs against the live Compose stack on the Pay.sh Solana Payment Sandbox
// (no real funds), from the demo-driver container, which stands in for the
// human's browser (it can reach the approver; the agent cannot):
//
//   docker compose run --rm \
//     -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" \
//     demo-driver node scripts/semantic-demo.mjs
//
// Prints one structured JSON object per step (for the judge demo) and exits
// non-zero if any expectation fails.

const AGENT_URL = process.env.AGENT_URL ?? "http://agent:4000";
const APPROVER_URL = process.env.APPROVER_URL ?? "http://approver:4003";
// The human's approval code (from the approver's private volume), supplied by the operator.
const APPROVER_CODE = process.env.APPROVER_CODE;

if (!APPROVER_CODE) {
  console.error('APPROVER_CODE is required: docker compose run --rm -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" demo-driver ...');
  process.exit(2);
}
const SERVICE_URL = process.env.SERVICE_URL ?? "http://service-agent:4001";

let failures = 0;
const transcript = [];

function expect(step, name, condition) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL [${step}] ${name}`);
  }
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { httpStatus: response.status, json: await response.json() };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return { httpStatus: response.status, json: await response.json() };
}

function record(entry) {
  transcript.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}

/** Agent /demo call, reduced to what the judge needs to see. */
async function agentRequest(step, invocationId, operation, datasetId) {
  const { httpStatus, json } = await postJson(`${AGENT_URL}/demo`, { invocationId, operation, datasetId });
  const authorization = json.authorization ?? null;
  const payment = authorization?.payment ?? null;
  const entry = {
    step,
    invocationId,
    requested: json.operation ?? { operation, datasetId },
    quotedTerms: json.quote
      ? { service: json.quote.service, payTo: json.quote.recipient, asset: json.quote.mint, amountAtomic: json.quote.amountAtomic, network: json.quote.network }
      : null,
    httpStatus,
    agentStatus: json.status,
    decision: authorization?.decision ?? null,
    reasonCodes: authorization?.receipt?.reasonCodes ?? (json.authority?.reasonCode ? [json.authority.reasonCode] : []),
    replay: authorization?.replay ?? null,
    payment: {
      submitted: Boolean(payment?.payerSignature),
      transactionId: payment?.transactionId ?? null,
      payTo: payment?.payTo ?? null,
      asset: payment?.asset ?? null,
      amountAtomic: payment?.amountAtomic ?? null,
      settlementProfile: payment?.settlementProfile ?? null,
      requestSha256: payment?.requestSha256 ?? null,
    },
    serviceReceived: authorization?.result?.received ?? null,
    receipt: authorization?.receipt
      ? {
          version: authorization.receipt.version,
          operation: authorization.receipt.operation ?? null,
          operationDigest: authorization.receipt.operationDigest ?? null,
          permitDigest: authorization.receipt.permitDigest,
          authority: authorization.receipt.authority,
        }
      : null,
  };
  record(entry);
  return entry;
}

const run = `p45-${Date.now()}`;

// 0. Identities and the merchant's quote (identical for every operation).
const { json: identity } = await getJson(`${AGENT_URL}/identity`);
const { json: approverHealth } = await getJson(`${APPROVER_URL}/health`);
const { json: quote } = await getJson(`${SERVICE_URL}/quote`);
record({
  step: "SETUP",
  agent: identity.agent,
  humanIssuer: approverHealth.issuer,
  merchantQuote: {
    service: quote.service,
    method: quote.method,
    resource: quote.resource,
    operations: quote.operations,
    payTo: quote.recipient,
    asset: quote.mint,
    amountAtomic: quote.amountAtomic,
    network: quote.network,
    note: quote.display?.note,
  },
});

// 1. APPROVE: the human approves summarize(dataset-a) outside the agent runtime.
const issued = await postJson(
  `${APPROVER_URL}/approvals`,
  { agent: identity.agent, operation: "summarize", datasetId: "dataset-a" },
  { authorization: `Bearer ${APPROVER_CODE}` },
);
expect("APPROVE", "approver issued a permit", issued.httpStatus === 201);
const permit = issued.json.permit;
const installed = await postJson(`${AGENT_URL}/permit`, { permit });
expect("APPROVE", "agent installed the signed permit", installed.httpStatus === 200);
record({
  step: "APPROVE",
  grantId: permit.grantId,
  issuer: permit.issuer,
  authorizedAgent: permit.authorizedAgent,
  approvedOperation: permit.operation,
  payTo: permit.recipient,
  asset: permit.mint,
  maxPerCallAtomic: permit.maxPerCallAtomic,
  maxTotalAtomic: permit.maxTotalAtomic,
  expiresAt: new Date(permit.expiresAt).toISOString(),
  agentReceived: installed.json,
});

// 2. ALLOW: the approved operation is paid on the sandbox.
const allow = await agentRequest("ALLOW", `${run}-summarize-a`, "summarize", "dataset-a");
expect("ALLOW", "decision ALLOW", allow.decision === "ALLOW");
expect("ALLOW", "sandbox settlement", typeof allow.payment.transactionId === "string");
expect("ALLOW", "service received exactly summarize(dataset-a)", allow.serviceReceived?.operation === "summarize" && allow.serviceReceived?.datasetId === "dataset-a");

// 3. SEMANTIC DENY: fresh invocation, same terms, unapproved operation.
const exportDeny = await agentRequest("SEMANTIC_DENY", `${run}-export-a`, "export", "dataset-a");
expect("SEMANTIC_DENY", "decision DENY", exportDeny.decision === "DENY");
expect("SEMANTIC_DENY", "only OPERATION_NOT_AUTHORIZED", JSON.stringify(exportDeny.reasonCodes) === JSON.stringify(["OPERATION_NOT_AUTHORIZED"]));
expect("SEMANTIC_DENY", "no payment", exportDeny.payment.submitted === false && exportDeny.payment.transactionId === null);

// 4. ARGUMENT DENY: fresh invocation, same terms, approved verb on another dataset.
const argumentDeny = await agentRequest("ARGUMENT_DENY", `${run}-summarize-b`, "summarize", "dataset-b");
expect("ARGUMENT_DENY", "decision DENY", argumentDeny.decision === "DENY");
expect("ARGUMENT_DENY", "only OPERATION_ARGUMENT_NOT_AUTHORIZED", JSON.stringify(argumentDeny.reasonCodes) === JSON.stringify(["OPERATION_ARGUMENT_NOT_AUTHORIZED"]));
expect("ARGUMENT_DENY", "no payment", argumentDeny.payment.submitted === false && argumentDeny.payment.transactionId === null);

// Identical payment terms across all three requests.
for (const entry of [exportDeny, argumentDeny]) {
  expect(entry.step, "same quoted terms as ALLOW", JSON.stringify(entry.quotedTerms) === JSON.stringify(allow.quotedTerms));
}

// 5. REPLAY: the allowed invocation again -> original result, no second payment.
const replay = await agentRequest("REPLAY", `${run}-summarize-a`, "summarize", "dataset-a");
expect("REPLAY", "replay flag", replay.replay === true);
expect("REPLAY", "same transaction", replay.payment.transactionId === allow.payment.transactionId);

record({
  step: "SUMMARY",
  sameTermsForAllRequests: allow.quotedTerms,
  results: transcript
    .filter((entry) => ["ALLOW", "SEMANTIC_DENY", "ARGUMENT_DENY", "REPLAY"].includes(entry.step))
    .map((entry) => ({
      step: entry.step,
      requested: `${entry.requested.operation}(${entry.requested.datasetId})`,
      decision: entry.decision,
      reasonCodes: entry.reasonCodes,
      paid: entry.payment.transactionId,
      replay: entry.replay,
    })),
  failures,
});

process.exit(failures === 0 ? 0 : 1);
