import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { verifyPurchasePermitV2, type SignedPurchasePermitV2 } from "@virtual-haibin/mandate";
import { parseApprovalRequest, type ApprovalTerms } from "./approve.js";
import { loadOrCreateApprovalCode, loadOrCreateIssuerKey, type IssuerKey } from "./issuer-key.js";
import { createApproverServer, type ApproverLogEntry } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "vh-approver-"));
const agent = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const mint = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const recipient = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const ORIGIN = "http://localhost:5173";
const APPROVAL_CODE = "0123456789abcdef0123456789abcdef";

const terms: ApprovalTerms = {
  service: "mock-dataset-reports",
  capability: "reports.generate",
  network: "solana-payment-sandbox",
  mint,
  recipient,
  maxPerCallAtomic: "20000",
  maxTotalAtomic: "50000",
  ttlMs: 30 * 60 * 1000,
  method: "POST",
  resource: "/api/v1/report",
};

let issuer: IssuerKey;
let baseUrl: string;
const logs: ApproverLogEntry[] = [];
let close: () => Promise<void>;

before(async () => {
  issuer = await loadOrCreateIssuerKey(join(dir, "issuer.key"));
  const server = createApproverServer({ issuer, approvalCode: APPROVAL_CODE, terms, allowedOrigin: ORIGIN, log: (entry) => logs.push(entry) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

after(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

function approve(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${APPROVAL_CODE}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Issuer key custody
// ---------------------------------------------------------------------------

test("the issuer key is created once with mode 0600, persists, and loads as a non-extractable key", async () => {
  const path = join(dir, "persist.key");
  const first = await loadOrCreateIssuerKey(path);
  const second = await loadOrCreateIssuerKey(path);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.address, first.address);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(first.keyPair.privateKey.extractable, false);
});

test("a key file readable by group/other, or of the wrong size, is refused", async () => {
  const loose = join(dir, "loose.key");
  writeFileSync(loose, Buffer.alloc(32, 1));
  chmodSync(loose, 0o644);
  await assert.rejects(loadOrCreateIssuerKey(loose), /group\/other/);

  const short = join(dir, "short.key");
  writeFileSync(short, Buffer.alloc(16, 1), { mode: 0o600 });
  await assert.rejects(loadOrCreateIssuerKey(short), /exactly 32 bytes/);
});

// ---------------------------------------------------------------------------
// Approval -> signed permit
// ---------------------------------------------------------------------------

test("approving summarize(dataset-a) issues a v2 permit that binds exactly that operation", async () => {
  const response = await approve({ agent, operation: "summarize", datasetId: "dataset-a" });
  assert.equal(response.status, 201);
  const { permit } = (await response.json()) as { permit: SignedPurchasePermitV2 };

  const verification = await verifyPurchasePermitV2(permit);
  assert.equal(verification.verified, true);
  assert.equal(permit.issuer, issuer.address);
  assert.equal(permit.authorizedAgent, agent);
  assert.deepEqual(permit.operation, { method: "POST", resource: "/api/v1/report", operation: "summarize", datasetId: "dataset-a" });
  // Payment terms come from the approver's fixed terms, not the requester.
  assert.equal(permit.recipient, recipient);
  assert.equal(permit.mint, mint);
  assert.equal(permit.maxPerCallAtomic, "20000");
  assert.equal(permit.maxTotalAtomic, "50000");
  assert.ok(logs.some((entry) => entry.event === "approver.permit_issued" && entry.grantId === permit.grantId));
});

test("the requester cannot choose payee, asset, limits, resource or extra arguments", async () => {
  for (const extra of [
    { recipient: agent },
    { mint: agent },
    { maxTotalAtomic: "999999999" },
    { resource: "/api/v1/admin" },
    { method: "GET" },
    { format: "full" },
    { issuer: agent },
  ]) {
    const response = await approve({ agent, operation: "summarize", datasetId: "dataset-a", ...extra });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
});

test("invalid approval requests are rejected safely", async () => {
  for (const body of [
    "not json",
    "null",
    "[]",
    { operation: "summarize", datasetId: "dataset-a" },
    { agent: "not-a-key", operation: "summarize", datasetId: "dataset-a" },
    { agent, operation: "delete", datasetId: "dataset-a" },
    { agent, operation: "summarize", datasetId: "../etc" },
  ]) {
    const response = await approve(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const oversized = await approve({ agent, operation: "summarize", datasetId: "dataset-a", pad: "x".repeat(8 * 1024) });
  assert.equal(oversized.status, 413);
});

test("parseApprovalRequest returns only the three human-chosen fields", () => {
  const parsed = parseApprovalRequest({ agent, operation: "export", datasetId: "dataset-b" }, terms);
  assert.deepEqual(parsed, { valid: true, approval: { agent, operation: "export", datasetId: "dataset-b" } });
});

test("no endpoint exposes or accepts issuer key material", async () => {
  const health = await fetch(`${baseUrl}/health`);
  const healthBody = (await health.json()) as { issuer: string };
  assert.equal(healthBody.issuer, issuer.address);

  for (const path of ["/key", "/sign", "/issuer-key", "/permits/sign"]) {
    assert.equal((await fetch(`${baseUrl}${path}`, { method: "POST", body: "{}" })).status, 404, path);
  }

  const issued = await approve({ agent, operation: "summarize", datasetId: "dataset-a" });
  const serialized = JSON.stringify([healthBody, await issued.json(), logs]);
  assert.ok(!/privateKey|secretKey|seed|"d":/.test(serialized));
});

test("CORS is granted only to the configured web origin", async () => {
  const allowed = await approve({ agent, operation: "summarize", datasetId: "dataset-a" }, { origin: ORIGIN });
  assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);

  const other = await approve({ agent, operation: "summarize", datasetId: "dataset-a" }, { origin: "http://evil.example" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("an approval without the human-held approval code issues nothing (network reachability is not authority)", async () => {
  const issuedBefore = logs.filter((entry) => entry.event === "approver.permit_issued").length;

  for (const authorization of ["", "Bearer", "Bearer wrong", `Bearer ${APPROVAL_CODE}x`, `Basic ${APPROVAL_CODE}`, `bearer ${APPROVAL_CODE}`]) {
    const response = await approve({ agent, operation: "export", datasetId: "dataset-a" }, { authorization });
    assert.equal(response.status, 401, authorization);
    assert.equal(((await response.json()) as { reasonCode: string }).reasonCode, "APPROVAL_CODE_REQUIRED");
  }

  assert.equal(logs.filter((entry) => entry.event === "approver.permit_issued").length, issuedBefore);
  // The presented value is never logged.
  assert.ok(!JSON.stringify(logs).includes("wrong"));
});

test("the approval code is created once (0600), persists, and must be 128-bit hex", () => {
  const path = join(dir, "approval-code");
  const first = loadOrCreateApprovalCode(path);
  const second = loadOrCreateApprovalCode(path);
  assert.equal(first.created, true);
  assert.equal(second.code, first.code);
  assert.match(first.code, /^[0-9a-f]{32}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const bad = join(dir, "bad-code");
  writeFileSync(bad, "short", { mode: 0o600 });
  assert.throws(() => loadOrCreateApprovalCode(bad));
});
