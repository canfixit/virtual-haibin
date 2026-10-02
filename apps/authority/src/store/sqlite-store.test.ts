import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION_2,
  type AuthorizationRequestV2,
} from "@virtual-haibin/mandate";
import type { SignedAuthorizationReceiptV1 } from "../receipt.js";
import { SQLITE_SCHEMA_VERSION, SqliteAuthorityStore } from "./sqlite-store.js";
import { InvalidStateTransitionError, type BudgetEvaluator, type ReserveInput } from "./types.js";

const tempDir = mkdtempSync(join(tmpdir(), "vh-authority-store-"));
let fileCounter = 0;

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function tempDbPath(): string {
  fileCounter += 1;
  return join(tempDir, `authority-${fileCounter}.db`);
}

const ISSUER = "Issuer1111111111111111111111111111111111111";

function request(invocationId: string, amountAtomic: string): AuthorizationRequestV2 {
  return {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION_2,
    audience: "test-authority",
    grantId: "grant-1",
    permitDigest: "a".repeat(64),
    invocationId,
    service: "mock-dataset-reports",
    capability: "reports.generate",
    network: "devnet",
    mint: "Mint111111111111111111111111111111111111111",
    recipient: "Recipient11111111111111111111111111111111111",
    amountAtomic,
    issuedAt: 1,
    operation: { method: "POST", resource: "/api/v1/report", operation: "summarize", datasetId: "dataset-a" },
  };
}

function reserveInput(invocationId: string, amountAtomic: string, overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    invocationId,
    fingerprint: `fp-${invocationId}-${amountAtomic}`,
    grant: { issuer: ISSUER, grantId: "grant-1", permitDigest: "a".repeat(64), maxTotalAtomic: "50000" },
    agent: "Agent1111111111111111111111111111111111111",
    request: request(invocationId, amountAtomic),
    amountAtomic,
    decidedAt: 1_000,
    paymentRequirement: null,
    ...overrides,
  };
}

/** Mirrors the policy's total-budget rule; enough to exercise the store. */
function budgetEvaluator(amountAtomic: string, maxTotalAtomic = "50000"): BudgetEvaluator {
  return (committedAtomic) =>
    BigInt(committedAtomic) + BigInt(amountAtomic) <= BigInt(maxTotalAtomic)
      ? { allowed: true }
      : { allowed: false, reasonCodes: ["TOTAL_BUDGET_EXCEEDED"] };
}

const allowAll: BudgetEvaluator = () => ({ allowed: true });

function fakeReceipt(invocationId: string, decision: "ALLOW" | "DENY"): SignedAuthorizationReceiptV1 {
  return {
    version: 1,
    domain: "virtual-haibin/authorization-receipt",
    invocationId,
    grantId: "grant-1",
    authority: "Authority111111111111111111111111111111111",
    agent: "Agent1111111111111111111111111111111111111",
    permitDigest: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    service: "mock-dataset-reports",
    capability: "reports.generate",
    network: "devnet",
    mint: "Mint111111111111111111111111111111111111111",
    recipient: "Recipient11111111111111111111111111111111111",
    amountAtomic: "10000",
    decision,
    reasonCodes: [],
    paymentTransactionId: decision === "ALLOW" ? "tx-1" : null,
    decidedAt: 1_000,
    signature: { algorithm: "ed25519", signature: "sig" },
  };
}

async function grantAmounts(store: SqliteAuthorityStore): Promise<{ reserved: string; consumed: string } | null> {
  const grant = await store.getGrant(ISSUER, "grant-1");
  return grant === null ? null : { reserved: grant.reservedAtomic, consumed: grant.consumedAtomic };
}

test("a new database is migrated to the current schema version", () => {
  const path = tempDbPath();
  const store = new SqliteAuthorityStore(path);
  void store.close();

  const raw = new DatabaseSync(path);
  const { user_version: version } = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  const { journal_mode: journalMode } = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  raw.close();

  assert.equal(version, SQLITE_SCHEMA_VERSION);
  assert.equal(journalMode, "wal");
});

