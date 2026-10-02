import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import type { PaymentProvider } from "@virtual-haibin/payments";
import {
  AuthorityService,
  GrantPermitConflictError,
  InvocationConflictError,
  InvocationInProgressError,
  PaymentNotSubmittedFailure,
  ReconciliationRequiredError,
} from "./authorize.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import type { AuthorityStore } from "./store/types.js";
import {
  buildSignedPermit,
  committedAtomic,
  CountingPaymentProvider,
  otherRecipientAddress,
  signedInput,
  TEST_AUDIENCE,
  TEST_PAYMENT_CONFIG,
  TimingOutPaymentProvider,
} from "./test-support.js";

// Service-level durability tests: each "process" is a new AuthorityService
// with a *new* authority signing key and a new store connection to the same
// SQLite file, so nothing can survive through in-memory state.

const tempDir = mkdtempSync(join(tmpdir(), "vh-authority-persist-"));
let fileCounter = 0;
const openStores: AuthorityStore[] = [];

after(async () => {
  await Promise.all(openStores.map((store) => store.close()));
  rmSync(tempDir, { recursive: true, force: true });
});

function tempDbPath(): string {
  fileCounter += 1;
  return join(tempDir, `authority-${fileCounter}.db`);
}

type Process = { service: AuthorityService; store: SqliteAuthorityStore; authorityAddress: string };

/** Starts an authority "process" on `path`, running startup recovery like index.ts does. */
async function startProcess(path: string, paymentProvider: PaymentProvider, store?: AuthorityStore): Promise<Process> {
  const authoritySigner = await generateKeyPair();
  const authorityAddress = await getAddressFromPublicKey(authoritySigner.publicKey);
  const sqliteStore = new SqliteAuthorityStore(path);
  openStores.push(sqliteStore);
  const service = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider,
    store: store ?? sqliteStore,
    log: () => {},
  });
  await service.recoverInterruptedInvocations();
  return { service, store: sqliteStore, authorityAddress };
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

test("replay after restart returns the originally stored receipt and pays nothing", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-restart-replay" });

  const first = await startProcess(path, new CountingPaymentProvider());
  const original = await first.service.authorize(input);
  await first.store.close();

  const providerAfterRestart = new CountingPaymentProvider();
  const second = await startProcess(path, providerAfterRestart);
  const replay = await second.service.authorize(await signedInput(permit, { invocationId: "inv-restart-replay" }));

  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, original.receipt);
  // Signed by the *first* process's authority key; still valid evidence.
  assert.equal(replay.receipt.authority, first.authorityAddress);
  assert.notEqual(second.authorityAddress, first.authorityAddress);
  assert.equal(providerAfterRestart.calls.length, 0);
});

test("a denied invocation replays the same denial after restart", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit();

  const first = await startProcess(path, new CountingPaymentProvider());
  const original = await first.service.authorize(await signedInput(permit, { invocationId: "inv-restart-deny", amountAtomic: "100000" }));
  await first.store.close();

  const second = await startProcess(path, new CountingPaymentProvider());
  const replay = await second.service.authorize(await signedInput(permit, { invocationId: "inv-restart-deny", amountAtomic: "100000" }));

  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, original.receipt);
});

test("invocation conflicts are still detected after restart", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit();

  const first = await startProcess(path, new CountingPaymentProvider());
  await first.service.authorize(await signedInput(permit, { invocationId: "inv-restart-conflict", amountAtomic: "10000" }));
  await first.store.close();

  const provider = new CountingPaymentProvider();
  const second = await startProcess(path, provider);
  await assert.rejects(
    second.service.authorize(await signedInput(permit, { invocationId: "inv-restart-conflict", amountAtomic: "15000" })),
    InvocationConflictError,
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(await committedAtomic(second.service, permit), "10000");
});

test("the shared budget survives restart and is exhausted across processes", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "40000" });

  const first = await startProcess(path, new CountingPaymentProvider());
  await first.service.authorize(await signedInput(permit, { invocationId: "inv-budget-1", amountAtomic: "20000" }));
  await first.store.close();

  const provider = new CountingPaymentProvider();
  const second = await startProcess(path, provider);
  const allowed = await second.service.authorize(await signedInput(permit, { invocationId: "inv-budget-2", amountAtomic: "20000" }));
  const denied = await second.service.authorize(await signedInput(permit, { invocationId: "inv-budget-3", amountAtomic: "20000" }));

  assert.equal(allowed.receipt.decision, "ALLOW");
  assert.equal(denied.receipt.decision, "DENY");
  assert.deepEqual(denied.receipt.reasonCodes, ["TOTAL_BUDGET_EXCEEDED"]);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(await second.service.getGrantBudget(permit.issuer, permit.grantId), {
    maxTotalAtomic: "40000",
    reservedAtomic: "0",
    consumedAtomic: "40000",
    remainingAtomic: "0",
  });
});

