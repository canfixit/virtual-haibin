import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { PURCHASE_PERMIT_DOMAIN, PURCHASE_PERMIT_VERSION_2, signPurchasePermitV2, type SignedPurchasePermitV2 } from "@virtual-haibin/mandate";
import { createAgentServer } from "./server.js";
import { SessionStore } from "./sessions.js";

// Session-scoped access control of the agent API. The service and authority
// are faked so every test can assert which upstream calls did (or did not)
// happen -- in particular that refused requests never reach the authority.

const SHARED_SECRET = "authority-shared-secret-for-tests-only-0123456789";
const SERVICE = "http://service.test";
const AUTHORITY = "http://authority.test";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "6hqZufQGmDeGCHtiSNnGT246hdpdBUZTUzgKbonDXSTb";

const agentIdentity = await generateKeyPair();
const agentAddress = await getAddressFromPublicKey(agentIdentity.publicKey);
const issuer = await generateKeyPair();
const issuerAddress = await getAddressFromPublicKey(issuer.publicKey);

async function permitFor(grantId: string): Promise<SignedPurchasePermitV2> {
  const now = Date.now();
  return signPurchasePermitV2(
    {
      version: PURCHASE_PERMIT_VERSION_2,
      domain: PURCHASE_PERMIT_DOMAIN,
      grantId,
      issuer: issuerAddress,
      authorizedAgent: agentAddress,
      service: "mock-dataset-reports",
      capability: "reports.generate",
      network: "solana-payment-sandbox",
      mint: MINT,
      recipient: PAY_TO,
      maxPerCallAtomic: "20000",
      maxTotalAtomic: "50000",
      issuedAt: now,
      expiresAt: now + 30 * 60 * 1000,
      subdelegation: false,
      operation: { method: "POST", resource: "/api/v1/report", operation: "summarize", datasetId: "dataset-a" },
    },
    issuer,
  );
}

// ---- fake upstreams --------------------------------------------------------

const calls = { authorize: 0, evidence: 0, quote: 0, outboundAuthHeaders: [] as Array<{ url: string; authorization: string | null }> };
const fingerprints = new Map<string, string>(); // invocationId -> permitDigest (authority's conflict rule)

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
  const url = String(input);
  calls.outboundAuthHeaders.push({ url, authorization: new Headers(init?.headers).get("authorization") });

  if (url === `${SERVICE}/quote`) {
    calls.quote += 1;
    return json(200, { quoteId: "q", service: "mock-dataset-reports", capability: "reports.generate", method: "POST", resource: "/api/v1/report", network: "solana-payment-sandbox", mint: MINT, recipient: PAY_TO, amountAtomic: "10000" });
  }

  if (url === `${SERVICE}/__demo/scenario`) {
    return json(200, { ok: true });
  }

  if (url === `${AUTHORITY}/authorize`) {
    calls.authorize += 1;
    const body = JSON.parse(String(init?.body)) as { authorizationRequest: { invocationId: string; permitDigest: string; operation: { operation: string } } };
    const { invocationId, permitDigest, operation } = body.authorizationRequest;
    const known = fingerprints.get(invocationId);

    if (known !== undefined && known !== permitDigest) {
      return json(409, { reasonCode: "INVOCATION_CONFLICT" });
    }

    fingerprints.set(invocationId, permitDigest);
    const allow = operation.operation === "summarize";
    return json(200, {
      decision: allow ? "ALLOW" : "DENY",
      replay: known !== undefined,
      receipt: { decision: allow ? "ALLOW" : "DENY", reasonCodes: allow ? [] : ["OPERATION_NOT_AUTHORIZED"] },
      payment: allow ? { transactionId: `tx-${invocationId}` } : null,
      result: allow ? { received: operation } : null,
    });
  }

  if (url.startsWith(`${AUTHORITY}/evidence/`)) {
    calls.evidence += 1;
    return json(200, { evidenceFor: decodeURIComponent(url.slice(`${AUTHORITY}/evidence/`.length)) });
  }

  throw new Error(`unexpected upstream ${url}`);
}) as typeof fetch;

// ---- server ----------------------------------------------------------------

let clock = Date.now();
const sessions = new SessionStore({ ttlMs: 60_000, maxSessions: 5, maxInvocationsPerSession: 3, now: () => clock });
let server: Server;
let base: string;

