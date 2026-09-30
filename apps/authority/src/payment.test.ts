import assert from "node:assert/strict";
import { test } from "node:test";
import { PaymentNotSubmittedError, type PaymentAttempt, type PaymentProvider } from "@virtual-haibin/payments";
import {
  AuthorityService,
  InvocationConflictError,
  PaidServiceUnavailableFailure,
  PaymentNotSubmittedFailure,
  ReconciliationRequiredError,
} from "./authorize.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import type { AuthorityStore } from "./store/types.js";
import {
  authorityAddress,
  authoritySigner,
  buildSignedPermit,
  committedAtomic,
  CountingPaymentProvider,
  otherRecipientAddress,
  signedInput,
  TEST_AUDIENCE,
  TEST_PAYMENT_CONFIG,
  TimingOutPaymentProvider,
  type CountingPaymentProviderOptions,
} from "./test-support.js";

// Phase 4: the authority validates the service's real 402 challenge against
// the settlement profile, the signed request and the permit *before* the
// payment signer is invoked, and reconciles unknown outcomes read-only.

const attemptTemplate: PaymentAttempt = {
  protocol: "x402",
  scheme: "exact",
  settlementProfile: "solana-payment-sandbox",
  network: "solana:test-sandbox",
  payer: "MockPayer1111111111111111111111111111111111",
  payerSignature: "paused-sig",
  feePayer: "MockFeePayer111111111111111111111111111111",
  asset: "",
  payTo: "",
  amountAtomic: "10000",
  blockhash: "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace1111",
  lastValidBlockHeight: "1000",
  resourceUrl: "http://paid.test/api/v1/research",
  preparedAt: 1,
};

function setup(provider: CountingPaymentProvider = new CountingPaymentProvider()) {
  const store = new SqliteAuthorityStore(":memory:");
  const service = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider: provider,
    store,
    log: () => {},
  });
  return { provider, store, service };
}

async function budget(service: AuthorityService, permit: { issuer: string; grantId: string }) {
  return service.getGrantBudget(permit.issuer, permit.grantId);
}

test("challenge-level denials never invoke the payment signer", async () => {
  const cases: Array<{ name: string; terms: NonNullable<CountingPaymentProviderOptions["terms"]>; expect: string[] }> = [
    { name: "wrong recipient (payTo)", terms: { payTo: otherRecipientAddress }, expect: ["CHALLENGE_REQUEST_MISMATCH", "RECIPIENT_MISMATCH"] },
    { name: "wrong network", terms: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, expect: ["CHALLENGE_NETWORK_MISMATCH"] },
    { name: "wrong asset/mint", terms: { asset: otherRecipientAddress }, expect: ["ASSET_NOT_ALLOWED", "CHALLENGE_REQUEST_MISMATCH", "MINT_MISMATCH"] },
    { name: "per-call overcharge", terms: { amountAtomic: "1000000" }, expect: ["CHALLENGE_REQUEST_MISMATCH", "PER_CALL_LIMIT_EXCEEDED", "TOTAL_BUDGET_EXCEEDED"] },
    { name: "unsupported scheme", terms: { scheme: "upto" }, expect: ["UNSUPPORTED_PAYMENT_SCHEME"] },
    { name: "resource substitution", terms: { resourceUrl: "http://169.254.169.254/" }, expect: ["CHALLENGE_RESOURCE_MISMATCH"] },
    { name: "missing fee payer", terms: { feePayer: null }, expect: ["CHALLENGE_FEE_PAYER_INVALID"] },
    { name: "payer as fee payer", terms: { feePayer: "MockPayer1111111111111111111111111111111111" }, expect: ["CHALLENGE_FEE_PAYER_INVALID"] },
  ];

  for (const [index, { name, terms, expect }] of cases.entries()) {
    const { provider, service } = setup(new CountingPaymentProvider({ terms }));
    const permit = await buildSignedPermit();
    const result = await service.authorize(await signedInput(permit, { invocationId: `inv-deny-${index}` }));

    assert.equal(result.receipt.decision, "DENY", name);
    assert.deepEqual([...result.receipt.reasonCodes].sort(), [...expect].sort(), name);
    assert.equal(provider.calls.length, 0, `${name}: payment signer must not be called`);
    assert.equal(provider.challengesFetched.length, 1, name);
    assert.equal(result.payment?.transactionId ?? null, null, name);
    assert.equal(await committedAtomic(service, permit), "0", name);
  }
});

test("a challenge that is affordable per call but exceeds the remaining total budget is denied", async () => {
  const { provider, service } = setup();
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "30000" });

  assert.equal((await service.authorize(await signedInput(permit, { invocationId: "inv-tb-1", amountAtomic: "20000" }))).receipt.decision, "ALLOW");
  const second = await service.authorize(await signedInput(permit, { invocationId: "inv-tb-2", amountAtomic: "20000" }));

  assert.equal(second.receipt.decision, "DENY");
  assert.deepEqual(second.receipt.reasonCodes, ["TOTAL_BUDGET_EXCEEDED"]);
  assert.equal(provider.calls.length, 1);
});

