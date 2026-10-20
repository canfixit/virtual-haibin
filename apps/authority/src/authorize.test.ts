import assert from "node:assert/strict";
import { test } from "node:test";
import { address, getPublicKeyFromAddress } from "@solana/addresses";
import { getBase58Decoder, getBase58Encoder } from "@solana/codecs-strings";
import { signatureBytes, verifySignature } from "@solana/keys";
import canonicalize from "canonicalize";
import { computePermitDigest } from "@virtual-haibin/mandate";
import type { PaymentProvider } from "@virtual-haibin/payments";
import {
  AgentAuthenticationError,
  AuthorityService,
  InvocationConflictError,
  ReconciliationRequiredError,
  type AuthorityLogEntry,
  type AuthorityServiceOptions,
} from "./authorize.js";
import { AUTHORIZATION_RECEIPT_DOMAIN, type SignedAuthorizationReceipt } from "./receipt.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import {
  agentAddress,
  authorityAddress,
  authoritySigner,
  buildSignedPermit,
  committedAtomic,
  CountingPaymentProvider,
  otherAgentIdentity,
  otherRecipientAddress,
  signedInput,
  tamperRequest,
  TEST_AUDIENCE,
  TEST_CHALLENGE_NETWORK,
  TEST_PAYMENT_CONFIG,
  TEST_RESOURCE,
  TimingOutPaymentProvider,
} from "./test-support.js";

function createService(
  paymentProvider: PaymentProvider = new CountingPaymentProvider(),
  logs: AuthorityLogEntry[] = [],
  options: Partial<AuthorityServiceOptions> = {},
) {
  return new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider,
    store: new SqliteAuthorityStore(":memory:"),
    log: (entry) => logs.push(entry),
    ...options,
  });
}

async function assertAuthenticationRejected(promise: Promise<unknown>, reasonCode: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentAuthenticationError, `expected AgentAuthenticationError, got ${String(error)}`);
    assert.equal(error.statusCode, 401);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Demo cases
// ---------------------------------------------------------------------------

test("Case 1 -- ALLOW: an agent-signed, authorized, in-budget request is allowed and paid", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  const result = await service.authorize(await signedInput(permit, { invocationId: "inv-allow-1" }));

  assert.equal(result.receipt.decision, "ALLOW");
  assert.equal(result.replay, false);
  assert.equal(provider.calls.length, 1);
  assert.equal(result.receipt.paymentTransactionId, "mock-tx-1");
  assert.equal(result.receipt.authority, authorityAddress);
  assert.equal(result.receipt.agent, agentAddress);
  assert.equal(result.receipt.permitDigest, await computePermitDigest(permit));
  assert.match(result.receipt.requestFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(await committedAtomic(service, permit), "10000");
});

test("Case 2 -- DENY overspend: per-call limit exceeded, no payment submitted", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  const result = await service.authorize(await signedInput(permit, { invocationId: "inv-overspend-1", amountAtomic: "100000" }));

  assert.equal(result.receipt.decision, "DENY");
  assert.ok(result.receipt.reasonCodes.includes("PER_CALL_LIMIT_EXCEEDED"));
  assert.equal(provider.calls.length, 0);
  assert.equal(await committedAtomic(service, permit), "0");
});

test("Case 3 -- every semantic mismatch is denied with a stable reason code and no payment", async () => {
  const cases = [
    { field: "service", value: "other-service", reasonCode: "SERVICE_MISMATCH" },
    { field: "capability", value: "other.capability", reasonCode: "CAPABILITY_MISMATCH" },
    { field: "network", value: "mainnet-beta", reasonCode: "NETWORK_MISMATCH" },
    { field: "mint", value: otherRecipientAddress, reasonCode: "MINT_MISMATCH" },
    { field: "recipient", value: otherRecipientAddress, reasonCode: "RECIPIENT_MISMATCH" },
    // A display label is never accepted in place of the authoritative mint.
    { field: "mint", value: "USDC", reasonCode: "MINT_MISMATCH" },
  ] as const;

  for (const [index, { field, value, reasonCode }] of cases.entries()) {
    const provider = new CountingPaymentProvider();
    const service = createService(provider);
    const permit = await buildSignedPermit();

    const result = await service.authorize(
      await signedInput(permit, { invocationId: `inv-semantic-${index}`, fields: { [field]: value } }),
    );

    assert.equal(result.receipt.decision, "DENY", field);
    assert.deepEqual(result.receipt.reasonCodes, [reasonCode], field);
    assert.equal(result.receipt.paymentTransactionId, null, field);
    assert.equal(provider.calls.length, 0, field);
  }
});

