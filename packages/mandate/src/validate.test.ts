import assert from "node:assert/strict";
import { test } from "node:test";
import { validateUnsignedPurchasePermit } from "./validate.js";
import { buildUnsignedPermit, issuerAddress } from "./test-fixtures.js";
import type { PermitReasonCode } from "./types.js";

function expectRejected(candidate: unknown, reasonCode: PermitReasonCode): void {
  const result = validateUnsignedPurchasePermit(candidate);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reasonCode, reasonCode);
  }
}

test("a well-formed permit validates", () => {
  const result = validateUnsignedPurchasePermit(buildUnsignedPermit());
  assert.equal(result.valid, true);
});

test("non-object candidates are rejected", () => {
  for (const candidate of [null, undefined, 42, "permit", [], true]) {
    expectRejected(candidate, "INVALID_SCHEMA");
  }
});

test("unknown version is rejected", () => {
  expectRejected(buildUnsignedPermit({ version: 2 as never }), "UNSUPPORTED_VERSION");
});

test("wrong domain is rejected", () => {
  expectRejected(buildUnsignedPermit({ domain: "some-other-domain" as never }), "INVALID_DOMAIN");
});

test("empty grantId is rejected", () => {
  expectRejected(buildUnsignedPermit({ grantId: "" }), "INVALID_GRANT_ID");
});

test("issuer must be a valid base58 public key", () => {
  expectRejected(buildUnsignedPermit({ issuer: "not-a-public-key" }), "INVALID_ISSUER");
});

test("authorizedAgent must be a valid base58 public key", () => {
  expectRejected(buildUnsignedPermit({ authorizedAgent: "not-a-public-key" }), "INVALID_AGENT");
});

test("empty service is rejected", () => {
  expectRejected(buildUnsignedPermit({ service: "" }), "INVALID_SERVICE");
});

test("empty capability is rejected", () => {
  expectRejected(buildUnsignedPermit({ capability: "" }), "INVALID_CAPABILITY");
});

test("unsupported network is rejected", () => {
  expectRejected(buildUnsignedPermit({ network: "mainnet-beta" as never }), "INVALID_NETWORK");
});

test("mint must be a valid base58 address", () => {
  expectRejected(buildUnsignedPermit({ mint: "not-an-address" }), "INVALID_MINT");
});

test("recipient must be a valid base58 address", () => {
  expectRejected(buildUnsignedPermit({ recipient: "not-an-address" }), "INVALID_RECIPIENT");
});

test("malformed atomic amounts are rejected", () => {
  const malformedAmounts = ["", "-1", "1.5", "01", "0x10", " 100", "100 ", "1e3", "NaN"];

  for (const amount of malformedAmounts) {
    expectRejected(buildUnsignedPermit({ maxPerCallAtomic: amount }), "INVALID_AMOUNT");
    expectRejected(buildUnsignedPermit({ maxTotalAtomic: amount }), "INVALID_AMOUNT");
  }
});

test("zero or negative-equivalent atomic amounts are rejected", () => {
  expectRejected(buildUnsignedPermit({ maxPerCallAtomic: "0" }), "INVALID_AMOUNT");
  expectRejected(buildUnsignedPermit({ maxTotalAtomic: "0" }), "INVALID_AMOUNT");
});

test("atomic amounts beyond u64 range are rejected", () => {
  expectRejected(buildUnsignedPermit({ maxTotalAtomic: "18446744073709551616" }), "INVALID_AMOUNT");
});

test("max-per-call exceeding max-total is rejected", () => {
  expectRejected(
    buildUnsignedPermit({ maxPerCallAtomic: "60000", maxTotalAtomic: "50000" }),
    "INVALID_AMOUNT",
  );
});

test("non-finite or non-positive timestamps are rejected", () => {
  expectRejected(buildUnsignedPermit({ issuedAt: 0 }), "INVALID_TIME_RANGE");
  expectRejected(buildUnsignedPermit({ issuedAt: Number.POSITIVE_INFINITY }), "INVALID_TIME_RANGE");
  expectRejected(buildUnsignedPermit({ expiresAt: Number.NaN }), "INVALID_TIME_RANGE");
});

test("expiry at or before issuance is rejected", () => {
  const issuedAt = Date.now();
  expectRejected(buildUnsignedPermit({ issuedAt, expiresAt: issuedAt }), "INVALID_TIME_RANGE");
  expectRejected(buildUnsignedPermit({ issuedAt, expiresAt: issuedAt - 1 }), "INVALID_TIME_RANGE");
});

test("subdelegation must be false", () => {
  expectRejected(buildUnsignedPermit({ subdelegation: true as never }), "INVALID_SUBDELEGATION");
});

test("validation does not smuggle unknown extra fields into the returned permit", () => {
  const candidate = { ...buildUnsignedPermit(), maliciousExtraField: "widened-authority" };
  const result = validateUnsignedPurchasePermit(candidate);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal((result.permit as Record<string, unknown>).maliciousExtraField, undefined);
  }
});

test("public keys are rejected when not in canonical base58 form", () => {
  expectRejected(buildUnsignedPermit({ issuer: ` ${issuerAddress}` }), "INVALID_ISSUER");
});

test("a signature field on the candidate is stripped, never smuggled into the validated permit", () => {
  const candidateWithSignature = {
    ...buildUnsignedPermit(),
    signature: { algorithm: "ed25519", signature: "irrelevant" },
  };

  const result = validateUnsignedPurchasePermit(candidateWithSignature);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal((result.permit as Record<string, unknown>).signature, undefined);
  }
});