test("a crash mid-payment becomes RECONCILIATION_REQUIRED on restart and is never paid again", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-crash-1", amountAtomic: "20000" });

  // First process: the payment call never returns (process "dies" mid-send).
  const hanging = new CountingPaymentProvider({ behavior: "hang" });
  const first = await startProcess(path, hanging);
  void first.service.authorize(input).catch(() => {});
  // "Mid-payment": the attempt (and its service authorization) is durably
  // recorded, so the credential may have left. A crash before this point is
  // provably unsent and is released instead (tested separately).
  await waitFor(async () => (await first.store.getInvocation("inv-crash-1"))?.paymentAttempt != null);
  await first.store.close();

  const provider = new CountingPaymentProvider();
  const second = await startProcess(path, provider);

  assert.equal((await second.store.getInvocation("inv-crash-1"))?.state, "RECONCILIATION_REQUIRED");
  assert.equal((await second.store.getInvocation("inv-crash-1"))?.serviceAuthorization?.invocationId, "inv-crash-1");
  await assert.rejects(
    second.service.authorize(await signedInput(permit, { invocationId: "inv-crash-1", amountAtomic: "20000" })),
    ReconciliationRequiredError,
  );
  assert.equal(provider.calls.length, 0);
  // The reservation is still held: the unknown payment counts against the budget.
  assert.equal(await committedAtomic(second.service, permit), "20000");
});

test("an uncertain payment outcome is still blocked after restart", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit();

  const timingOut = new TimingOutPaymentProvider();
  const first = await startProcess(path, timingOut);
  await assert.rejects(first.service.authorize(await signedInput(permit, { invocationId: "inv-timeout-1" })), ReconciliationRequiredError);
  await first.store.close();

  const provider = new CountingPaymentProvider();
  const second = await startProcess(path, provider);
  await assert.rejects(
    second.service.authorize(await signedInput(permit, { invocationId: "inv-timeout-1" })),
    ReconciliationRequiredError,
  );
  assert.equal(timingOut.calls.length, 1);
  assert.equal(provider.calls.length, 0);
});

test("a payment known never to have been submitted releases budget and the same request can retry", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "20000" });
  // First execution fails before transmission; the retry settles.
  const flaky = new CountingPaymentProvider({ behavior: "not_submitted" });

  const { service } = await startProcess(path, flaky);

  await assert.rejects(
    service.authorize(await signedInput(permit, { invocationId: "inv-flaky-1", amountAtomic: "20000" })),
    (error: unknown) => error instanceof PaymentNotSubmittedFailure && error.statusCode === 502,
  );
  assert.equal(await committedAtomic(service, permit), "0");
  flaky.behavior = "settle";

  // A different request under the failed id is a conflict, not a new attempt.
  await assert.rejects(
    service.authorize(await signedInput(permit, { invocationId: "inv-flaky-1", amountAtomic: "10000" })),
    InvocationConflictError,
  );

  const retry = await service.authorize(await signedInput(permit, { invocationId: "inv-flaky-1", amountAtomic: "20000" }));
  assert.equal(retry.receipt.decision, "ALLOW");
  assert.equal(retry.receipt.paymentTransactionId, "mock-tx-2");
  assert.equal(await committedAtomic(service, permit), "20000");
});