test("malformed or rejected challenges fail closed", async () => {
  for (const reasonCode of ["CHALLENGE_MALFORMED", "CHALLENGE_REDIRECT", "CHALLENGE_NOT_PAYMENT_REQUIRED", "UNSUPPORTED_PAYMENT_PROTOCOL"] as const) {
    const provider = new CountingPaymentProvider();
    // Replace the honest merchant with one returning a rejected challenge.
    Object.defineProperty(provider, "fetchChallenge", {
      value: async () => ({ kind: "rejected", reasonCode, message: "test" }),
    });
    const { service } = setup(provider);
    const permit = await buildSignedPermit();
    const result = await service.authorize(await signedInput(permit, { invocationId: `inv-${reasonCode}` }));

    assert.equal(result.receipt.decision, "DENY");
    assert.deepEqual(result.receipt.reasonCodes, [reasonCode]);
    assert.equal(provider.calls.length, 0);
  }
});

test("an unreachable paid service is a retryable 502 that leaves no state", async () => {
  let available = false;
  const provider = new CountingPaymentProvider();
  const honest = provider.fetchChallenge.bind(provider);
  Object.defineProperty(provider, "fetchChallenge", {
    value: async (...args: Parameters<typeof honest>) => {
      if (!available) {
        const { PaidServiceUnavailableError } = await import("@virtual-haibin/payments");
        throw new PaidServiceUnavailableError("connection refused");
      }
      return honest(...args);
    },
  });
  const { store, service } = setup(provider);
  const permit = await buildSignedPermit();

  await assert.rejects(
    service.authorize(await signedInput(permit, { invocationId: "inv-unavail-1" })),
    (error: unknown) => error instanceof PaidServiceUnavailableFailure && error.statusCode === 502,
  );
  assert.equal(await store.getInvocation("inv-unavail-1"), null);
  assert.equal(provider.calls.length, 0);

  available = true;
  const retry = await service.authorize(await signedInput(permit, { invocationId: "inv-unavail-1" }));
  assert.equal(retry.receipt.decision, "ALLOW");
});

test("a request the permit does not allow is denied without contacting the service", async () => {
  const { provider, service } = setup();
  const permit = await buildSignedPermit();

  const denied = await service.authorize(await signedInput(permit, { invocationId: "inv-static-1", amountAtomic: "100000" }));

  assert.equal(denied.receipt.decision, "DENY");
  assert.equal(provider.challengesFetched.length, 0);
  assert.equal(provider.calls.length, 0);
});

test("permits without a settlement profile, or for an unregistered capability, cannot pay", async () => {
  const { provider, service } = setup();

  const devnetPermit = await buildSignedPermit({ network: "devnet" });
  const devnet = await service.authorize(await signedInput(devnetPermit, { invocationId: "inv-devnet-1" }));
  assert.deepEqual(devnet.receipt.reasonCodes, ["SETTLEMENT_PROFILE_UNAVAILABLE"]);

  const otherCapability = await buildSignedPermit({ capability: "research.other" });
  const unregistered = await service.authorize(await signedInput(otherCapability, { invocationId: "inv-unreg-1" }));
  assert.deepEqual(unregistered.receipt.reasonCodes, ["PAID_SERVICE_NOT_CONFIGURED"]);

  assert.equal(provider.challengesFetched.length, 0);
  assert.equal(provider.calls.length, 0);
});

test("successful settlement consumes the reservation exactly and stores payment evidence", async () => {
  const { provider, store, service } = setup();
  const permit = await buildSignedPermit();

  const result = await service.authorize(await signedInput(permit, { invocationId: "inv-evidence-1" }));
  const invocation = await store.getInvocation("inv-evidence-1");

  assert.equal(result.receipt.decision, "ALLOW");
  assert.equal(result.receipt.paymentTransactionId, "mock-tx-1");
  assert.equal(invocation?.state, "CONFIRMED");
  assert.equal(invocation?.paymentAttempt?.payerSignature, "mock-payer-sig-1");
  assert.equal(invocation?.settlement?.transactionId, "mock-tx-1");
  assert.equal(invocation?.paymentRequirement?.amountAtomic, "10000");
  assert.deepEqual(result.result, { result: "mock paid result 1" });
  assert.equal(result.payment?.payTo, permit.recipient);
  assert.deepEqual(await budget(service, permit), {
    maxTotalAtomic: "50000",
    reservedAtomic: "0",
    consumedAtomic: "10000",
    remainingAtomic: "40000",
  });
  assert.equal(provider.calls.length, 1);
});

