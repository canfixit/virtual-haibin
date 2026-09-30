import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { getBase58Decoder } from "@solana/codecs-strings";
import { generateKeyPair, signBytes } from "@solana/keys";
import { canonicalizeUnsignedPurchasePermit } from "./canonical.js";
import { signPurchasePermit, verifyPurchasePermit } from "./crypto.js";
import {
  agentAddress,
  buildUnsignedPermit,
  issuerKeypair,
  mintAddress,
  otherIssuerAddress,
  otherIssuerKeypair,
  recipientAddress,
} from "./test-fixtures.js";
import type { SignedPurchasePermitV1, UnsignedPurchasePermitV1 } from "./types.js";

const validUnsigned = buildUnsignedPermit();
const validSigned = await signPurchasePermit(validUnsigned, issuerKeypair);

// Extra addresses used only to prove tampered fields still fail even though
// the replacement value is itself well-formed.
const strangerAddress1 = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const strangerAddress2 = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const strangerAddress3 = await getAddressFromPublicKey((await generateKeyPair()).publicKey);

test("a validly signed permit verifies", async () => {
  const result = await verifyPurchasePermit(validSigned);
  assert.equal(result.verified, true);
  if (result.verified) {
    assert.equal(result.permit.grantId, validUnsigned.grantId);
  }
});

test("signPurchasePermit refuses to sign with a key that does not match the issuer field", async () => {
  await assert.rejects(() => signPurchasePermit(validUnsigned, otherIssuerKeypair));
});

const tamperCases: Array<{ name: string; overrides: Partial<UnsignedPurchasePermitV1> }> = [
  { name: "grantId", overrides: { grantId: "VH-GRANT-0002" } },
  { name: "issuer", overrides: { issuer: otherIssuerAddress } },
  { name: "authorizedAgent", overrides: { authorizedAgent: strangerAddress1 } },
  { name: "service", overrides: { service: "other-service" } },
  { name: "capability", overrides: { capability: "other.capability" } },
  { name: "mint", overrides: { mint: strangerAddress2 } },
  { name: "recipient", overrides: { recipient: strangerAddress3 } },
  { name: "maxPerCallAtomic", overrides: { maxPerCallAtomic: "25000" } },
  { name: "maxTotalAtomic", overrides: { maxTotalAtomic: "60000" } },
  { name: "issuedAt", overrides: { issuedAt: validUnsigned.issuedAt + 1_000 } },
  { name: "expiresAt", overrides: { expiresAt: validUnsigned.expiresAt + 1_000 } },
];

for (const { name, overrides } of tamperCases) {
  test(`mutating a signed field (${name}) invalidates the signature`, async () => {
    const tampered: SignedPurchasePermitV1 = { ...validSigned, ...overrides };
    const result = await verifyPurchasePermit(tampered);
    assert.equal(result.verified, false);
    if (!result.verified) {
      assert.equal(result.reasonCode, "INVALID_SIGNATURE");
    }
  });
}

test("mutating network fails (only one supported network exists, so schema validation catches it)", async () => {
  const tampered = { ...validSigned, network: "mainnet-beta" };
  const result = await verifyPurchasePermit(tampered);
  assert.equal(result.verified, false);
  if (!result.verified) {
    assert.equal(result.reasonCode, "INVALID_NETWORK");
  }
});

test("mutating subdelegation fails (only `false` is a valid v1 value, so schema validation catches it)", async () => {
  const tampered = { ...validSigned, subdelegation: true };
  const result = await verifyPurchasePermit(tampered);
  assert.equal(result.verified, false);
  if (!result.verified) {
    assert.equal(result.reasonCode, "INVALID_SUBDELEGATION");
  }
});

test("a signature produced by a key other than the declared issuer fails verification", async () => {
  const bytes = canonicalizeUnsignedPurchasePermit(validUnsigned);
  const forgedRawSignature = await signBytes(otherIssuerKeypair.privateKey, bytes);

  const forged: SignedPurchasePermitV1 = {
    ...validUnsigned,
    signature: { algorithm: "ed25519", signature: getBase58Decoder().decode(forgedRawSignature) },
  };

  const result = await verifyPurchasePermit(forged);
  assert.equal(result.verified, false);
  if (!result.verified) {
    assert.equal(result.reasonCode, "INVALID_SIGNATURE");
  }
});

test("malformed signature metadata fails closed instead of throwing", async () => {
  const validSignatureString = validSigned.signature.signature;
  // '0' is not part of the base58 alphabet, so this exercises the decode-failure path
  // (as opposed to just the length fast-path) while keeping the string in-range.
  const invalidCharacterSignature = `0${validSignatureString.slice(1)}`;

  const malformedCandidates: unknown[] = [
    { ...validSigned, signature: { algorithm: "ed25519", signature: "" } },
    { ...validSigned, signature: { algorithm: "ed25519", signature: "too-short" } },
    { ...validSigned, signature: { algorithm: "ed25519", signature: invalidCharacterSignature } },
    { ...validSigned, signature: { algorithm: "ed25519", signature: getBase58Decoder().decode(new Uint8Array(10)) } },
    { ...validSigned, signature: { algorithm: "not-ed25519", signature: validSignatureString } },
    { ...validSigned, signature: { algorithm: "ed25519" } },
    { ...validSigned, signature: "not-an-object" },
    { ...validSigned, signature: null },
    { ...validSigned, signature: undefined },
  ];

  for (const candidate of malformedCandidates) {
    await assert.doesNotReject(() => verifyPurchasePermit(candidate));
    const result = await verifyPurchasePermit(candidate);
    assert.equal(result.verified, false);
  }
});

test("verification never throws on arbitrary malformed input", async () => {
  for (const candidate of [null, undefined, 42, "a string", [], {}, () => {}]) {
    await assert.doesNotReject(() => verifyPurchasePermit(candidate));
  }
});

test("canonicalization is deterministic regardless of object construction order", () => {
  const a = { ...validUnsigned };
  const b: UnsignedPurchasePermitV1 = {
    subdelegation: validUnsigned.subdelegation,
    expiresAt: validUnsigned.expiresAt,
    issuedAt: validUnsigned.issuedAt,
    maxTotalAtomic: validUnsigned.maxTotalAtomic,
    maxPerCallAtomic: validUnsigned.maxPerCallAtomic,
    recipient: recipientAddress,
    mint: mintAddress,
    network: validUnsigned.network,
    capability: validUnsigned.capability,
    service: validUnsigned.service,
    authorizedAgent: agentAddress,
    issuer: validUnsigned.issuer,
    grantId: validUnsigned.grantId,
    domain: validUnsigned.domain,
    version: validUnsigned.version,
  };

  assert.deepEqual(canonicalizeUnsignedPurchasePermit(a), canonicalizeUnsignedPurchasePermit(b));
});