test("if a completed payment cannot be recorded, the invocation is blocked instead of paid again", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit();
  const sqliteStore = new SqliteAuthorityStore(path);
  openStores.push(sqliteStore);
  let failConfirm = true;
  const flakyStore: AuthorityStore = {
    reserve: (input, evaluate) => sqliteStore.reserve(input, evaluate),
    confirm: async (invocationId, payment) => {
      if (failConfirm) {
        throw new Error("disk full");
      }
      return sqliteStore.confirm(invocationId, payment);
    },
    recordPaymentAttempt: (invocationId, attempt, authorization) => sqliteStore.recordPaymentAttempt(invocationId, attempt, authorization),
    resolveReconciliation: (invocationId, outcome) => sqliteStore.resolveReconciliation(invocationId, outcome),
    listReconciliationRequired: () => sqliteStore.listReconciliationRequired(),
    fail: (invocationId, reason) => sqliteStore.fail(invocationId, reason),
    markReconciliationRequired: (invocationId, reason) => sqliteStore.markReconciliationRequired(invocationId, reason),
    attachReceipt: (invocationId, receipt) => sqliteStore.attachReceipt(invocationId, receipt),
    getInvocation: (invocationId) => sqliteStore.getInvocation(invocationId),
    getGrant: (issuer, grantId) => sqliteStore.getGrant(issuer, grantId),
    recoverInterruptedInvocations: (reason) => sqliteStore.recoverInterruptedInvocations(reason),
    close: () => sqliteStore.close(),
  };

  const provider = new CountingPaymentProvider();
  const { service } = await startProcess(path, provider, flakyStore);
  const input = await signedInput(permit, { invocationId: "inv-unrecorded-1" });

  await assert.rejects(service.authorize(input), ReconciliationRequiredError);
  failConfirm = false;
  await assert.rejects(service.authorize(await signedInput(permit, { invocationId: "inv-unrecorded-1" })), ReconciliationRequiredError);

  assert.equal(provider.calls.length, 1);
  assert.equal((await sqliteStore.getInvocation("inv-unrecorded-1"))?.state, "RECONCILIATION_REQUIRED");
});

test("a second permit reusing an issuer's grantId with different terms is refused", async () => {
  const path = tempDbPath();
  const original = await buildSignedPermit({ grantId: "VH-GRANT-PINNED", maxTotalAtomic: "50000" });
  const widened = await buildSignedPermit({ grantId: "VH-GRANT-PINNED", maxTotalAtomic: "90000" });
  // Same total, different terms (recipient): must not share the original's budget either.
  const redirected = await buildSignedPermit({ grantId: "VH-GRANT-PINNED", recipient: otherRecipientAddress });
  const provider = new CountingPaymentProvider();
  const { service } = await startProcess(path, provider);

  await service.authorize(await signedInput(original, { invocationId: "inv-grant-a" }));

  for (const [index, permit] of [widened, redirected].entries()) {
    await assert.rejects(
      service.authorize(await signedInput(permit, { invocationId: `inv-grant-b${index}` })),
      (error: unknown) => error instanceof GrantPermitConflictError && error.reasonCode === "GRANT_PERMIT_CONFLICT",
    );
  }

  assert.equal(provider.calls.length, 1);
  assert.equal(await committedAtomic(service, original), "10000");
});

test("two authority processes sharing the database cannot overspend a grant or double-pay an invocation", async () => {
  const path = tempDbPath();
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "50000" });
  const providerA = new CountingPaymentProvider();
  const providerB = new CountingPaymentProvider();
  const a = await startProcess(path, providerA);
  const b = await startProcess(path, providerB);

  // Different invocations, split across both processes, racing for 50000.
  const inputs = await Promise.all(
    Array.from({ length: 6 }, (_, index) => signedInput(permit, { invocationId: `inv-shared-${index}`, amountAtomic: "20000" })),
  );
  const results = await Promise.all(inputs.map((input, index) => (index % 2 === 0 ? a : b).service.authorize(input)));

  assert.equal(results.filter((result) => result.receipt.decision === "ALLOW").length, 2);
  assert.equal(providerA.calls.length + providerB.calls.length, 2);
  assert.equal(await committedAtomic(a.service, permit), "40000");

  // The same invocation sent to both processes at once is paid at most once.
  const permit2 = await buildSignedPermit();
  const same = await signedInput(permit2, { invocationId: "inv-shared-same" });
  const settled = await Promise.allSettled([a.service.authorize(same), b.service.authorize(same)]);
  const callsForSame = [...providerA.calls, ...providerB.calls].filter((call) => call.reference === "inv-shared-same");

  assert.equal(callsForSame.length, 1);
  for (const outcome of settled) {
    assert.ok(
      outcome.status === "fulfilled" || outcome.reason instanceof InvocationInProgressError,
      `unexpected outcome ${outcome.status === "rejected" ? String(outcome.reason) : "fulfilled"}`,
    );
  }
});