test("replay returns the stored result without re-contacting the service or paying again", async () => {
  const { provider, service } = setup();
  const permit = await buildSignedPermit();
  const first = await service.authorize(await signedInput(permit, { invocationId: "inv-replay-p4" }));
  const replay = await service.authorize(await signedInput(permit, { invocationId: "inv-replay-p4" }));

  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(replay.result, first.result);
  assert.equal(provider.challengesFetched.length, 1);
  assert.equal(provider.calls.length, 1);
});

test("an invocation conflict is rejected before any challenge fetch or settlement", async () => {
  const { provider, service } = setup();
  const permit = await buildSignedPermit();
  await service.authorize(await signedInput(permit, { invocationId: "inv-conflict-p4", amountAtomic: "10000" }));

  await assert.rejects(
    service.authorize(await signedInput(permit, { invocationId: "inv-conflict-p4", amountAtomic: "15000" })),
    InvocationConflictError,
  );
  assert.equal(provider.challengesFetched.length, 1);
  assert.equal(provider.calls.length, 1);
});

test("an unknown post-submission outcome keeps the reservation and the recorded attempt", async () => {
  const { store, service } = setup(new TimingOutPaymentProvider());
  const permit = await buildSignedPermit();

  await assert.rejects(service.authorize(await signedInput(permit, { invocationId: "inv-unknown-1" })), ReconciliationRequiredError);

  const invocation = await store.getInvocation("inv-unknown-1");
  assert.equal(invocation?.state, "RECONCILIATION_REQUIRED");
  assert.equal(invocation?.paymentAttempt?.payerSignature, "mock-payer-sig-1");
  assert.equal((await budget(service, permit))?.reservedAtomic, "10000");
});

test("reconciliation of a landed payment confirms it and consumes the budget exactly once", async () => {
  const provider = new TimingOutPaymentProvider();
  const { store, service } = setup(provider);
  const permit = await buildSignedPermit();

  await assert.rejects(service.authorize(await signedInput(permit, { invocationId: "inv-rec-1" })), ReconciliationRequiredError);
  const attempt = (await store.getInvocation("inv-rec-1"))?.paymentAttempt;
  assert.ok(attempt);

  // The payment did land after the timeout.
  provider.settleLater(attempt, "tx-landed-late");
  const executionsBefore = provider.calls.length;

  assert.deepEqual(await service.reconcile(), [{ invocationId: "inv-rec-1", outcome: "confirmed", detail: "tx-landed-late" }]);
  assert.deepEqual(await service.reconcile(), []);
  assert.equal(provider.calls.length, executionsBefore, "reconciliation never pays");

  assert.deepEqual(await budget(service, permit), {
    maxTotalAtomic: "50000",
    reservedAtomic: "0",
    consumedAtomic: "10000",
    remainingAtomic: "40000",
  });

  const replay = await service.authorize(await signedInput(permit, { invocationId: "inv-rec-1" }));
  assert.equal(replay.receipt.decision, "ALLOW");
  assert.equal(replay.receipt.paymentTransactionId, "tx-landed-late");
});

test("reconciliation marks an expired, never-landed payment FAILED and releases the reservation", async () => {
  const provider = new TimingOutPaymentProvider();
  const { store, service } = setup(provider);
  const permit = await buildSignedPermit();

  await assert.rejects(service.authorize(await signedInput(permit, { invocationId: "inv-rec-2" })), ReconciliationRequiredError);

  // Still possibly valid: stays blocked, reservation held.
  provider.lookupWhenMissing = { status: "pending", currentBlockHeight: "10" };
  assert.equal((await service.reconcile())[0]?.outcome, "still_pending");
  assert.equal((await store.getInvocation("inv-rec-2"))?.state, "RECONCILIATION_REQUIRED");
  assert.equal((await budget(service, permit))?.reservedAtomic, "10000");

  // Blockhash definitively expired and nothing landed.
  provider.lookupWhenMissing = { status: "expired", currentBlockHeight: "5000" };
  assert.equal((await service.reconcile())[0]?.outcome, "failed");
  assert.equal((await store.getInvocation("inv-rec-2"))?.state, "FAILED");
  assert.equal((await budget(service, permit))?.reservedAtomic, "0");

  // The same request may now be attempted again (fresh attempt).
  provider.behavior = "settle";
  const retry = await service.authorize(await signedInput(permit, { invocationId: "inv-rec-2" }));
  assert.equal(retry.receipt.decision, "ALLOW");
  assert.equal((await budget(service, permit))?.consumedAtomic, "10000");
});

