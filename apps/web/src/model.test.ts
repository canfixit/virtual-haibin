import assert from "node:assert/strict";
import { test } from "node:test";
import { buildComparison, buildTimeline, formatToken, formatUnits, groupClaims, shorten, type DemoResponse, type Permit, type VerificationReport } from "./model.js";

const op = (operation: string, datasetId = "dataset-a") => ({ method: "POST", resource: "/api/v1/report", operation, datasetId });
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAY_TO = "6hqZufQGmDeGCHtiSNnGT246hdpdBUZTUzgKbonDXSTb";

const permit: Permit = {
  grantId: "g",
  issuer: "issuer",
  authorizedAgent: "agent",
  service: "mock-dataset-reports",
  recipient: PAY_TO,
  mint: MINT,
  maxPerCallAtomic: "20000",
  maxTotalAtomic: "50000",
  expiresAt: 0,
  operation: op("summarize"),
};

function response(decision: "ALLOW" | "DENY", operation: string, paid: boolean): DemoResponse {
  return {
    status: decision === "ALLOW" ? "COMPLETED" : "DENIED",
    invocationId: `inv-${operation}`,
    operation: op(operation),
    quote: { service: "mock-dataset-reports", method: "POST", resource: "/api/v1/report", network: "solana-payment-sandbox", mint: MINT, recipient: PAY_TO, amountAtomic: "10000" },
    authorization: {
      decision,
      replay: false,
      receipt: {
        decision,
        reasonCodes: decision === "DENY" ? ["OPERATION_NOT_AUTHORIZED"] : [],
        service: "mock-dataset-reports",
        capability: "reports.generate",
        network: "solana-payment-sandbox",
        mint: MINT,
        recipient: PAY_TO,
        amountAtomic: "10000",
        permitDigest: "a".repeat(64),
        paymentTransactionId: paid ? "TX123456789abcdef" : null,
      },
      payment: paid
        ? { protocol: "x402", asset: MINT, payTo: PAY_TO, amountAtomic: "10000", payerSignature: "sig", transactionId: "TX123456789abcdef", requestSha256: "b".repeat(64), settlementProfile: "solana-payment-sandbox" }
        : null,
      result: paid ? { result: { kind: "summary" } } : null,
    },
  };
}

const allowed = response("ALLOW", "summarize", true);
const blocked = response("DENY", "export", false);

test("amounts are formatted from integer strings without floating point", () => {
  assert.equal(formatUnits("50000"), "50,000");
  assert.equal(formatUnits("18446744073709551615"), "18,446,744,073,709,551,615");
  assert.equal(formatToken("10000", 6), "0.01");
  assert.equal(formatToken("1000000", 6), "1");
  assert.equal(formatToken("1", 6), "0.000001");
  assert.equal(formatToken("0.1", 6), "—");
  assert.equal(shorten("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), "EPjF…Dt1v");
});

test("the comparison is computed from the two real requests: only the operation differs", () => {
  const rows = buildComparison(permit, allowed, blocked);
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));

  for (const label of ["Merchant", "Endpoint", "Token", "Recipient", "Price", "Dataset", "Human permit"]) {
    assert.equal(byLabel[label]?.same, true, label);
  }
  assert.equal(byLabel["Agent asks"]?.same, false);
  assert.equal(byLabel["Agent asks"]?.allowed, "summarize");
  assert.equal(byLabel["Agent asks"]?.blocked, "export");
  assert.equal(byLabel.Decision?.allowed, "ALLOW");
  assert.equal(byLabel.Decision?.blocked, "DENY");
  assert.equal(byLabel.Payment?.allowed, "SETTLED");
  assert.equal(byLabel.Payment?.blocked, "NONE");
});

test("a differing payment term would be flagged, never asserted equal", () => {
  const cheaper = response("DENY", "export", false);
  cheaper.authorization!.receipt.amountAtomic = "5000";
  const rows = buildComparison(permit, allowed, cheaper);
  assert.equal(rows.find((row) => row.label === "Price")?.same, false);
});

test("without both runs nothing is claimed to be the same", () => {
  const rows = buildComparison(permit, allowed, null);
  assert.ok(rows.every((row) => row.same === null));
});

test("the ALLOW timeline is driven by real state; service authorization waits for the verifier", () => {
  const before = buildTimeline(allowed, { bundleFetched: false, report: null });
  const state = (steps: typeof before, id: string) => steps.find((step) => step.id === id)?.state;
  assert.equal(state(before, "operation"), "done");
  assert.equal(state(before, "payment"), "done");
  assert.equal(state(before, "service-authorization"), "pending");
  assert.equal(state(before, "evidence"), "pending");

  const report = { overall: "VALID", mode: "offline", decision: "ALLOW", purchaseState: "CONFIRMED", invocationId: "x", claims: [{ id: "service_authorization", category: "SERVICE", status: "VERIFIED", required: true }], notProven: [] } as VerificationReport;
  const after = buildTimeline(allowed, { bundleFetched: true, report });
  assert.equal(state(after, "service-authorization"), "done");
  assert.equal(state(after, "evidence"), "done");
});

test("the DENY timeline stops at the operation: nothing after it is shown as done", () => {
  const steps = buildTimeline(blocked, { bundleFetched: false, report: null });
  const index = steps.findIndex((step) => step.id === "operation");
  assert.equal(steps[index]?.state, "blocked");
  assert.match(steps[index]?.detail ?? "", /OPERATION_NOT_AUTHORIZED/);
  assert.ok(steps.slice(index + 1).every((step) => step.state === "not-reached"));
});

test("every verifier claim is shown in a group; unknown claims are kept", () => {
  const report = {
    overall: "VALID",
    mode: "online",
    decision: "ALLOW",
    purchaseState: "CONFIRMED",
    invocationId: "x",
    claims: [
      { id: "issuer_trusted", category: "TRUST", status: "VERIFIED", required: true },
      { id: "service_result_attestation", category: "SERVICE", status: "SERVICE_ATTESTED", required: false },
      { id: "result_correctness", category: "SERVICE", status: "NOT_PROVABLE_FROM_BUNDLE", required: false },
      { id: "some_future_claim", category: "OTHER", status: "VERIFIED", required: false },
    ],
    notProven: [],
  } as VerificationReport;
  const groups = groupClaims(report);
  const ids = groups.flatMap((group) => group.claims.map((claim) => claim.id));
  assert.deepEqual(ids.sort(), report.claims.map((claim) => claim.id).sort());
  assert.equal(groups.find((group) => group.id === "limits")?.claims[0]?.id, "result_correctness");
  assert.equal(groups.at(-1)?.id, "other");
});
