import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignedPurchasePermitV1 } from "@virtual-haibin/mandate";
import { evaluatePurchasePermit, type PurchaseRequestV1 } from "./purchase-permit.js";

const ISSUED_AT = Date.parse("2026-09-22T00:00:00.000Z");

function buildPermit(overrides: Partial<SignedPurchasePermitV1> = {}): SignedPurchasePermitV1 {
  return {
    version: 1,
    domain: "virtual-haibin/purchase-permit",
    grantId: "VH-GRANT-0001",
    issuer: "11111111111111111111111111111111111111111",
    authorizedAgent: "22222222222222222222222222222222222222222",
    service: "research-agent",
    capability: "research.summary",
    network: "devnet",
    mint: "33333333333333333333333333333333333333333",
    recipient: "44444444444444444444444444444444444444444",
    maxPerCallAtomic: "20000",
    maxTotalAtomic: "50000",
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 30 * 60 * 1000,
    subdelegation: false,
    signature: { algorithm: "ed25519", signature: "test-signature" },
    ...overrides,
  };
}

function buildRequest(overrides: Partial<PurchaseRequestV1> = {}): PurchaseRequestV1 {
  const permit = buildPermit();

  return {
    service: permit.service,
    capability: permit.capability,
    network: permit.network,
    mint: permit.mint,
    recipient: permit.recipient,
    amountAtomic: "10000",
    alreadySpentAtomic: "0",
    now: permit.issuedAt + 1_000,
    ...overrides,
  };
}

test("an authorized in-budget request is allowed", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest());
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasonCodes, []);
});

test("an expired permit is denied", () => {
  const permit = buildPermit();
  const decision = evaluatePurchasePermit(permit, buildRequest({ now: permit.expiresAt + 1 }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("PERMIT_EXPIRED"));
});

test("a service mismatch is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ service: "other-service" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("SERVICE_MISMATCH"));
});

test("a capability mismatch is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ capability: "other.capability" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("CAPABILITY_MISMATCH"));
});

test("a network mismatch is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ network: "testnet" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("NETWORK_MISMATCH"));
});

test("a mint mismatch is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ mint: "some-other-mint" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("MINT_MISMATCH"));
});

test("a recipient mismatch is denied even though the amount is affordable", () => {
  const decision = evaluatePurchasePermit(
    buildPermit(),
    buildRequest({ recipient: "some-other-recipient", amountAtomic: "1" }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("RECIPIENT_MISMATCH"));
});

test("a per-call overspend is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ amountAtomic: "20001" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("PER_CALL_LIMIT_EXCEEDED"));
});

test("a total-budget overspend is denied", () => {
  const decision = evaluatePurchasePermit(
    buildPermit(),
    buildRequest({ amountAtomic: "20000", alreadySpentAtomic: "40000" }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("TOTAL_BUDGET_EXCEEDED"));
});

test("a zero amount is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ amountAtomic: "0" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("INVALID_AMOUNT"));
});

test("a malformed amount string is denied", () => {
  const decision = evaluatePurchasePermit(buildPermit(), buildRequest({ amountAtomic: "1.5" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasonCodes.includes("INVALID_AMOUNT"));
});

test("exactly consuming the remaining total budget is allowed", () => {
  const decision = evaluatePurchasePermit(
    buildPermit(),
    buildRequest({ amountAtomic: "20000", alreadySpentAtomic: "30000" }),
  );
  assert.equal(decision.allowed, true);
});
