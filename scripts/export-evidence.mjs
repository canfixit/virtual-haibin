// Phase 5A/5B: complete one human-approved purchase (and one semantic
// denial) on the live sandbox stack, then export both EvidenceBundleV1s
// from the authority to ./.evidence/. Runs in the demo-driver container
// (stands in for the human/operator):
//
//   docker compose run --rm -T --user "$(id -u):$(id -g)" \
//     -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" \
//     demo-driver node scripts/export-evidence.mjs
//
// Prints one JSON line: {"allow": "<path>", "deny": "<path>", "transactionId": ...}

import { mkdirSync, writeFileSync } from "node:fs";
import { EXIT_EXTERNAL, isExternalPaymentFailure } from "./lib/outcome.mjs";

import { agentSession } from "./lib/agent-session.mjs";

const AGENT_URL = process.env.AGENT_URL ?? "http://agent:4000";
const APPROVER_URL = process.env.APPROVER_URL ?? "http://approver:4003";
const AUTHORITY_URL = process.env.AUTHORITY_URL ?? "http://authority:4002";
const APPROVER_CODE = process.env.APPROVER_CODE;
const SECRET = process.env.AUTHORITY_SHARED_SECRET;

if (!APPROVER_CODE || !SECRET) {
  console.error("APPROVER_CODE and AUTHORITY_SHARED_SECRET are required.");
  process.exit(2);
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, json: await response.json() };
}

async function exportBundle(invocationId) {
  const response = await fetch(`${AUTHORITY_URL}/evidence/${encodeURIComponent(invocationId)}`, {
    headers: { authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new Error(`export ${invocationId} failed: HTTP ${response.status} ${await response.text()}`);
  const path = `.evidence/${invocationId}.json`;
  writeFileSync(path, await response.text());
  return path;
}

const run = `ev-${Date.now()}`;
const session = await agentSession(AGENT_URL); // permit + purchases are scoped to this agent session
mkdirSync(".evidence", { recursive: true });

const identity = await (await fetch(`${AGENT_URL}/identity`)).json();
const issued = await post(`${APPROVER_URL}/approvals`, { agent: identity.agent, operation: "summarize", datasetId: "dataset-a" }, { authorization: `Bearer ${APPROVER_CODE}` });
if (issued.status !== 201) throw new Error(`approval failed: ${JSON.stringify(issued)}`);
const installed = await post(`${AGENT_URL}/permit`, { permit: issued.json.permit }, session);
if (installed.status !== 200) throw new Error(`install failed: ${JSON.stringify(installed)}`);

const allow = await post(`${AGENT_URL}/demo`, { invocationId: `${run}-summarize-a`, operation: "summarize", datasetId: "dataset-a" }, session);
if (allow.json.authorization?.decision !== "ALLOW") {
  if (isExternalPaymentFailure({ http: allow.status, refusal: allow.json.authority?.reasonCode ?? null })) {
    // Blocked as RECONCILIATION_REQUIRED (or service unavailable); not retried.
    console.error(`EXTERNAL ENVIRONMENT FAILURE: the sandbox purchase did not complete (${allow.json.status}); no evidence to export.`);
    process.exit(EXIT_EXTERNAL);
  }
  throw new Error(`purchase not allowed: ${JSON.stringify(allow.json)}`);
}
const deny = await post(`${AGENT_URL}/demo`, { invocationId: `${run}-export-a`, operation: "export", datasetId: "dataset-a" }, session);
if (deny.json.authorization?.decision !== "DENY") throw new Error(`export not denied: ${JSON.stringify(deny.json)}`);

console.log(
  JSON.stringify({
    allow: await exportBundle(`${run}-summarize-a`),
    deny: await exportBundle(`${run}-export-a`),
    transactionId: allow.json.authorization.payment?.transactionId ?? null,
  }),
);
