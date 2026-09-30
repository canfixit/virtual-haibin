import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { getBase58Decoder } from "@solana/codecs-strings";
import { generateKeyPair } from "@solana/keys";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION,
  computePermitDigest,
  signAuthorizationRequest,
  validateAuthorizationRequest,
  verifyAuthorizationRequestSignature,
  type AuthorizationRequestV1,
} from "./authorization-request.js";
import { signPurchasePermit } from "./crypto.js";
import { agentAddress, agentKeypair, buildUnsignedPermit, issuerKeypair } from "./test-fixtures.js";

const permit = await signPurchasePermit(buildUnsignedPermit(), issuerKeypair);
const permitDigest = await computePermitDigest(permit);
const otherAgentKeypair = await generateKeyPair();
const strangerAddress = await getAddressFromPublicKey((await generateKeyPair()).publicKey);

function buildRequest(overrides: Partial<AuthorizationRequestV1> = {}): AuthorizationRequestV1 {
  return {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION,
    audience: "test-authority",
    grantId: permit.grantId,
    permitDigest,
    invocationId: "inv-1",
    service: permit.service,
    capability: permit.capability,
    network: permit.network,
    mint: permit.mint,
    recipient: permit.recipient,
    amountAtomic: "10000",
    issuedAt: Date.parse("2026-09-30T00:00:00.000Z"),
    ...overrides,
  };
}

const request = buildRequest();
const signature = await signAuthorizationRequest(request, agentKeypair);

test("a request signed by the authorized agent verifies", async () => {
  assert.equal(await verifyAuthorizationRequestSignature(request, signature, agentAddress), true);
});

test("a request signed by a different agent key fails", async () => {
  const otherSignature = await signAuthorizationRequest(request, otherAgentKeypair);
  assert.equal(await verifyAuthorizationRequestSignature(request, otherSignature, agentAddress), false);
});

const mutations: Array<[string, Partial<AuthorizationRequestV1>]> = [
  ["audience", { audience: "other-authority" }],
  ["grantId", { grantId: "VH-GRANT-OTHER" }],
  ["permitDigest", { permitDigest: "0".repeat(64) }],
  ["invocationId", { invocationId: "inv-2" }],
  ["service", { service: "other-service" }],
  ["capability", { capability: "other.capability" }],
  ["network", { network: "mainnet-beta" }],
  ["mint", { mint: strangerAddress }],
  ["recipient", { recipient: strangerAddress }],
  ["amountAtomic", { amountAtomic: "10001" }],
  ["issuedAt", { issuedAt: request.issuedAt + 1 }],
  ["version", { version: 2 as never }],
  ["protocol", { protocol: "other-protocol" as never }],
];

for (const [field, overrides] of mutations) {
  test(`mutating signed request field ${field} invalidates the agent signature`, async () => {
    assert.equal(await verifyAuthorizationRequestSignature(buildRequest(overrides), signature, agentAddress), false);
  });
}

test("malformed agent signatures fail closed without throwing", async () => {
  const candidates: unknown[] = [
    undefined,
    null,
    "not-an-object",
    [],
    {},
    { algorithm: "ed25519" },
    { algorithm: "ed25519", signature: "" },
    { algorithm: "ed25519", signature: "too-short" },
    { algorithm: "ed25519", signature: `0${signature.signature.slice(1)}` },
    { algorithm: "ed25519", signature: getBase58Decoder().decode(new Uint8Array(64)) },
    { algorithm: "not-ed25519", signature: signature.signature },
  ];

  for (const candidate of candidates) {
    assert.equal(await verifyAuthorizationRequestSignature(request, candidate, agentAddress), false, JSON.stringify(candidate));
  }

  assert.equal(await verifyAuthorizationRequestSignature(request, signature, "not-an-address"), false);
});

test("the permit digest is deterministic and ignores extra properties", async () => {
  assert.match(permitDigest, /^[0-9a-f]{64}$/);
  assert.equal(await computePermitDigest({ ...permit }), permitDigest);
  assert.equal(await computePermitDigest({ ...permit, extra: "ignored" } as typeof permit), permitDigest);
});

test("the permit digest changes when any permit field or the permit signature changes", async () => {
  const reissued = await signPurchasePermit(buildUnsignedPermit({ maxTotalAtomic: "60000" }), issuerKeypair);
  assert.notEqual(await computePermitDigest(reissued), permitDigest);

  const otherSignature = { ...permit, signature: { algorithm: "ed25519" as const, signature: reissued.signature.signature } };
  assert.notEqual(await computePermitDigest(otherSignature), permitDigest);
});

test("request validation accepts a well-formed request and returns only known fields", () => {
  const result = validateAuthorizationRequest({ ...request });
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.request, request);
  }
});

test("request validation rejects malformed or widened requests", () => {
  const invalid: unknown[] = [
    null,
    [],
    "string",
    { ...request, unexpected: "field" },
    { ...request, alreadySpentAtomic: "0" },
    { ...request, protocol: "other" },
    { ...request, version: 2 },
    { ...request, amountAtomic: 10000 },
    { ...request, amountAtomic: "0.01" },
    { ...request, amountAtomic: "010" },
    { ...request, amountAtomic: "-1" },
    { ...request, permitDigest: "ABC" },
    { ...request, invocationId: "" },
    { ...request, invocationId: "has space" },
    { ...request, issuedAt: 1.5 },
    { ...request, issuedAt: "1" },
    { ...request, recipient: "" },
    { ...request, recipient: "x".repeat(257) },
  ];

  for (const candidate of invalid) {
    assert.equal(validateAuthorizationRequest(candidate).valid, false, JSON.stringify(candidate)?.slice(0, 80));
  }
});

test("signAuthorizationRequest refuses to sign an invalid request", async () => {
  await assert.rejects(() => signAuthorizationRequest(buildRequest({ amountAtomic: "0.01" }), agentKeypair));
});