test("an invocation interrupted before its attempt was recorded is released, and the in-flight payment can no longer transmit", async () => {
  const { store, service } = setup();
  const permit = await buildSignedPermit();
  let transmitted = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  // A provider honoring the ordering contract, paused just before beforeSubmit.
  const honest = new CountingPaymentProvider();
  const paused: PaymentProvider = {
    settlementProfile: honest.settlementProfile,
    payerAddress: honest.payerAddress,
    fetchChallenge: (resource, context) => honest.fetchChallenge(resource, context),
    lookupSettlement: (attempt) => honest.lookupSettlement(attempt),
    async execute(input) {
      await gate;
      const attempt = { ...attemptTemplate, payTo: input.requirement.payTo, asset: input.requirement.asset };
      try {
        await input.beforeSubmit(attempt);
      } catch (error) {
        throw new PaymentNotSubmittedError(`attempt not persisted: ${error instanceof Error ? error.message : "?"}`);
      }
      transmitted += 1;
      throw new Error("unreachable in this test");
    },
  };
  const inFlight = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider: paused,
    store,
    log: () => {},
  });

  const pending = inFlight.authorize(await signedInput(permit, { invocationId: "inv-noattempt-1" }));
  for (let i = 0; i < 100 && (await store.getInvocation("inv-noattempt-1"))?.state !== "RESERVED"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Another process restarts and recovers: no attempt recorded -> released.
  const recovery = await service.recoverInterruptedInvocations();
  assert.deepEqual(recovery, { reconciliationRequired: [], releasedNeverSubmitted: ["inv-noattempt-1"] });
  assert.equal((await budget(service, permit))?.reservedAtomic, "0");

  // The in-flight payment resumes: its attempt cannot be recorded, so it never transmits.
  releaseGate();
  await assert.rejects(pending, PaymentNotSubmittedFailure);
  assert.equal(transmitted, 0);
  assert.equal((await store.getInvocation("inv-noattempt-1"))?.state, "FAILED");
  assert.equal((await budget(service, permit))?.reservedAtomic, "0");
  assert.equal((await budget(service, permit))?.consumedAtomic, "0");
});

test("concurrent reconciliation runs resolve each invocation exactly once", async () => {
  const provider = new TimingOutPaymentProvider();
  const { store, service } = setup(provider);
  const permit = await buildSignedPermit();
  await assert.rejects(service.authorize(await signedInput(permit, { invocationId: "inv-rec-race" })), ReconciliationRequiredError);
  provider.settleLater((await store.getInvocation("inv-rec-race"))!.paymentAttempt!, "tx-race");

  const runs = await Promise.all([service.reconcile(), service.reconcile(), service.reconcile()]);
  assert.ok(runs.every((reports) => reports.length === 1 && reports[0]?.outcome === "confirmed"));
  assert.equal((await budget(service, permit))?.consumedAtomic, "10000");
  assert.equal((await budget(service, permit))?.reservedAtomic, "0");

  // A second authority process racing on the same store gets "already_resolved", not an error.
  const other = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider: provider,
    store,
    log: () => {},
  });
  assert.deepEqual(await other.reconcile(), []);
});

test("an invocation resolved by another process mid-run is reported as already_resolved", async () => {
  const provider = new TimingOutPaymentProvider();
  const { store, service } = setup(provider);
  const permit = await buildSignedPermit();
  await assert.rejects(service.authorize(await signedInput(permit, { invocationId: "inv-stale" })), ReconciliationRequiredError);
  provider.settleLater((await store.getInvocation("inv-stale"))!.paymentAttempt!, "tx-stale");

  // Another process lists the invocation, then this one resolves it first.
  const staleList = await store.listReconciliationRequired();
  await service.reconcile();
  const staleStore: AuthorityStore = {
    reserve: (input, evaluate) => store.reserve(input, evaluate),
    recordPaymentAttempt: (id, attempt) => store.recordPaymentAttempt(id, attempt),
    confirm: (id, payment) => store.confirm(id, payment),
    resolveReconciliation: (id, outcome) => store.resolveReconciliation(id, outcome),
    listReconciliationRequired: async () => staleList,
    fail: (id, reason) => store.fail(id, reason),
    markReconciliationRequired: (id, reason) => store.markReconciliationRequired(id, reason),
    attachReceipt: (id, receipt) => store.attachReceipt(id, receipt),
    getInvocation: (id) => store.getInvocation(id),
    getGrant: (issuer, grantId) => store.getGrant(issuer, grantId),
    recoverInterruptedInvocations: (reason) => store.recoverInterruptedInvocations(reason),
    close: () => store.close(),
  };
  const other = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider: provider,
    store: staleStore,
    log: () => {},
  });

  assert.deepEqual(await other.reconcile(), [{ invocationId: "inv-stale", outcome: "already_resolved" }]);
  assert.equal((await budget(service, permit))?.consumedAtomic, "10000");
});