test("a database from a newer schema version is refused rather than misread", () => {
  const path = tempDbPath();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 99");
  raw.close();

  assert.throws(() => new SqliteAuthorityStore(path), /newer than this build supports/);
});

test("invalid persisted state fails closed instead of being reset", async () => {
  // A non-database file: refused, and left byte-for-byte untouched.
  const garbagePath = tempDbPath();
  writeFileSync(garbagePath, "this is not a sqlite database, but it is not ours to overwrite either".repeat(100));
  const before = readFileSync(garbagePath);
  assert.throws(() => new SqliteAuthorityStore(garbagePath));
  assert.deepEqual(readFileSync(garbagePath), before);

  // A database claiming the current schema version but missing its tables:
  // refused rather than silently re-created empty (which would reset budgets
  // and replay state).
  const hollowPath = tempDbPath();
  const hollow = new DatabaseSync(hollowPath);
  hollow.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
  hollow.close();
  assert.throws(() => new SqliteAuthorityStore(hollowPath));

  // Existing tables with an unstamped version: the migration refuses to run
  // over them rather than dropping or replacing state.
  const unstampedPath = tempDbPath();
  const populated = new SqliteAuthorityStore(unstampedPath);
  await populated.reserve(reserveInput("inv-keep", "20000"), allowAll);
  await populated.close();
  const raw = new DatabaseSync(unstampedPath);
  raw.exec("PRAGMA user_version = 0");
  raw.close();
  assert.throws(() => new SqliteAuthorityStore(unstampedPath), /already exists/);
  const check = new DatabaseSync(unstampedPath);
  const { count } = check.prepare("SELECT count(*) AS count FROM invocations").get() as { count: number };
  check.close();
  assert.equal(count, 1);

  // Out-of-band corruption of an amount column is rejected by the schema.
  const constrainedPath = tempDbPath();
  const constrained = new SqliteAuthorityStore(constrainedPath);
  await constrained.reserve(reserveInput("inv-1", "20000"), allowAll);
  await constrained.close();
  const tamper = new DatabaseSync(constrainedPath);
  for (const value of ["-1", "1.5", "abc", "01"]) {
    assert.throws(() => tamper.prepare("UPDATE grants SET consumed_atomic = ?").run(value), /CHECK constraint failed/, value);
  }
  assert.throws(() => tamper.prepare("UPDATE invocations SET state = 'PAID'").run(), /CHECK constraint failed/);
  tamper.close();
});

test("reserve -> confirm moves the amount from reserved to consumed", async () => {
  const store = new SqliteAuthorityStore(":memory:");

  const reserved = await store.reserve(reserveInput("inv-1", "20000"), budgetEvaluator("20000"));
  assert.equal(reserved.kind, "reserved");
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "0" });

  const confirmed = await store.confirm("inv-1", { transactionId: "tx-1", settledAt: 2_000 });
  assert.equal(confirmed.state, "CONFIRMED");
  assert.equal(confirmed.paymentTransactionId, "tx-1");
  assert.deepEqual(await grantAmounts(store), { reserved: "0", consumed: "20000" });
});

test("a denial is recorded durably without changing the budget", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-1", "40000"), budgetEvaluator("40000"));

  const denied = await store.reserve(reserveInput("inv-2", "20000"), budgetEvaluator("20000"));

  assert.equal(denied.kind, "denied");
  if (denied.kind === "denied") {
    assert.equal(denied.invocation.state, "DENIED");
    assert.deepEqual(denied.invocation.reasonCodes, ["TOTAL_BUDGET_EXCEEDED"]);
  }
  assert.deepEqual(await grantAmounts(store), { reserved: "40000", consumed: "0" });
});

