import assert from "node:assert/strict";
import { test } from "node:test";
import { computePermitDigest } from "./authorization-request.js";
import { signPurchasePermit, signPurchasePermitV2, verifyPurchasePermit, verifyPurchasePermitV2 } from "./crypto.js";
import { validateUnsignedPurchasePermitV2 } from "./validate.js";
import {
  buildOperation,
  buildUnsignedPermit,
  buildUnsignedPermitV2,
  issuerKeypair,
  otherIssuerAddress,
  otherIssuerKeypair,
} from "./test-fixtures.js";
import type { SignedPurchasePermitV2 } from "./types.js";

const signed = await signPurchasePermitV2(buildUnsignedPermitV2(), issuerKeypair);

test("a validly signed v2 permit verifies and carries the exact operation", async () => {
  const result = await verifyPurchasePermitV2(signed);
  assert.equal(result.verified, true);
  if (result.verified) {
    assert.equal(result.permit.version, 2);
    assert.deepEqual(result.permit.operation, buildOperation());
  }
});

test("signPurchasePermitV2 refuses a key that does not match the issuer field", async () => {
  await assert.rejects(() => signPurchasePermitV2(buildUnsignedPermitV2(), otherIssuerKeypair));
});

// The human signature must cover the operation and every business argument.
const tamperCases: Array<{ name: string; change: Partial<SignedPurchasePermitV2> }> = [
  { name: "operation.operation (summarize -> export)", change: { operation: buildOperation({ operation: "export" }) } },
  { name: "operation.datasetId (dataset-a -> dataset-b)", change: { operation: buildOperation({ datasetId: "dataset-b" }) } },
  { name: "operation.resource", change: { operation: buildOperation({ resource: "/api/v1/export" }) } },
  { name: "issuer", change: { issuer: otherIssuerAddress } },
  { name: "maxTotalAtomic", change: { maxTotalAtomic: "60000" } },
  { name: "capability", change: { capability: "other.capability" } },
  { name: "expiresAt", change: { expiresAt: signed.expiresAt + 1 } },
];

for (const { name, change } of tamperCases) {
  test(`mutating a signed v2 field (${name}) invalidates the signature`, async () => {
    const result = await verifyPurchasePermitV2({ ...signed, ...change });
    assert.equal(result.verified, false);
    if (!result.verified) {
      assert.equal(result.reasonCode, "INVALID_SIGNATURE");
    }
  });
}

test("an operation widened with an unknown argument after signing fails closed", async () => {
  const result = await verifyPurchasePermitV2({ ...signed, operation: { ...signed.operation, format: "full-export" } });
  assert.equal(result.verified, false);
  if (!result.verified) {
    assert.equal(result.reasonCode, "INVALID_OPERATION");
  }
});

test("a v2 permit without an operation, or with an invalid one, is rejected", () => {
  const { operation: _dropped, ...withoutOperation } = buildUnsignedPermitV2();
  for (const candidate of [
    withoutOperation,
    { ...buildUnsignedPermitV2(), operation: null },
    { ...buildUnsignedPermitV2(), operation: { ...buildOperation(), method: "GET" } },
    { ...buildUnsignedPermitV2(), operation: { ...buildOperation(), operation: "delete" } },
  ]) {
    const result = validateUnsignedPurchasePermitV2(candidate);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.reasonCode, "INVALID_OPERATION");
    }
  }
});

test("v2 shares every v1 field rule (e.g. amounts, subdelegation, time range)", () => {
  for (const change of [{ maxPerCallAtomic: "0.01" }, { subdelegation: true }, { expiresAt: 1 }, { domain: "other" }]) {
    assert.equal(validateUnsignedPurchasePermitV2({ ...buildUnsignedPermitV2(), ...change }).valid, false, JSON.stringify(change));
  }
});

test("versions are not interchangeable: v1 and v2 signatures never verify as the other version", async () => {
  // A v2 permit relabelled as v1 (operation dropped) fails the v1 signature check.
  const { operation: _op, ...v2Fields } = signed;
  const relabelled = await verifyPurchasePermit({ ...v2Fields, version: 1 });
  assert.equal(relabelled.verified, false);

  // A v1 permit relabelled as v2 with an operation added fails the v2 signature check.
  const v1 = await signPurchasePermit(buildUnsignedPermit(), issuerKeypair);
  const upgraded = await verifyPurchasePermitV2({ ...v1, version: 2, operation: buildOperation() });
  assert.equal(upgraded.verified, false);
  if (!upgraded.verified) {
    assert.equal(upgraded.reasonCode, "INVALID_SIGNATURE");
  }

  // Each verifier rejects the other version outright.
  const v1AsV2 = await verifyPurchasePermitV2(v1);
  assert.equal(v1AsV2.verified, false);
  if (!v1AsV2.verified) {
    assert.equal(v1AsV2.reasonCode, "UNSUPPORTED_VERSION");
  }
  assert.equal((await verifyPurchasePermit(signed)).verified, false);
});

test("the v2 permit digest covers the operation and differs from any v1 digest", async () => {
  const digest = await computePermitDigest(signed);
  const other = await signPurchasePermitV2(buildUnsignedPermitV2({ operation: buildOperation({ operation: "export" }) }), issuerKeypair);
  assert.notEqual(await computePermitDigest(other), digest);
  // Extra properties never change the digest.
  assert.equal(await computePermitDigest({ ...signed, extra: "x" } as SignedPurchasePermitV2), digest);
  assert.equal(await computePermitDigest({ ...signed, operation: { ...signed.operation, extra: "x" } } as SignedPurchasePermitV2), digest);
});
