import assert from "node:assert/strict";
import { test } from "node:test";
import { computeOperationDigest, signPurchasePermit, type ExactOperationV1 } from "@virtual-haibin/mandate";
import { createPaidRequest, type ChallengeResult, type PaymentProvider } from "@virtual-haibin/payments";
import {
  AgentAuthenticationError,
  AuthorityService,
  InvocationConflictError,
  IssuerNotEntitledError,
  OutboundRequestMismatchError,
  type AuthorityLogEntry,
} from "./authorize.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import type { AuthorityStore } from "./store/types.js";
import {
  agentIdentity,
  APPROVED_OPERATION,
  authorityAddress,
  authoritySigner,
  buildSignedPermit,
  buildUnsignedPermit,
  committedAtomic,
  CountingPaymentProvider,
  issuerKeypair,
  rogueIssuerKeypair,
  signedInput,
  tamperRequest,
  TEST_AUDIENCE,
  TEST_PAYMENT_CONFIG,
  TEST_RESOURCE,
} from "./test-support.js";

// Phase 4.5: the human approval boundary (issuer entitlement) and exact
// business-operation authorization. Every denial here keeps the payment
// terms identical to an allowed request; only the operation differs.

const SUMMARIZE_A_BODY = '{"datasetId":"dataset-a","operation":"summarize"}';

function op(change: Partial<ExactOperationV1>): ExactOperationV1 {
  return { ...APPROVED_OPERATION, ...change };
}

function setup(options: { provider?: PaymentProvider; store?: AuthorityStore; logs?: AuthorityLogEntry[] } = {}) {
  const provider = (options.provider ?? new CountingPaymentProvider()) as CountingPaymentProvider;
  const store = options.store ?? new SqliteAuthorityStore(":memory:");
  const service = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    paymentProvider: provider,
    store,
    log: (entry) => options.logs?.push(entry),
  });
  return { provider, store, service };
}

/** No reservation, no invocation row, no service contact, no payment signing. */
async function assertNoSideEffects(
  context: ReturnType<typeof setup>,
  permit: { issuer: string; grantId: string },
  invocationIds: string[],
): Promise<void> {
  assert.equal(await context.service.getGrantBudget(permit.issuer, permit.grantId), null);
  for (const invocationId of invocationIds) {
    assert.equal(await context.store.getInvocation(invocationId), null);
  }
  assert.equal(context.provider.challengesFetched.length, 0);
  assert.equal(context.provider.calls.length, 0);
}

// ---------------------------------------------------------------------------
// Human approval boundary: issuer entitlement
// ---------------------------------------------------------------------------

test("a permit from the trusted (entitled) issuer for the approved operation is allowed and paid", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  const result = await context.service.authorize(await signedInput(permit, { invocationId: "inv-trusted-1" }));

  assert.equal(result.receipt.decision, "ALLOW");
  assert.equal(context.provider.calls.length, 1);
  assert.equal(await committedAtomic(context.service, permit), "10000");
});

test("a cryptographically valid permit from an untrusted issuer is denied with ISSUER_NOT_ENTITLED and has no side effects", async () => {
  const logs: AuthorityLogEntry[] = [];
  const context = setup({ logs });
  // Same grantId, operation and payment terms as a legitimate permit; only the signer differs.
  const rogue = await buildSignedPermit({ grantId: "VH-GRANT-SHARED" }, rogueIssuerKeypair);

  await assert.rejects(context.service.authorize(await signedInput(rogue, { invocationId: "inv-rogue-1" })), (error: unknown) => {
    assert.ok(error instanceof IssuerNotEntitledError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.reasonCode, "ISSUER_NOT_ENTITLED");
    return true;
  });

  await assertNoSideEffects(context, rogue, ["inv-rogue-1"]);
  assert.ok(logs.some((entry) => entry.event === "authority.issuer_not_entitled"));
});

test("the agent cannot issue itself a usable permit: a permit signed with the agent's own key is not entitled", async () => {
  const context = setup();
  // The agent holds only its identity key. Signing a permit with it yields a
  // valid signature by a non-entitled issuer -- and a maximal self-grant.
  const selfIssued = await buildSignedPermit({ maxPerCallAtomic: "1000000", maxTotalAtomic: "1000000", operation: op({ operation: "export" }) }, agentIdentity);

  await assert.rejects(
    context.service.authorize(await signedInput(selfIssued, { invocationId: "inv-self-issued-1", fields: { operation: op({ operation: "export" }) } })),
    IssuerNotEntitledError,
  );
  await assertNoSideEffects(context, selfIssued, ["inv-self-issued-1"]);
});

test("the agent cannot expand a trusted permit: any widened field breaks the human signature", async () => {
  const context = setup();
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-expand-1", fields: { operation: op({ operation: "export" }) } });

  for (const widened of [
    { ...permit, operation: op({ operation: "export" }) },
    { ...permit, operation: op({ datasetId: "dataset-b" }) },
    { ...permit, maxTotalAtomic: "1000000" },
  ]) {
    await assert.rejects(context.service.authorize({ ...input, permit: widened }), (error: unknown) => {
      assert.ok(error instanceof AgentAuthenticationError);
      assert.equal(error.reasonCode, "PERMIT_INVALID");
      assert.equal(error.details.permitReasonCode, "INVALID_SIGNATURE");
      return true;
    });
  }

  assert.equal(context.provider.calls.length, 0);
});