test("Case 4 -- replay: repeating an invocation returns the stored receipt without a second payment", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-replay-1" });

  const first = await service.authorize(input);
  const second = await service.authorize(input);

  assert.equal(first.replay, false);
  assert.equal(second.replay, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(provider.calls.length, 1);
});

test("Case 4 -- an honest retry re-signed with a fresh timestamp is the same invocation", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  const first = await service.authorize(await signedInput(permit, { invocationId: "inv-resign-1" }));
  const retry = await service.authorize(
    await signedInput(permit, { invocationId: "inv-resign-1", fields: { issuedAt: Date.now() + 5 } }),
  );

  assert.equal(retry.replay, true);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.equal(provider.calls.length, 1);
});

test("replay of a denied invocation returns the same denial, not a re-evaluation", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-replay-deny-1", amountAtomic: "100000" });

  const first = await service.authorize(input);
  const second = await service.authorize(input);

  assert.equal(first.receipt.decision, "DENY");
  assert.equal(second.replay, true);
  assert.deepEqual(second.receipt, first.receipt);
});

test("Case 4 -- concurrent duplicates of one invocation produce exactly one payment", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-concurrent-dup-1" });

  const results = await Promise.all(Array.from({ length: 5 }, () => service.authorize(input)));

  assert.equal(provider.calls.length, 1);
  assert.equal(results.filter((result) => !result.replay).length, 1);
  assert.ok(results.every((result) => result.receipt.paymentTransactionId === "mock-tx-1"));
});

test("Case 5 -- shared budget: concurrent requests cannot collectively exceed the total budget", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "50000" });

  // 5 concurrent requests of 20000 each against a 50000 total budget: at most
  // 2 can be allowed (40000 <= 50000 < 60000).
  const inputs = await Promise.all(
    Array.from({ length: 5 }, (_, index) => signedInput(permit, { invocationId: `inv-concurrent-${index}`, amountAtomic: "20000" })),
  );
  const results = await Promise.all(inputs.map((input) => service.authorize(input)));

  const allowed = results.filter((result) => result.receipt.decision === "ALLOW");
  const denied = results.filter((result) => result.receipt.decision === "DENY");

  assert.equal(allowed.length, 2);
  assert.equal(denied.length, 3);
  assert.ok(denied.every((result) => result.receipt.reasonCodes.includes("TOTAL_BUDGET_EXCEEDED")));
  assert.equal(provider.calls.length, 2);
  assert.equal(await committedAtomic(service, permit), "40000");
});

test("expired permits are denied even though every signature is valid", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const issuedAt = Date.now() - 60 * 60 * 1000;
  const permit = await buildSignedPermit({ issuedAt, expiresAt: issuedAt + 1_000 });

  const result = await service.authorize(await signedInput(permit, { invocationId: "inv-expired-1" }));

  assert.equal(result.receipt.decision, "DENY");
  assert.ok(result.receipt.reasonCodes.includes("PERMIT_EXPIRED"));
  assert.equal(provider.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Agent authentication (caller bound to permit.authorizedAgent)
// ---------------------------------------------------------------------------

test("a request signed by a different agent is rejected, even for a valid permit", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  await assertAuthenticationRejected(
    service.authorize(await signedInput(permit, { invocationId: "inv-other-agent-1", agent: otherAgentIdentity })),
    "AGENT_SIGNATURE_INVALID",
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(await committedAtomic(service, permit), "0");
});

test("modifying any signed request field after signing fails agent-signature verification", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-tamper-1" });

  const tamperings = [
    { service: "other-service" },
    { recipient: otherRecipientAddress },
    { amountAtomic: "20000" },
    { invocationId: "inv-tamper-2" },
    { permitDigest: "0".repeat(64) },
    { grantId: "VH-GRANT-OTHER" },
    { audience: "other-authority" },
    { issuedAt: input.authorizationRequest.issuedAt + 1 },
  ];

  for (const fields of tamperings) {
    await assertAuthenticationRejected(service.authorize(tamperRequest(input, fields)), "AGENT_SIGNATURE_INVALID");
  }

  assert.equal(provider.calls.length, 0);
});

test("a tampered permit is rejected before any request is evaluated", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-tampered-permit-1" });

  await assertAuthenticationRejected(
    service.authorize({ ...input, permit: { ...permit, maxTotalAtomic: "999999" } }),
    "PERMIT_INVALID",
  );
  assert.equal(provider.calls.length, 0);
});