test("an existing invocation is returned without evaluating or writing anything", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-1", "20000"), budgetEvaluator("20000"));

  let evaluated = false;
  const again = await store.reserve(reserveInput("inv-1", "30000", { fingerprint: "different" }), () => {
    evaluated = true;
    return { allowed: true };
  });

  assert.equal(again.kind, "existing");
  assert.equal(evaluated, false);
  if (again.kind === "existing") {
    assert.equal(again.invocation.fingerprint, "fp-inv-1-20000");
    assert.equal(again.invocation.amountAtomic, "20000");
  }
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "0" });
});

test("fail releases the reservation, and only the same request may retry a FAILED invocation", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  const input = reserveInput("inv-1", "20000");
  await store.reserve(input, budgetEvaluator("20000"));

  await store.fail("inv-1", "rejected before submission");
  assert.equal((await store.getInvocation("inv-1"))?.state, "FAILED");
  assert.deepEqual(await grantAmounts(store), { reserved: "0", consumed: "0" });

  const different = await store.reserve(reserveInput("inv-1", "10000"), budgetEvaluator("10000"));
  assert.equal(different.kind, "existing");

  const retry = await store.reserve(input, budgetEvaluator("20000"));
  assert.equal(retry.kind, "reserved");
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "0" });
});

test("markReconciliationRequired keeps the reservation held", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-1", "20000"), budgetEvaluator("20000"));

  await store.markReconciliationRequired("inv-1", "timeout after submission");

  const invocation = await store.getInvocation("inv-1");
  assert.equal(invocation?.state, "RECONCILIATION_REQUIRED");
  assert.equal(invocation?.stateReason, "timeout after submission");
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "0" });
});

test("illegal state transitions are refused and leave budgets untouched", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-denied", "60000"), budgetEvaluator("60000"));
  await store.reserve(reserveInput("inv-paid", "20000"), budgetEvaluator("20000"));
  await store.confirm("inv-paid", { transactionId: "tx-1", settledAt: 1 });
  const before = await grantAmounts(store);

  const attempts = [
    () => store.confirm("inv-denied", { transactionId: "tx-x", settledAt: 1 }),
    () => store.confirm("inv-paid", { transactionId: "tx-2", settledAt: 1 }),
    () => store.fail("inv-paid", "x"),
    () => store.markReconciliationRequired("inv-paid", "x"),
    () => store.fail("inv-denied", "x"),
  ];

  for (const attempt of attempts) {
    await assert.rejects(attempt, InvalidStateTransitionError);
  }

  await assert.rejects(() => store.confirm("inv-missing", { transactionId: "tx", settledAt: 1 }), /does not exist/);
  assert.deepEqual(await grantAmounts(store), before);
  assert.equal((await store.getInvocation("inv-paid"))?.paymentTransactionId, "tx-1");
});

test("a grant is pinned to the first permit's digest and total", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-1", "20000"), allowAll);

  for (const grant of [
    { issuer: ISSUER, grantId: "grant-1", permitDigest: "c".repeat(64), maxTotalAtomic: "50000" },
    { issuer: ISSUER, grantId: "grant-1", permitDigest: "a".repeat(64), maxTotalAtomic: "90000" },
  ]) {
    const result = await store.reserve(reserveInput("inv-2", "10000", { grant }), allowAll);
    assert.equal(result.kind, "grant_conflict");
  }

  assert.equal(await store.getInvocation("inv-2"), null);
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "0" });

  // The same grantId under a different issuer is a separate grant.
  const otherIssuer = await store.reserve(
    reserveInput("inv-3", "10000", {
      grant: { issuer: "OtherIssuer11111111111111111111111111111111", grantId: "grant-1", permitDigest: "c".repeat(64), maxTotalAtomic: "50000" },
    }),
    allowAll,
  );
  assert.equal(otherIssuer.kind, "reserved");
});

