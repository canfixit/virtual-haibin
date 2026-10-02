import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION_2,
  computePermitDigest,
  signAuthorizationRequest,
  validateAuthorizationRequest,
  validateAuthorizationRequestV2,
  verifyAuthorizationRequestSignature,
  type AuthorizationRequestV2,
} from "./authorization-request.js";
import { signPurchasePermitV2 } from "./crypto.js";
import { agentAddress, agentKeypair, buildOperation, buildUnsignedPermitV2, issuerKeypair } from "./test-fixtures.js";

const permit = await signPurchasePermitV2(buildUnsignedPermitV2(), issuerKeypair);
const permitDigest = await computePermitDigest(permit);

function buildRequest(overrides: Partial<AuthorizationRequestV2> = {}): AuthorizationRequestV2 {
  return {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION_2,
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
    issuedAt: Date.parse("2026-10-01T00:00:00.000Z"),
    operation: buildOperation(),
    ...overrides,
  };
}

test("a v2 request signed by the authorized agent verifies", async () => {
  const request = buildRequest();
  const signature = await signAuthorizationRequest(request, agentKeypair);
  assert.equal(await verifyAuthorizationRequestSignature(request, signature, agentAddress), true);
});

test("modifying the operation or any argument after the agent signed fails verification", async () => {
  const request = buildRequest();
  const signature = await signAuthorizationRequest(request, agentKeypair);

  for (const operation of [
    buildOperation({ operation: "export" }),
    buildOperation({ datasetId: "dataset-b" }),
    buildOperation({ resource: "/api/v1/other" }),
  ]) {
    assert.equal(await verifyAuthorizationRequestSignature({ ...request, operation }, signature, agentAddress), false);
  }
});

test("a v2 signature is not a v1 signature over the same fields (version is domain-separated)", async () => {
  const request = buildRequest();
  const signature = await signAuthorizationRequest(request, agentKeypair);
  const { operation: _dropped, ...rest } = request;
  assert.equal(await verifyAuthorizationRequestSignature({ ...rest, version: 1 }, signature, agentAddress), false);
});

test("v2 validation requires a strictly valid operation and rejects unknown fields anywhere", () => {
  assert.equal(validateAuthorizationRequestV2(buildRequest()).valid, true);

  const { operation: _dropped, ...withoutOperation } = buildRequest();
  const invalid: unknown[] = [
    withoutOperation,
    { ...buildRequest(), operation: { ...buildOperation(), format: "csv" } },
    { ...buildRequest(), operation: { ...buildOperation(), method: "GET" } },
    { ...buildRequest(), operation: { ...buildOperation(), operation: "delete" } },
    { ...buildRequest(), body: '{"operation":"export"}' },
    { ...buildRequest(), version: 1 },
  ];

  for (const candidate of invalid) {
    assert.equal(validateAuthorizationRequestV2(candidate).valid, false, JSON.stringify(candidate));
  }
});

test("the v1 validator still accepts only v1 requests (unchanged semantics)", () => {
  assert.equal(validateAuthorizationRequest(buildRequest()).valid, false);
});

test("validation returns only known fields, as an explicit copy", () => {
  const result = validateAuthorizationRequestV2(buildRequest());
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(Object.keys(result.request).sort(), Object.keys(buildRequest()).sort());
    assert.deepEqual(result.request.operation, buildOperation());
  }
});