test("a request signed for one permit cannot be used with another valid permit for the same grant", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit({ grantId: "VH-GRANT-REISSUED" });
  const widened = await buildSignedPermit({ grantId: "VH-GRANT-REISSUED", maxTotalAtomic: "90000" });
  const input = await signedInput(permit, { invocationId: "inv-digest-1" });

  await assertAuthenticationRejected(service.authorize({ ...input, permit: widened }), "REQUEST_PERMIT_DIGEST_MISMATCH");
  assert.equal(provider.calls.length, 0);
});

test("a correctly signed request naming a different grant or audience is rejected", async () => {
  const service = createService();
  const permit = await buildSignedPermit();

  await assertAuthenticationRejected(
    service.authorize(await signedInput(permit, { invocationId: "inv-grant-1", fields: { grantId: "VH-GRANT-OTHER" } })),
    "REQUEST_GRANT_MISMATCH",
  );
  await assertAuthenticationRejected(
    service.authorize(await signedInput(permit, { invocationId: "inv-aud-1", fields: { audience: "other-authority" } })),
    "REQUEST_AUDIENCE_MISMATCH",
  );
});

test("request timestamps outside the skew policy (120 s old / 30 s future) are rejected", async () => {
  const provider = new CountingPaymentProvider();
  const now = Date.now();
  const service = createService(provider, [], { now: () => now });
  const permit = await buildSignedPermit();

  for (const [label, issuedAt] of [
    ["stale", now - 120_001],
    ["far-future", now + 30_001],
  ] as const) {
    await assertAuthenticationRejected(
      service.authorize(await signedInput(permit, { invocationId: `inv-time-${label}`, fields: { issuedAt } })),
      "REQUEST_TIMESTAMP_OUT_OF_RANGE",
    );
  }

  assert.equal(provider.calls.length, 0);

  // Inside the window on both edges is accepted.
  for (const [label, issuedAt] of [
    ["oldest", now - 120_000],
    ["newest", now + 30_000],
  ] as const) {
    const result = await service.authorize(await signedInput(permit, { invocationId: `inv-time-${label}`, fields: { issuedAt } }));
    assert.equal(result.receipt.decision, "ALLOW", label);
  }
});

test("malformed agent signatures fail closed with AGENT_SIGNATURE_INVALID", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-malformed-sig-1" });

  const malformed: unknown[] = [
    "not-an-object",
    [],
    {},
    { algorithm: "ed25519" },
    { algorithm: "ed25519", signature: "too-short" },
    { algorithm: "ed25519", signature: getBase58Decoder().decode(new Uint8Array(64)) },
    { algorithm: "rsa", signature: (input.agentSignature as { signature: string }).signature },
  ];

  for (const agentSignature of malformed) {
    await assertAuthenticationRejected(service.authorize({ ...input, agentSignature }), "AGENT_SIGNATURE_INVALID");
  }

  assert.equal(provider.calls.length, 0);
});

test("a missing agent signature is rejected", async () => {
  const service = createService();
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-missing-sig-1" });

  await assertAuthenticationRejected(service.authorize({ ...input, agentSignature: undefined }), "AGENT_SIGNATURE_MISSING");
  await assertAuthenticationRejected(service.authorize({ ...input, agentSignature: null }), "AGENT_SIGNATURE_MISSING");
});