test("an evaluator error rolls back the whole transaction", async () => {
  const store = new SqliteAuthorityStore(":memory:");

  await assert.rejects(() =>
    store.reserve(reserveInput("inv-1", "20000"), () => {
      throw new Error("evaluator failure");
    }),
  );

  // Not even the grant row from the same transaction survives.
  assert.equal(await store.getGrant(ISSUER, "grant-1"), null);
  assert.equal(await store.getInvocation("inv-1"), null);
});

test("the store refuses to persist a reservation beyond the grant total even if the evaluator allows it", async () => {
  const store = new SqliteAuthorityStore(":memory:");

  await assert.rejects(() => store.reserve(reserveInput("inv-1", "60000"), allowAll), /beyond grant/);
  assert.equal(await store.getInvocation("inv-1"), null);
  assert.equal(await store.getGrant(ISSUER, "grant-1"), null);
});

test("non-canonical amounts are rejected (in code or by database CHECK constraints) and nothing is written", async () => {
  const store = new SqliteAuthorityStore(":memory:");

  for (const amountAtomic of ["01", "1.5", "-1", "", "1e3", "123456789012345678901"]) {
    await assert.rejects(() => store.reserve(reserveInput(`inv-${amountAtomic}`, amountAtomic), budgetEvaluator("0", "0")), amountAtomic);
  }

  assert.equal(await store.getGrant(ISSUER, "grant-1"), null);
});

test("u64-scale amounts are accounted exactly, without floating point or 64-bit signed overflow", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  const max = "18446744073709551615";
  const grant = { issuer: ISSUER, grantId: "grant-1", permitDigest: "a".repeat(64), maxTotalAtomic: max };

  await store.reserve(reserveInput("inv-big", "18446744073709551614", { grant }), allowAll);
  await store.reserve(reserveInput("inv-one", "1", { grant }), allowAll);
  await store.confirm("inv-big", { transactionId: "tx-big", settledAt: 1 });

  assert.deepEqual(await grantAmounts(store), { reserved: "1", consumed: "18446744073709551614" });
  await assert.rejects(() => store.reserve(reserveInput("inv-over", "1", { grant }), allowAll), /beyond grant/);
});

test("the first stored receipt wins and receipts cannot be attached to undecided invocations", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-1", "20000"), allowAll);

  await assert.rejects(() => store.attachReceipt("inv-1", fakeReceipt("inv-1", "ALLOW")), InvalidStateTransitionError);

  await store.confirm("inv-1", { transactionId: "tx-1", settledAt: 1 });
  const first = await store.attachReceipt("inv-1", fakeReceipt("inv-1", "ALLOW"));
  const second = await store.attachReceipt("inv-1", { ...fakeReceipt("inv-1", "ALLOW"), decidedAt: 9_999 });

  assert.deepEqual(second, first);
  assert.equal((await store.getInvocation("inv-1"))?.receipt?.decidedAt, 1_000);
});