test("a v1 permit (no operation binding) from the trusted issuer cannot buy anything", async () => {
  const context = setup();
  const { operation: _dropped, ...v1Fields } = buildUnsignedPermit();
  const v1 = await signPurchasePermit({ ...v1Fields, version: 1, network: "solana-payment-sandbox" }, issuerKeypair);
  const v2Input = await signedInput(await buildSignedPermit(), { invocationId: "inv-v1-permit-1" });

  await assert.rejects(context.service.authorize({ ...v2Input, permit: v1 }), (error: unknown) => {
    assert.ok(error instanceof AgentAuthenticationError);
    assert.equal(error.reasonCode, "PERMIT_INVALID");
    assert.equal(error.details.permitReasonCode, "UNSUPPORTED_VERSION");
    return true;
  });
  assert.equal(context.provider.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Same payment terms, different business operation
// ---------------------------------------------------------------------------

test("Case A/B -- same agent, merchant, recipient, mint, price and network: summarize is paid, export is denied", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  const allowed = await context.service.authorize(await signedInput(permit, { invocationId: "inv-case-a" }));
  const denied = await context.service.authorize(
    await signedInput(permit, { invocationId: "inv-case-b", fields: { operation: op({ operation: "export" }) } }),
  );

  assert.equal(allowed.receipt.decision, "ALLOW");
  assert.equal(denied.receipt.decision, "DENY");
  // The denial is purely semantic: no payment-, budget-, replay- or conflict-related code.
  assert.deepEqual(denied.receipt.reasonCodes, ["OPERATION_NOT_AUTHORIZED"]);

  // Identical payment terms on both receipts.
  for (const field of ["service", "capability", "network", "mint", "recipient", "amountAtomic", "agent", "permitDigest"] as const) {
    assert.equal(denied.receipt[field], allowed.receipt[field], field);
  }

  // Exactly one service contact and one payment, both for the approved operation.
  assert.equal(context.provider.challengesFetched.length, 1);
  assert.equal(context.provider.calls.length, 1);
  assert.equal(denied.receipt.paymentTransactionId, null);
  assert.equal(denied.payment, null);
  assert.equal(await committedAtomic(context.service, permit), "10000");

  // The signed receipt records which operation each decision was about.
  assert.equal(allowed.receipt.version, 2);
  assert.equal(denied.receipt.version, 2);
  if (allowed.receipt.version === 2 && denied.receipt.version === 2) {
    assert.equal(allowed.receipt.operation.operation, "summarize");
    assert.equal(denied.receipt.operation.operation, "export");
    assert.equal(denied.receipt.operationDigest, await computeOperationDigest(op({ operation: "export" })));
  }
});

test("Case B on its own -- an unauthorized operation is denied before any reservation, service contact or signing", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  const denied = await context.service.authorize(
    await signedInput(permit, { invocationId: "inv-export-only", fields: { operation: op({ operation: "export" }) } }),
  );

  assert.deepEqual(denied.receipt.reasonCodes, ["OPERATION_NOT_AUTHORIZED"]);
  assert.equal(context.provider.challengesFetched.length, 0);
  assert.equal(context.provider.calls.length, 0);
  assert.equal(await committedAtomic(context.service, permit), "0");
  // A durable DENIED record exists (for replay), with no budget reserved.
  assert.equal((await context.store.getInvocation("inv-export-only"))?.state, "DENIED");
});

test("Case C -- an unauthorized argument (dataset-b) with the same price is denied", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  const denied = await context.service.authorize(
    await signedInput(permit, { invocationId: "inv-case-c", fields: { operation: op({ datasetId: "dataset-b" }) } }),
  );

  assert.equal(denied.receipt.decision, "DENY");
  assert.deepEqual(denied.receipt.reasonCodes, ["OPERATION_ARGUMENT_NOT_AUTHORIZED"]);
  assert.equal(context.provider.challengesFetched.length, 0);
  assert.equal(context.provider.calls.length, 0);
  assert.equal(await committedAtomic(context.service, permit), "0");
});

test("a resource mismatch is denied with OPERATION_RESOURCE_MISMATCH and no payment", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  const denied = await context.service.authorize(
    await signedInput(permit, { invocationId: "inv-resource-1", fields: { operation: op({ resource: "/api/v1/export" }) } }),
  );

  assert.deepEqual(denied.receipt.reasonCodes, ["OPERATION_RESOURCE_MISMATCH"]);
  assert.equal(context.provider.calls.length, 0);
});