before(async () => {
  server = createAgentServer({
    agentIdentity,
    agentAddress,
    serviceAgentUrl: SERVICE,
    authorityUrl: AUTHORITY,
    authoritySharedSecret: SHARED_SECRET,
    authorityAudience: "test-authority",
    allowedOrigin: "http://localhost:5173",
    sessions,
    fetchImpl: fakeFetch,
    now: () => clock,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  calls.authorize = 0;
  calls.evidence = 0;
  calls.quote = 0;
  calls.outboundAuthHeaders.length = 0;
});

async function newSession(): Promise<string> {
  const response = await fetch(`${base}/session`, { method: "POST" });
  assert.equal(response.status, 201);
  return ((await response.json()) as { token: string }).token;
}

const auth = (token: string | null) => (token === null ? {} : { authorization: `Bearer ${token}` });

const install = async (token: string, permit: SignedPurchasePermitV2) =>
  fetch(`${base}/permit`, { method: "POST", headers: { "content-type": "application/json", ...auth(token) }, body: JSON.stringify({ permit }) });

const demo = async (token: string | null, body: Record<string, unknown>) => {
  const response = await fetch(`${base}/demo`, { method: "POST", headers: { "content-type": "application/json", ...auth(token) }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const evidence = async (token: string | null, invocationId: string) => {
  const response = await fetch(`${base}/evidence/${encodeURIComponent(invocationId)}`, { headers: auth(token) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** A session with its own permit and one completed (ALLOW) purchase. */
async function sessionWithPurchase(grantId: string, invocationId: string) {
  const token = await newSession();
  assert.equal((await install(token, await permitFor(grantId))).status, 200);
  const result = await demo(token, { invocationId, operation: "summarize", datasetId: "dataset-a" });
  assert.equal(result.body.authorization?.decision, "ALLOW");
  return token;
}

// ---- tests -----------------------------------------------------------------

test("session tokens are 256-bit, unique per session, and not the authority secret", async () => {
  const a = await newSession();
  const b = await newSession();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.notEqual(a, SHARED_SECRET);
});

test("requests without a valid session capability are denied before any upstream call", async () => {
  for (const token of [null, "not-a-token", "A".repeat(43), SHARED_SECRET]) {
    assert.equal((await fetch(`${base}/permit`, { headers: auth(token) })).status, 401);
    assert.equal((await install(token ?? "", await permitFor("g-noauth"))).status, 401);
    const purchase = await demo(token, { operation: "summarize", datasetId: "dataset-a" });
    assert.equal(purchase.status, 401);
    assert.equal(purchase.body.reasonCode, "SESSION_REQUIRED");
    assert.equal((await evidence(token, "inv-x")).status, 401);
  }
  assert.equal(calls.authorize + calls.evidence + calls.quote, 0);
});

test("own-session evidence retrieval succeeds, and retrieving it triggers no payment", async () => {
  const token = await sessionWithPurchase("g-own", "inv-own-1");
  const authorizeCallsAfterPurchase = calls.authorize;

  for (let i = 0; i < 3; i += 1) {
    const result = await evidence(token, "inv-own-1");
    assert.equal(result.status, 200);
    assert.equal(result.body.evidenceFor, "inv-own-1");
  }

  assert.equal(calls.evidence, 3);
  assert.equal(calls.authorize, authorizeCallsAfterPurchase, "evidence retrieval must never reach /authorize");
});

test("unknown invocation IDs are denied without contacting the authority", async () => {
  const token = await newSession();
  for (const id of ["inv-unknown", "ev-1791016812134-summarize-a"]) {
    const result = await evidence(token, id);
    assert.equal(result.status, 404);
    assert.equal(result.body.reasonCode, "EVIDENCE_NOT_AVAILABLE");
  }
  assert.equal(calls.evidence, 0);
});

test("another session's invocation evidence is denied (same answer as unknown) without contacting the authority", async () => {
  await sessionWithPurchase("g-victim", "inv-victim-1");
  const attacker = await newSession();
  calls.evidence = 0;

  const result = await evidence(attacker, "inv-victim-1");
  assert.equal(result.status, 404);
  assert.equal(result.body.reasonCode, "EVIDENCE_NOT_AVAILABLE");
  assert.equal(calls.evidence, 0);
});

test("another session cannot purchase with someone else's installed permit, nor read it", async () => {
  await sessionWithPurchase("g-owner", "inv-owner-1");
  const other = await newSession();
  calls.authorize = 0;

  const purchase = await demo(other, { operation: "summarize", datasetId: "dataset-a" });
  assert.equal(purchase.status, 409);
  assert.equal(purchase.body.status, "NO_PERMIT");
  assert.equal(calls.authorize, 0);

  assert.equal((await fetch(`${base}/permit`, { headers: auth(other) })).status, 404);
});

test("a fresh session gets no access to existing purchases: it can neither reuse nor read their invocation IDs", async () => {
  await sessionWithPurchase("g-existing", "inv-existing-1");
  const fresh = await newSession();
  assert.equal((await install(fresh, await permitFor("g-fresh"))).status, 200);
  calls.authorize = 0;
  calls.evidence = 0;

  const reuse = await demo(fresh, { invocationId: "inv-existing-1", operation: "summarize", datasetId: "dataset-a" });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.reasonCode, "INVOCATION_NOT_AVAILABLE");
  assert.equal(calls.authorize, 0, "the claim is refused before the authority is contacted");
  assert.equal((await evidence(fresh, "inv-existing-1")).status, 404);
  assert.equal(calls.evidence, 0);
});

test("the semantic ALLOW/DENY flow still works inside a session, with per-session audit only", async () => {
  const token = await newSession();
  await install(token, await permitFor("g-semantic"));

  const allow = await demo(token, { invocationId: "inv-sem-allow", operation: "summarize", datasetId: "dataset-a" });
  const deny = await demo(token, { invocationId: "inv-sem-deny", operation: "export", datasetId: "dataset-a" });
  assert.equal(allow.status, 200);
  assert.equal(allow.body.authorization.decision, "ALLOW");
  assert.equal(deny.status, 403);
  assert.deepEqual(deny.body.authorization.receipt.reasonCodes, ["OPERATION_NOT_AUTHORIZED"]);

  // Both of the session's own decided invocations are readable; the audit
  // trail lists only this session's invocations.
  assert.equal((await evidence(token, "inv-sem-deny")).status, 200);
  const audited = new Set((deny.body.audit as Array<{ data: { invocationId?: string } }>).map((entry) => entry.data.invocationId).filter(Boolean));
  assert.deepEqual([...audited].sort(), ["inv-sem-allow", "inv-sem-deny"]);
});

test("a session never gains evidence access by claiming an ID it was refused on", async () => {
  // Simulate an ID already decided at the authority under ANOTHER permit
  // (e.g. its owning session expired): the claim succeeds locally, the
  // authority refuses the conflicting fingerprint, so evidence stays closed.
  fingerprints.set("inv-orphan", "f".repeat(64));
  const token = await newSession();
  await install(token, await permitFor("g-orphan"));
  const attempt = await demo(token, { invocationId: "inv-orphan", operation: "summarize", datasetId: "dataset-a" });
  assert.equal(attempt.body.status, "INVOCATION_CONFLICT");
  calls.evidence = 0;
  assert.equal((await evidence(token, "inv-orphan")).status, 404);
  assert.equal(calls.evidence, 0);
});

test("sessions expire, are bounded, and an ended session's invocations are retired, not released", async () => {
  const token = await sessionWithPurchase("g-expiring", "inv-expiring-1");
  clock += 61_000; // past the 60 s TTL

  assert.equal((await evidence(token, "inv-expiring-1")).status, 401);
  assert.equal((await demo(token, { operation: "summarize", datasetId: "dataset-a" })).status, 401);

  const next = await newSession();
  await install(next, await permitFor("g-next"));
  const reclaim = await demo(next, { invocationId: "inv-expiring-1", operation: "summarize", datasetId: "dataset-a" });
  assert.equal(reclaim.body.reasonCode, "INVOCATION_NOT_AVAILABLE");

  for (let i = 0; i < 10; i += 1) await newSession();
  assert.ok(sessions.size <= 5);
});

test("per-session invocation claims are bounded", async () => {
  const token = await newSession();
  await install(token, await permitFor("g-bounded"));
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await demo(token, { invocationId: `inv-bound-${i}`, operation: "summarize", datasetId: "dataset-a" })).status, 200);
  }
  assert.equal((await demo(token, { invocationId: "inv-bound-3", operation: "summarize", datasetId: "dataset-a" })).status, 429);
});

test("the authority secret is only ever sent to the authority, and never returned to clients", async () => {
  const token = await sessionWithPurchase("g-secret", "inv-secret-1");
  const responses = [
    await (await fetch(`${base}/session`, { method: "POST" })).text(),
    await (await fetch(`${base}/permit`, { headers: auth(token) })).text(),
    JSON.stringify((await demo(token, { invocationId: "inv-secret-2", operation: "export", datasetId: "dataset-a" })).body),
    JSON.stringify((await evidence(token, "inv-secret-1")).body),
  ];

  for (const text of responses) {
    assert.ok(!text.includes(SHARED_SECRET), "bearer secret leaked to a client");
  }

  for (const { url, authorization } of calls.outboundAuthHeaders) {
    if (authorization !== null) {
      assert.ok(url.startsWith(AUTHORITY), `secret sent to ${url}`);
      assert.notEqual(authorization, `Bearer ${token}`, "session tokens are never forwarded upstream");
    }
  }
});