test("an unauthenticated request cannot claim an invocationId", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  await assertAuthenticationRejected(
    service.authorize(await signedInput(permit, { invocationId: "inv-squat-1", agent: otherAgentIdentity, amountAtomic: "1" })),
    "AGENT_SIGNATURE_INVALID",
  );

  const legitimate = await service.authorize(await signedInput(permit, { invocationId: "inv-squat-1" }));
  assert.equal(legitimate.replay, false);
  assert.equal(legitimate.receipt.decision, "ALLOW");
  assert.equal(provider.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Invocation fingerprint / conflict semantics
// ---------------------------------------------------------------------------

test("same invocationId + different request returns INVOCATION_CONFLICT with no payment or budget change", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "40000" });

  const first = await service.authorize(await signedInput(permit, { invocationId: "inv-conflict-1", amountAtomic: "20000" }));
  assert.equal(first.receipt.decision, "ALLOW");
  assert.equal(await committedAtomic(service, permit), "20000");

  for (const options of [{ amountAtomic: "10000" }, { fields: { recipient: otherRecipientAddress } }]) {
    await assert.rejects(
      service.authorize(await signedInput(permit, { invocationId: "inv-conflict-1", ...options })),
      (error: unknown) => {
        assert.ok(error instanceof InvocationConflictError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.reasonCode, "INVOCATION_CONFLICT");
        return true;
      },
    );
  }

  assert.equal(provider.calls.length, 1);
  assert.equal(await committedAtomic(service, permit), "20000");

  // Had the conflict reserved anything, this 20000 would exceed the 40000 total.
  const next = await service.authorize(await signedInput(permit, { invocationId: "inv-conflict-2", amountAtomic: "20000" }));
  assert.equal(next.receipt.decision, "ALLOW");

  // The original invocation still replays its own receipt.
  const replay = await service.authorize(await signedInput(permit, { invocationId: "inv-conflict-1", amountAtomic: "20000" }));
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, first.receipt);
});

test("a conflicting request for a denied invocation is also refused rather than re-evaluated", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  await service.authorize(await signedInput(permit, { invocationId: "inv-conflict-deny-1", amountAtomic: "100000" }));
  await assert.rejects(
    service.authorize(await signedInput(permit, { invocationId: "inv-conflict-deny-1", amountAtomic: "10000" })),
    InvocationConflictError,
  );
  assert.equal(provider.calls.length, 0);
});

/** Holds every challenge fetch until released, so a test can keep one invocation in flight. */
class GatedPaymentProvider extends CountingPaymentProvider {
  readonly entered: Promise<void>;
  #signalEntered!: () => void;
  #release!: () => void;
  readonly #gate = new Promise<void>((resolve) => (this.#release = resolve));

  constructor(...args: ConstructorParameters<typeof CountingPaymentProvider>) {
    super(...args);
    this.entered = new Promise<void>((resolve) => (this.#signalEntered = resolve));
  }

  release(): void {
    this.#release();
  }

  override async fetchChallenge(...args: Parameters<CountingPaymentProvider["fetchChallenge"]>) {
    this.#signalEntered();
    await this.#gate;
    return super.fetchChallenge(...args);
  }
}

// The merchant's real price is 10000. Whichever of these two requests first
// claims the invocation establishes its decision: the 10000 one is ALLOWed
// and paid; the 15000 one is DENYed because the real challenge does not ask
// for what the agent signed. Either way the other request is a conflict.
const RACE_PRICE_ATOMIC = "10000";
const RACE_CONFLICT_ATOMIC = "15000";

async function assertSingleDecision(
  { service, store, provider }: { service: AuthorityService; store: SqliteAuthorityStore; provider: CountingPaymentProvider },
  permit: Awaited<ReturnType<typeof buildSignedPermit>>,
  invocationId: string,
  winner: { receipt: SignedAuthorizationReceipt },
): Promise<void> {
  const { receipt } = winner;
  const won = receipt.amountAtomic === RACE_PRICE_ATOMIC ? "ALLOW" : "DENY";
  assert.equal(receipt.decision, won);

  if (won === "ALLOW") {
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.reference, invocationId);
    assert.equal(receipt.paymentTransactionId, "mock-tx-1");
  } else {
    assert.ok(receipt.reasonCodes.includes("CHALLENGE_REQUEST_MISMATCH"), receipt.reasonCodes.join(","));
    assert.equal(provider.calls.length, 0);
    assert.equal(receipt.paymentTransactionId, null);
  }

  // Only the winner ever reached the merchant.
  assert.equal(provider.challengesFetched.length, 1);

  // Durable state records exactly the winner's request, settled, with no
  // reservation left behind.
  const stored = await store.getInvocation(invocationId);
  assert.equal(stored?.fingerprint, receipt.requestFingerprint);
  assert.equal(stored?.amountAtomic, receipt.amountAtomic);
  assert.equal(stored?.state, won === "ALLOW" ? "CONFIRMED" : "DENIED");
  const budget = await service.getGrantBudget(permit.issuer, permit.grantId);
  assert.equal(budget?.reservedAtomic ?? "0", "0");
  assert.equal(budget?.consumedAtomic ?? "0", won === "ALLOW" ? RACE_PRICE_ATOMIC : "0");

  // After settlement the loser is still refused (now from durable state) and
  // the winner replays its own receipt; neither pays or fetches again.
  const loserAmount = receipt.amountAtomic === RACE_PRICE_ATOMIC ? RACE_CONFLICT_ATOMIC : RACE_PRICE_ATOMIC;
  await assert.rejects(service.authorize(await signedInput(permit, { invocationId, amountAtomic: loserAmount })), InvocationConflictError);
  const replay = await service.authorize(await signedInput(permit, { invocationId, amountAtomic: receipt.amountAtomic }));
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, receipt);
  assert.equal(provider.calls.length, won === "ALLOW" ? 1 : 0);
  assert.equal(provider.challengesFetched.length, 1);
}

