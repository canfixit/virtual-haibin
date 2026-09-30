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
import { AUTHORIZATION_RECEIPT_DOMAIN, type SignedAuthorizationReceiptV1 } from "./receipt.js";
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
  assert.equal(result.receipt.paymentTransactionId, "mock-1");
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
  assert.ok(results.every((result) => result.receipt.paymentTransactionId === "mock-1"));
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

test("concurrent requests with one invocationId but different payloads pay at most once", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();
  const inputs = await Promise.all([
    signedInput(permit, { invocationId: "inv-race-1", amountAtomic: "10000" }),
    signedInput(permit, { invocationId: "inv-race-1", amountAtomic: "15000" }),
  ]);

  const results = await Promise.allSettled(inputs.map((input) => service.authorize(input)));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof InvocationConflictError);
  assert.equal(provider.calls.length, 1);
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

test("the payment is built from the verified permit's authoritative facts, in integer atomic units", async () => {
  const provider = new CountingPaymentProvider();
  const service = createService(provider);
  const permit = await buildSignedPermit();

  await service.authorize(await signedInput(permit, { invocationId: "inv-payment-facts-1" }));

  assert.deepEqual(provider.calls, [
    {
      from: authorityAddress,
      to: permit.recipient,
      mint: permit.mint,
      network: permit.network,
      amountAtomic: "10000",
      reference: "inv-payment-facts-1",
    },
  ]);
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

  async function verifyReceipt(candidate: SignedAuthorizationReceiptV1): Promise<boolean> {
    const { signature, ...unsigned } = candidate;
    const bytes = new TextEncoder().encode(`${AUTHORIZATION_RECEIPT_DOMAIN}:v1\n${canonicalize(unsigned)}`);
    const publicKey = await getPublicKeyFromAddress(address(candidate.authority));
    return verifySignature(publicKey, signatureBytes(getBase58Encoder().encode(signature.signature)), bytes);
  }

  assert.equal(await verifyReceipt(receipt), true);
  assert.equal(await verifyReceipt({ ...receipt, amountAtomic: "20000" }), false);
  assert.equal(await verifyReceipt({ ...receipt, recipient: otherRecipientAddress }), false);
  assert.equal(await verifyReceipt({ ...receipt, requestFingerprint: "0".repeat(64) }), false);
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