test("startup recovery: RESERVED with an attempt -> RECONCILIATION_REQUIRED, without -> released", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-sent", "10000"), allowAll);
  await store.recordPaymentAttempt("inv-sent", {
    protocol: "x402",
    scheme: "exact",
    settlementProfile: "solana-payment-sandbox",
    network: "solana:test",
    payer: "Payer111111111111111111111111111111111111111",
    payerSignature: "sig-sent",
    feePayer: "FeePayer1111111111111111111111111111111111",
    asset: "Mint111111111111111111111111111111111111111",
    payTo: "Recipient11111111111111111111111111111111111",
    amountAtomic: "10000",
    blockhash: "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace1111",
    lastValidBlockHeight: "1000",
    resourceUrl: "http://paid.test/api/v1/report",
    requestSha256: "c".repeat(64),
    preparedAt: 1,
  });
  await store.reserve(reserveInput("inv-unsent", "10000"), allowAll);
  await store.reserve(reserveInput("inv-paid", "10000"), allowAll);
  await store.confirm("inv-paid", { transactionId: "tx-1", settledAt: 1 });
  await store.reserve(reserveInput("inv-denied", "60000"), budgetEvaluator("60000"));
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "10000" });

  assert.deepEqual(await store.recoverInterruptedInvocations("restart"), {
    reconciliationRequired: ["inv-sent"],
    releasedNeverSubmitted: ["inv-unsent"],
  });
  assert.equal((await store.getInvocation("inv-sent"))?.state, "RECONCILIATION_REQUIRED");
  assert.equal((await store.getInvocation("inv-unsent"))?.state, "FAILED");
  assert.equal((await store.getInvocation("inv-paid"))?.state, "CONFIRMED");
  assert.equal((await store.getInvocation("inv-denied"))?.state, "DENIED");
  // Only the possibly-submitted payment keeps its reservation.
  assert.deepEqual(await grantAmounts(store), { reserved: "10000", consumed: "10000" });
  assert.deepEqual(await store.recoverInterruptedInvocations("restart"), { reconciliationRequired: [], releasedNeverSubmitted: [] });

  // A process still in flight on the released row can no longer record an attempt (so it cannot transmit).
  const lateAttempt = { ...(await store.getInvocation("inv-sent"))!.paymentAttempt!, payerSignature: "late" };
  await assert.rejects(() => store.recordPaymentAttempt("inv-unsent", lateAttempt), InvalidStateTransitionError);
});

test("grant, invocation, receipt and transition history survive closing and reopening the database", async () => {
  const path = tempDbPath();
  const first = new SqliteAuthorityStore(path);
  await first.reserve(reserveInput("inv-1", "20000"), allowAll);
  await first.confirm("inv-1", { transactionId: "tx-1", settledAt: 1 });
  await first.attachReceipt("inv-1", fakeReceipt("inv-1", "ALLOW"));
  await first.reserve(reserveInput("inv-2", "10000"), allowAll);
  await first.markReconciliationRequired("inv-2", "timeout");
  await first.close();

  const reopened = new SqliteAuthorityStore(path);
  const invocation = await reopened.getInvocation("inv-1");
  assert.equal(invocation?.state, "CONFIRMED");
  assert.deepEqual(invocation?.receipt, fakeReceipt("inv-1", "ALLOW"));
  assert.deepEqual(invocation?.request, request("inv-1", "20000"));
  assert.equal((await reopened.getInvocation("inv-2"))?.state, "RECONCILIATION_REQUIRED");
  assert.deepEqual(await grantAmounts(reopened), { reserved: "10000", consumed: "20000" });
  await reopened.close();

  const raw = new DatabaseSync(path);
  const transitions = raw
    .prepare("SELECT invocation_id, from_state, to_state FROM invocation_transitions ORDER BY id")
    .all() as Array<{ invocation_id: string; from_state: string | null; to_state: string }>;
  raw.close();

  assert.deepEqual(
    transitions.map((row) => `${row.invocation_id}:${row.from_state ?? "-"}->${row.to_state}`),
    ["inv-1:-->RESERVED", "inv-1:RESERVED->CONFIRMED", "inv-2:-->RESERVED", "inv-2:RESERVED->RECONCILIATION_REQUIRED"],
  );
});

