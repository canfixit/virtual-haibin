import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { createRpcSettlementSource } from "./online.js";
import { signEvidenceManifest, verifyEvidenceManifestSignature } from "./manifest.js";
import { EvidenceFormatError, MAX_BUNDLE_BYTES, parseEvidenceBundle } from "./parse.js";
import { NOT_PROVEN } from "./verify.js";
import {
  decodeServiceAcknowledgementHeader,
  decodeServiceAuthorizationHeader,
  encodeServiceHeader,
  SERVICE_AUTHORIZATION_DOMAIN,
  signServiceAuthorization,
  verifyServiceAuthorizationSignature,
} from "./service.js";
import { EVIDENCE_MANIFEST_DOMAIN, type UnsignedEvidenceManifestV1 } from "./types.js";

const authority = await generateKeyPair();
const authorityAddress = await getAddressFromPublicKey(authority.publicKey);
const other = await generateKeyPair();
const otherAddress = await getAddressFromPublicKey(other.publicKey);

const unsigned: UnsignedEvidenceManifestV1 = {
  version: 1,
  domain: EVIDENCE_MANIFEST_DOMAIN,
  authority: authorityAddress,
  issuedAt: 1,
  settlementProfile: "solana-payment-sandbox",
  grantId: "g",
  invocationId: "i",
  purchaseState: "CONFIRMED",
  decision: "ALLOW",
  reasonCodes: [],
  digests: {
    purchasePermit: "a".repeat(64),
    authorizationRequest: "b".repeat(64),
    operation: "c".repeat(64),
    authorityDecision: null,
    outboundRequest: null,
    paymentRequirement: null,
    paymentAttempt: null,
    settlement: null,
    result: null,
  },
};

test("a manifest verifies only against the pinned authority key it names", async () => {
  const manifest = await signEvidenceManifest(unsigned, authority);
  assert.equal(await verifyEvidenceManifestSignature(manifest, authorityAddress), true);
  assert.equal(await verifyEvidenceManifestSignature(manifest, otherAddress), false);
  assert.equal(await verifyEvidenceManifestSignature({ ...manifest, invocationId: "j" }, authorityAddress), false);
  assert.equal(await verifyEvidenceManifestSignature({ ...manifest, digests: { ...manifest.digests, result: "d".repeat(64) } }, authorityAddress), false);

  // Self-describing keys are not trust: a manifest signed by `other` naming `other` fails under the pinned key.
  const forged = await signEvidenceManifest({ ...unsigned, authority: otherAddress }, other);
  assert.equal(await verifyEvidenceManifestSignature(forged, authorityAddress), false);
  await assert.rejects(signEvidenceManifest(unsigned, other), /does not match/);
});

test("the parser fails closed with EvidenceFormatError on hostile input", () => {
  const cases: unknown[] = [
    "",
    "{",
    "[]",
    "null",
    "x".repeat(MAX_BUNDLE_BYTES + 1),
    { version: 1 },
    { version: 2, domain: "virtual-haibin/evidence-bundle" },
    JSON.stringify({ constructor: { prototype: {} } }),
  ];

  for (const input of cases) {
    assert.throws(() => parseEvidenceBundle(input), EvidenceFormatError, typeof input === "string" ? input.slice(0, 20) : JSON.stringify(input));
  }
});

test("NOT_PROVEN states the limits explicitly", () => {
  const text = NOT_PROVEN.join(" | ");
  for (const phrase of ["understood", "bypassed policy on some other invocation", "global cumulative budget", "factually correct", "consumed", "RPC is honest"]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("the online RPC client uses only the configured URL, refuses redirects and bounds responses", async () => {
  assert.throws(() => createRpcSettlementSource("ftp://example"));
  assert.throws(() => createRpcSettlementSource("https://user:pass@example"));

  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fake = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), redirect: init?.redirect });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { "surfnet-version": "1" } }));
  }) as typeof fetch;
  const source = createRpcSettlementSource("https://rpc.example/", { fetchImpl: fake });
  assert.deepEqual(await source.getVersion(), { "surfnet-version": "1" });
  assert.deepEqual(seen, [{ url: "https://rpc.example/", redirect: "error" }]);

  const huge = createRpcSettlementSource("https://rpc.example/", { fetchImpl: (async () => new Response("x".repeat(300 * 1024))) as typeof fetch });
  await assert.rejects(huge.getVersion(), /too large/);
});

// ---------------------------------------------------------------------------
// Phase 5C service messages
// ---------------------------------------------------------------------------


test("service authorization headers round-trip strictly and verify only against the pinned authority", async () => {
  const authorization = await signServiceAuthorization(
    {
      version: 1,
      domain: SERVICE_AUTHORIZATION_DOMAIN,
      authority: authorityAddress,
      invocationId: "inv-1",
      grantId: "g",
      request: { method: "POST", url: "http://service/api/v1/report", contentType: "application/json", requestSha256: "a".repeat(64) },
      operationDigest: "b".repeat(64),
      payment: { network: "n", asset: "m", payTo: "p", amountAtomic: "10000" },
      issuedAt: 1,
      expiresAt: 2,
    },
    authority,
  );
  const decoded = decodeServiceAuthorizationHeader(encodeServiceHeader(authorization));
  assert.deepEqual(decoded, authorization);
  assert.equal(await verifyServiceAuthorizationSignature(decoded, authorityAddress), true);
  assert.equal(await verifyServiceAuthorizationSignature(decoded, otherAddress), false);
  assert.equal(await verifyServiceAuthorizationSignature({ ...decoded, invocationId: "inv-2" }, authorityAddress), false);

  for (const header of ["", "!!!", "x".repeat(5000), Buffer.from('{"version":1}').toString("base64url"), encodeServiceHeader({ ...authorization, extra: 1 } as typeof authorization)]) {
    assert.throws(() => decodeServiceAuthorizationHeader(header), EvidenceFormatError);
    assert.throws(() => decodeServiceAcknowledgementHeader(header), EvidenceFormatError);
  }
});