for (const [firstAmount, secondAmount] of [
  [RACE_PRICE_ATOMIC, RACE_CONFLICT_ATOMIC],
  [RACE_CONFLICT_ATOMIC, RACE_PRICE_ATOMIC],
] as const) {
  test(`overlapping requests with one invocationId: ${firstAmount} first establishes the decision, ${secondAmount} conflicts`, async () => {
    const provider = new GatedPaymentProvider({ terms: { amountAtomic: RACE_PRICE_ATOMIC } });
    const store = new SqliteAuthorityStore(":memory:");
    const service = createService(provider, [], { store });
    const permit = await buildSignedPermit();
    const invocationId = `inv-race-ordered-${firstAmount}`;
    const [first, second] = await Promise.all([
      signedInput(permit, { invocationId, amountAtomic: firstAmount }),
      signedInput(permit, { invocationId, amountAtomic: secondAmount }),
    ]);

    // The first request is held mid-flight (after claiming the invocation,
    // before any decision is stored) while the conflicting one arrives.
    const firstResult = service.authorize(first);
    await provider.entered;
    await assert.rejects(service.authorize(second), (error: unknown) => {
      assert.ok(error instanceof InvocationConflictError);
      assert.equal(error.reasonCode, "INVOCATION_CONFLICT");
      return true;
    });
    assert.equal(provider.calls.length, 0);

    provider.release();
    const winner = await firstResult;
    assert.equal(winner.replay, false);
    assert.equal(winner.receipt.amountAtomic, firstAmount);
    await assertSingleDecision({ service, store, provider }, permit, invocationId, winner);
  });
}

test("concurrent requests with one invocationId but different payloads: exactly one decides, the other conflicts", async () => {
  // Real scheduling: either request may claim the invocation first (both
  // orderings are pinned down by the controlled tests above).
  const provider = new CountingPaymentProvider({ terms: { amountAtomic: RACE_PRICE_ATOMIC } });
  const store = new SqliteAuthorityStore(":memory:");
  const service = createService(provider, [], { store });
  const permit = await buildSignedPermit();
  const inputs = await Promise.all([
    signedInput(permit, { invocationId: "inv-race-1", amountAtomic: RACE_PRICE_ATOMIC }),
    signedInput(permit, { invocationId: "inv-race-1", amountAtomic: RACE_CONFLICT_ATOMIC }),
  ]);

  const results = await Promise.allSettled(inputs.map((input) => service.authorize(input)));

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof InvocationConflictError, String(rejected[0]?.reason));
  const winner = fulfilled[0]!.value;
  assert.equal(winner.replay, false);
  await assertSingleDecision({ service, store, provider }, permit, "inv-race-1", winner);
});

test("the same invocationId under a different permit is a conflict", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permitA = await buildSignedPermit();
  const permitB = await buildSignedPermit();

  await service.authorize(await signedInput(permitA, { invocationId: "inv-cross-grant-1" }));
  await assert.rejects(service.authorize(await signedInput(permitB, { invocationId: "inv-cross-grant-1" })), InvocationConflictError);
  assert.equal(provider.calls.length, 1);
  assert.equal(await committedAtomic(service, permitB), "0");
});

// ---------------------------------------------------------------------------
// Payment path and evidence
// ---------------------------------------------------------------------------