test("concurrent writers on separate connections (threads) never exceed the grant total", async () => {
  const path = tempDbPath();
  // Create the schema once up front so workers only contend on reservations.
  await new SqliteAuthorityStore(path).close();

  const workers = 4;
  const perWorker = 10;
  const amountAtomic = "1000";
  const maxTotalAtomic = "25000"; // room for exactly 25 of the 40 attempts
  const startSignal = new Int32Array(new SharedArrayBuffer(4));

  const results = Array.from(
      { length: workers },
      (_, workerIndex) =>
        new Promise<string[]>((resolve, reject) => {
          const worker = new Worker(new URL("./sqlite-store.concurrency-worker.ts", import.meta.url), {
            execArgv: ["--import", "tsx"],
            workerData: { path, workerIndex, perWorker, amountAtomic, maxTotalAtomic, startSignal },
          });
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
  );

  // Release all workers at once to maximise contention.
  Atomics.store(startSignal, 0, 1);
  Atomics.notify(startSignal, 0);

  const outcomes = (await Promise.all(results)).flat();
  const reserved = outcomes.filter((outcome) => outcome === "reserved").length;
  const denied = outcomes.filter((outcome) => outcome === "denied").length;

  assert.equal(outcomes.length, workers * perWorker);
  assert.equal(reserved, 25);
  assert.equal(denied, 15);

  const store = new SqliteAuthorityStore(path);
  assert.deepEqual(await grantAmounts(store), { reserved: "25000", consumed: "0" });
  await store.close();
});

// ---------------------------------------------------------------------------
// Schema v2: payment evidence and reconciliation (Phase 4)
// ---------------------------------------------------------------------------

function attemptFor(invocationId: string, amountAtomic = "20000") {
  return {
    protocol: "x402" as const,
    scheme: "exact",
    settlementProfile: "solana-payment-sandbox",
    network: "solana:test",
    payer: "Payer111111111111111111111111111111111111111",
    payerSignature: `sig-${invocationId}`,
    feePayer: "FeePayer1111111111111111111111111111111111",
    asset: "Mint111111111111111111111111111111111111111",
    payTo: "Recipient11111111111111111111111111111111111",
    amountAtomic,
    blockhash: "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace1111",
    lastValidBlockHeight: "1000",
    resourceUrl: "http://paid.test/api/v1/report",
    requestSha256: "c".repeat(64),
    preparedAt: 1,
  };
}

const settlementFor = (transactionId: string) => ({ transactionId, slot: "7", facilitatorReportedTransaction: null, confirmedAt: 2 });

test("a v1 database migrates to the current schema atomically and keeps all existing state", async () => {
  const path = tempDbPath();
  const current = new SqliteAuthorityStore(path);
  await current.reserve(reserveInput("inv-old", "20000"), allowAll);
  await current.confirm("inv-old", { transactionId: "tx-old", settledAt: 1 });
  await current.close();

  // Rewind to the Phase 3 (v1) schema.
  const raw = new DatabaseSync(path);
  for (const column of ["payment_requirement_json", "payment_attempt_json", "settlement_json", "result_json", "authorization_json", "service_authorization_json"]) {
    raw.exec(`ALTER TABLE invocations DROP COLUMN ${column}`);
  }
  raw.exec("PRAGMA user_version = 1");
  raw.close();

  const migrated = new SqliteAuthorityStore(path);
  const invocation = await migrated.getInvocation("inv-old");
  assert.equal(invocation?.state, "CONFIRMED");
  assert.equal(invocation?.paymentTransactionId, "tx-old");
  assert.equal(invocation?.paymentAttempt, null);
  assert.equal(invocation?.authorization, null);
  assert.deepEqual(await grantAmounts(migrated), { reserved: "0", consumed: "20000" });
  await migrated.close();

  const check = new DatabaseSync(path);
  const { user_version: version } = check.prepare("PRAGMA user_version").get() as { user_version: number };
  check.close();
  assert.equal(version, SQLITE_SCHEMA_VERSION);
});

test("a v2 database migrates to the current schema; legacy rows have no authorization evidence, new rows keep it", async () => {
  const path = tempDbPath();
  const current = new SqliteAuthorityStore(path);
  await current.reserve(reserveInput("inv-v2", "10000"), allowAll);
  await current.close();

  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE invocations DROP COLUMN authorization_json");
  raw.exec("ALTER TABLE invocations DROP COLUMN service_authorization_json");
  raw.exec("PRAGMA user_version = 2");
  raw.close();

  const migrated = new SqliteAuthorityStore(path);
  assert.equal((await migrated.getInvocation("inv-v2"))?.authorization, null);

  const authorization = {
    permit: { grantId: "grant-1" } as never,
    agentSignature: { algorithm: "ed25519" as const, signature: "sig" },
  };
  await migrated.reserve(reserveInput("inv-v3", "10000", { authorization }), allowAll);
  assert.deepEqual((await migrated.getInvocation("inv-v3"))?.authorization, authorization);
  await migrated.close();
});

test("a payment attempt is recorded once, only while RESERVED", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-1", "20000"), allowAll);

  await store.recordPaymentAttempt("inv-1", attemptFor("inv-1"));
  assert.equal((await store.getInvocation("inv-1"))?.paymentAttempt?.payerSignature, "sig-inv-1");
  await assert.rejects(() => store.recordPaymentAttempt("inv-1", attemptFor("inv-1")), InvalidStateTransitionError);

  await store.reserve(reserveInput("inv-denied", "60000"), budgetEvaluator("60000"));
  await assert.rejects(() => store.recordPaymentAttempt("inv-denied", attemptFor("inv-denied")), InvalidStateTransitionError);
});

test("reconciliation resolves only RECONCILIATION_REQUIRED, consuming or releasing exactly once", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  await store.reserve(reserveInput("inv-landed", "20000"), allowAll);
  await store.recordPaymentAttempt("inv-landed", attemptFor("inv-landed"));
  await store.markReconciliationRequired("inv-landed", "timeout");
  await store.reserve(reserveInput("inv-lost", "10000"), allowAll);
  await store.recordPaymentAttempt("inv-lost", attemptFor("inv-lost", "10000"));
  await store.markReconciliationRequired("inv-lost", "timeout");
  assert.deepEqual(await grantAmounts(store), { reserved: "30000", consumed: "0" });
  assert.deepEqual((await store.listReconciliationRequired()).map((invocation) => invocation.invocationId), ["inv-landed", "inv-lost"]);

  const confirmed = await store.resolveReconciliation("inv-landed", { kind: "confirmed", settlement: settlementFor("tx-late") });
  assert.equal(confirmed.state, "CONFIRMED");
  assert.equal(confirmed.paymentTransactionId, "tx-late");
  await store.resolveReconciliation("inv-lost", { kind: "failed", reason: "expired" });
  assert.equal((await store.getInvocation("inv-lost"))?.state, "FAILED");
  assert.deepEqual(await grantAmounts(store), { reserved: "0", consumed: "20000" });

  // Neither can be resolved twice, and non-RRQ invocations cannot be resolved at all.
  await assert.rejects(() => store.resolveReconciliation("inv-landed", { kind: "confirmed", settlement: settlementFor("tx-x") }), InvalidStateTransitionError);
  await assert.rejects(() => store.resolveReconciliation("inv-lost", { kind: "failed", reason: "x" }), InvalidStateTransitionError);
  assert.deepEqual(await grantAmounts(store), { reserved: "0", consumed: "20000" });
  assert.deepEqual(await store.listReconciliationRequired(), []);
});

test("retrying a FAILED invocation starts a fresh attempt with no stale payment evidence", async () => {
  const store = new SqliteAuthorityStore(":memory:");
  const input = reserveInput("inv-1", "20000");
  await store.reserve(input, allowAll);
  await store.recordPaymentAttempt("inv-1", attemptFor("inv-1"));
  await store.markReconciliationRequired("inv-1", "timeout");
  await store.resolveReconciliation("inv-1", { kind: "failed", reason: "expired" });

  const retry = await store.reserve(input, allowAll);
  assert.equal(retry.kind, "reserved");
  const invocation = await store.getInvocation("inv-1");
  assert.equal(invocation?.paymentAttempt, null);
  assert.equal(invocation?.settlement, null);
  assert.equal(invocation?.paymentTransactionId, null);
  assert.deepEqual(await grantAmounts(store), { reserved: "20000", consumed: "0" });
});