test("a permit for export does not authorize summarize (exact match, not a hierarchy)", async () => {
  const context = setup();
  const exportPermit = await buildSignedPermit({ operation: op({ operation: "export" }) });

  const denied = await context.service.authorize(await signedInput(exportPermit, { invocationId: "inv-reverse-1" }));
  assert.deepEqual(denied.receipt.reasonCodes, ["OPERATION_NOT_AUTHORIZED"]);
  assert.equal(context.provider.calls.length, 0);
});

test("modifying the operation or its argument after the agent signed fails authentication", async () => {
  const context = setup();
  const permit = await buildSignedPermit({ operation: op({ operation: "export" }) });
  // Agent signs for export (which IS approved here), attacker rewrites in transit.
  const input = await signedInput(permit, { invocationId: "inv-agent-tamper-1", fields: { operation: op({ operation: "export" }) } });

  for (const operation of [op({ operation: "summarize" }), op({ datasetId: "dataset-b", operation: "export" })]) {
    await assert.rejects(context.service.authorize(tamperRequest(input, { operation })), (error: unknown) => {
      assert.ok(error instanceof AgentAuthenticationError);
      assert.equal(error.reasonCode, "AGENT_SIGNATURE_INVALID");
      return true;
    });
  }
  assert.equal(context.provider.calls.length, 0);
});

test("an unknown business field inside the permit's operation fails closed", async () => {
  const context = setup();
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-unknown-op-field-1" });

  await assert.rejects(
    context.service.authorize({ ...input, permit: { ...permit, operation: { ...permit.operation, format: "full" } } }),
    (error: unknown) => {
      assert.ok(error instanceof AgentAuthenticationError);
      assert.equal(error.details.permitReasonCode, "INVALID_OPERATION");
      return true;
    },
  );
  assert.equal(context.provider.calls.length, 0);
});

test("the same invocationId cannot be reused to switch operation (fingerprint covers the operation)", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  await context.service.authorize(await signedInput(permit, { invocationId: "inv-switch-1" }));
  await assert.rejects(
    context.service.authorize(await signedInput(permit, { invocationId: "inv-switch-1", fields: { operation: op({ operation: "export" }) } })),
    InvocationConflictError,
  );
  assert.equal(context.provider.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Operation -> outbound HTTP request binding
// ---------------------------------------------------------------------------

test("the paid service receives exactly the verified operation, on the probe and on the paid retry", async () => {
  const context = setup();
  const permit = await buildSignedPermit();

  const result = await context.service.authorize(await signedInput(permit, { invocationId: "inv-outbound-1" }));
  const expected = createPaidRequest({ url: TEST_RESOURCE.url, method: "POST", body: SUMMARIZE_A_BODY });

  assert.equal(context.provider.challengesFetched.length, 1);
  assert.deepEqual(context.provider.challengesFetched[0]?.request, expected);
  assert.deepEqual(context.provider.paidRequests, [expected]);
  assert.equal(result.payment?.requestSha256, expected.sha256);
  assert.equal((await context.store.getInvocation("inv-outbound-1"))?.paymentAttempt?.requestSha256, expected.sha256);
});

test("if the request about to be paid differs from the durably authorized operation, nothing is paid", async () => {
  // A store whose reservation record names a different operation than the
  // one the outbound request was built from: the authority must refuse to
  // transmit rather than pay for a request it cannot match to its record.
  const sqlite = new SqliteAuthorityStore(":memory:");
  const reserve: AuthorityStore["reserve"] = async (...args) => {
    const result = await sqlite.reserve(...args);
    if (result.kind === "reserved" && result.invocation.request.version === 2) {
      return { ...result, invocation: { ...result.invocation, request: { ...result.invocation.request, operation: op({ operation: "export" }) } } };
    }
    return result;
  };
  const divergent = new Proxy(sqlite, {
    get(target, property) {
      if (property === "reserve") {
        return reserve;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const context = setup({ store: divergent });
  const permit = await buildSignedPermit();

  await assert.rejects(context.service.authorize(await signedInput(permit, { invocationId: "inv-divergent-1" })), OutboundRequestMismatchError);
  assert.equal(context.provider.calls.length, 0);
  assert.equal((await sqlite.getInvocation("inv-divergent-1"))?.state, "FAILED");
  assert.equal(await committedAtomic(context.service, permit), "0");
});

test("a challenge issued for a different request than the one the authority sent is refused before signing", async () => {
  const provider = new CountingPaymentProvider();
  const honest = provider.fetchChallenge.bind(provider);
  Object.defineProperty(provider, "fetchChallenge", {
    value: async (...args: Parameters<PaymentProvider["fetchChallenge"]>): Promise<ChallengeResult> => {
      const result = await honest(...args);
      return result.kind === "challenge" ? { ...result, requestSha256: "f".repeat(64) } : result;
    },
  });
  const context = setup({ provider });
  const permit = await buildSignedPermit();

  const result = await context.service.authorize(await signedInput(permit, { invocationId: "inv-challenge-binding-1" }));

  assert.equal(result.receipt.decision, "DENY");
  assert.deepEqual(result.receipt.reasonCodes, ["CHALLENGE_RESOURCE_MISMATCH"]);
  assert.equal(provider.calls.length, 0);
});