test("the payment signer receives exactly the validated challenge requirement, in integer base units", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  await service.authorize(await signedInput(permit, { invocationId: "inv-payment-facts-1" }));

  assert.equal(provider.calls.length, 1);
  const [execution] = provider.calls;
  assert.equal(execution?.reference, "inv-payment-facts-1");
  assert.equal(execution?.request.url, TEST_RESOURCE.url);
  assert.equal(execution?.request.method, "POST");
  assert.equal(execution?.request.body, '{"datasetId":"dataset-a","operation":"summarize"}');
  assert.equal(execution?.requirement.scheme, "exact");
  assert.equal(execution?.requirement.network, TEST_CHALLENGE_NETWORK);
  assert.equal(execution?.requirement.asset, permit.mint);
  assert.equal(execution?.requirement.payTo, permit.recipient);
  assert.equal(execution?.requirement.amountAtomic, "10000");
  assert.equal(typeof execution?.requirement.amountAtomic, "string");
});

test("an uncertain payment outcome blocks retries instead of paying again, and keeps budget reserved", async () => {
  const timingOut = new TimingOutPaymentProvider();
  const logs: AuthorityLogEntry[] = [];
  const service = createService(timingOut, logs);
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "40000" });
  const input = await signedInput(permit, { invocationId: "inv-uncertain-1", amountAtomic: "20000" });

  await assert.rejects(service.authorize(input), ReconciliationRequiredError);
  await assert.rejects(service.authorize(input), ReconciliationRequiredError);
  assert.equal(timingOut.calls.length, 1);
  assert.equal(await committedAtomic(service, permit), "20000");
  assert.ok(logs.some((entry) => entry.event === "authority.reconciliation_required"));

  // A different payload under the blocked invocationId is still a conflict, not a new attempt.
  await assert.rejects(
    service.authorize(await signedInput(permit, { invocationId: "inv-uncertain-1", amountAtomic: "10000" })),
    InvocationConflictError,
  );
  assert.equal(timingOut.calls.length, 1);
});

test("receipts are signed by the authority key and fail verification if a field is altered", async () => {
  const service = createService();
  const permit = await buildSignedPermit();
  const { receipt } = await service.authorize(await signedInput(permit, { invocationId: "inv-receipt-sig-1" }));

  async function verifyReceipt(candidate: SignedAuthorizationReceipt): Promise<boolean> {
    const { signature, ...unsigned } = candidate;
    const bytes = new TextEncoder().encode(`${AUTHORIZATION_RECEIPT_DOMAIN}:v${candidate.version}\n${canonicalize(unsigned)}`);
    const publicKey = await getPublicKeyFromAddress(address(candidate.authority));
    return verifySignature(publicKey, signatureBytes(getBase58Encoder().encode(signature.signature)), bytes);
  }

  assert.equal(await verifyReceipt(receipt), true);
  assert.equal(await verifyReceipt({ ...receipt, amountAtomic: "20000" }), false);
  assert.equal(await verifyReceipt({ ...receipt, recipient: otherRecipientAddress }), false);
  assert.equal(await verifyReceipt({ ...receipt, requestFingerprint: "0".repeat(64) }), false);

  // v2 receipts also bind the exact operation the decision was about.
  assert.equal(receipt.version, 2);
  if (receipt.version === 2) {
    assert.equal(await verifyReceipt({ ...receipt, operation: { ...receipt.operation, operation: "export" } }), false);
    assert.equal(await verifyReceipt({ ...receipt, operationDigest: "0".repeat(64) }), false);
  }
});

test("signing keys are non-extractable and never appear in logs or results", async () => {
  assert.equal(authoritySigner.privateKey.extractable, false);

  const logs: AuthorityLogEntry[] = [];
  const service = createService(new CountingPaymentProvider(), logs);
  const permit = await buildSignedPermit();
  const allow = await service.authorize(await signedInput(permit, { invocationId: "inv-no-key-1" }));
  const deny = await service.authorize(await signedInput(permit, { invocationId: "inv-no-key-2", amountAtomic: "100000" }));

  const serialized = JSON.stringify([logs, allow, deny, service.auditLog.list()]);
  assert.ok(!/privateKey|secretKey|"d":/.test(serialized));
  assert.ok(logs.some((entry) => entry.event === "authority.reserved"));
  assert.ok(logs.some((entry) => entry.event === "authority.denied"));
});
