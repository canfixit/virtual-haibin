import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import {
  checkServiceAuthorization,
  computeEvidenceDigests,
  signEvidenceManifest,
  decodeServiceAuthorizationHeader,
  encodeServiceHeader,
  SERVICE_ACKNOWLEDGEMENT_DOMAIN,
  signServiceAcknowledgement,
  verifyEvidenceBundle,
  verifyServiceAuthorizationSignature,
  type EvidenceBundle,
  type VerificationReport,
  type VerifierTrust,
} from "@virtual-haibin/evidence";
import { generateMockPaymentWallet, MockPaymentProvider, type ExecuteInput } from "@virtual-haibin/payments";
import { AuthorityService, ReconciliationRequiredError, type AuthorityLogEntry } from "./authorize.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import {
  authorityAddress,
  authoritySigner,
  buildSignedPermit,
  issuerAddress,
  mintAddress,
  recipientAddress,
  signedInput,
  TEST_AUDIENCE,
  TEST_CHALLENGE_NETWORK,
  TEST_PAYMENT_CONFIG,
  TEST_RESOURCE,
} from "./test-support.js";

// Phase 5C: the authority -> service authorization and the service's signed
// acknowledgement, end to end through the authority, exported evidence and
// the standalone verifier. The simulated service below uses exactly the
// checks the real service runs (checkServiceAuthorization).

const paymentWallet = await generateMockPaymentWallet();
const facilitator = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const serviceKey = await generateKeyPair();
const serviceAddress = await getAddressFromPublicKey(serviceKey.publicKey);
const rogueService = await generateKeyPair();
const rogueServiceAddress = await getAddressFromPublicKey(rogueService.publicKey);

const TRUST: VerifierTrust = { issuer: issuerAddress, authority: authorityAddress, settlementProfiles: TEST_PAYMENT_CONFIG.settlementProfiles };
const TRUST_WITH_SERVICE: VerifierTrust = { ...TRUST, service: serviceAddress };

type ServiceBehavior = "honest" | "rogue-key" | "wrong-result" | "refuse-unauthorized";

/** A Virtual Haibin-integrated service: verifies the authorization, then acknowledges. */
function simulatedService(behavior: ServiceBehavior, seen: Array<{ authorizationHeader: string | undefined }>) {
  return async (input: ExecuteInput, response: { body: Buffer; sha256: string; transactionId: string }) => {
    seen.push({ authorizationHeader: input.serviceAuthorizationHeader });
    const check = await checkServiceAuthorization({
      header: behavior === "refuse-unauthorized" ? undefined : input.serviceAuthorizationHeader,
      pinnedAuthority: authorityAddress,
      method: input.request.method,
      path: new URL(input.request.url).pathname,
      rawBody: Buffer.from(input.request.body, "utf8"),
      invocationIdHeader: input.reference,
      expectedPayment: { asset: input.requirement.asset, payTo: input.requirement.payTo, amountAtomic: input.requirement.amountAtomic },
      now: Date.now(),
    });

    if (!check.ok) {
      throw new Error(check.reasonCode);
    }

    const signer = behavior === "rogue-key" ? rogueService : serviceKey;
    const ack = await signServiceAcknowledgement(
      {
        version: 1,
        domain: SERVICE_ACKNOWLEDGEMENT_DOMAIN,
        service: await getAddressFromPublicKey(signer.publicKey),
        invocationId: input.reference,
        authorizationDigest: check.authorizationDigest,
        requestSha256: check.requestSha256,
        received: { method: "POST", resource: "/api/v1/report", operation: "summarize", datasetId: "dataset-a" },
        payment: { transaction: response.transactionId, asset: input.requirement.asset, payTo: input.requirement.payTo, amountAtomic: input.requirement.amountAtomic },
        result: { httpStatus: 200, contentType: "application/json", sha256: behavior === "wrong-result" ? "e".repeat(64) : response.sha256, bytes: response.body.byteLength },
        fulfilledAt: Date.now(),
      },
      signer,
    );
    return { acknowledgementHeader: encodeServiceHeader(ack) };
  };
}

function setup(behavior: ServiceBehavior = "honest") {
  const seen: Array<{ authorizationHeader: string | undefined }> = [];
  const logs: AuthorityLogEntry[] = [];
  const provider = new MockPaymentProvider({
    payer: paymentWallet,
    challenge: () => ({ network: TEST_CHALLENGE_NETWORK, asset: mintAddress, payTo: recipientAddress, amountAtomic: "10000", feePayer: facilitator }),
    service: simulatedService(behavior, seen),
  });
  const store = new SqliteAuthorityStore(":memory:");
  const authority = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    ...TEST_PAYMENT_CONFIG,
    trustedServiceKeys: new Map([[TEST_RESOURCE.serviceId, serviceAddress]]),
    paymentProvider: provider,
    store,
    log: (entry) => logs.push(entry),
  });
  return { authority, provider, store, seen, logs };
}

async function purchase(behavior: ServiceBehavior = "honest", invocationId = `inv-5c-${Math.random().toString(36).slice(2)}`) {
  const context = setup(behavior);
  const permit = await buildSignedPermit();
  const result = await context.authority.authorize(await signedInput(permit, { invocationId }));
  const bundle = JSON.parse(JSON.stringify(await context.authority.exportEvidence(invocationId))) as EvidenceBundle;
  return { ...context, result, bundle, invocationId };
}

function claim(report: VerificationReport, id: string) {
  const found = report.claims.find((entry) => entry.id === id);
  assert.ok(found, `claim ${id} missing`);
  return found;
}

const honest = await purchase("honest", "inv-5c-honest");

// ---------------------------------------------------------------------------
// Authority -> service authorization
// ---------------------------------------------------------------------------

test("the service authorization is signed by the authority, sent only with the paid retry, and persisted with the attempt", async () => {
  const { provider, seen, store, invocationId } = honest;
  assert.equal(provider.challengesFetched.length, 1); // unpaid probe: no ExecuteInput, no header
  assert.equal(seen.length, 1);

  const header = provider.executions[0]?.serviceAuthorizationHeader;
  assert.ok(header);
  const authorization = decodeServiceAuthorizationHeader(header);
  assert.equal(await verifyServiceAuthorizationSignature(authorization, authorityAddress), true);
  assert.equal(authorization.invocationId, invocationId);
  assert.equal(authorization.request.requestSha256, provider.executions[0]?.request.sha256);
  assert.deepEqual(authorization.payment, { network: TEST_CHALLENGE_NETWORK, asset: mintAddress, payTo: recipientAddress, amountAtomic: "10000" });
  assert.ok(authorization.expiresAt - authorization.issuedAt <= 120_000);
  assert.deepEqual((await store.getInvocation(invocationId))?.serviceAuthorization, authorization);
});

test("a service that refuses the request (e.g. unauthorized) never settles: RECONCILIATION_REQUIRED, never retried", async () => {
  const context = setup("refuse-unauthorized");
  const permit = await buildSignedPermit();
  await assert.rejects(context.authority.authorize(await signedInput(permit, { invocationId: "inv-5c-refused" })), ReconciliationRequiredError);
  await assert.rejects(context.authority.authorize(await signedInput(permit, { invocationId: "inv-5c-refused" })), ReconciliationRequiredError);
  assert.equal(context.provider.executions.length, 1);
  assert.equal(context.provider.ledger.size, 0, "nothing settled");

  context.provider.lookupWhenMissing = { status: "expired", currentBlockHeight: "2000" };
  await context.authority.reconcile();
  assert.equal((await context.store.getInvocation("inv-5c-refused"))?.state, "FAILED");
});

// ---------------------------------------------------------------------------
// Service acknowledgement in evidence
// ---------------------------------------------------------------------------

test("a CONFIRMED v2 bundle with the pinned service's acknowledgement is VALID and SERVICE_ATTESTED", async () => {
  assert.equal(honest.bundle.version, 2);
  const report = await verifyEvidenceBundle(honest.bundle, TRUST_WITH_SERVICE);

  assert.equal(report.overall, "VALID", JSON.stringify(report.claims.filter((c) => c.status === "INVALID")));
  assert.equal(claim(report, "service_authorization").status, "VERIFIED");
  assert.equal(claim(report, "service_trusted").status, "VERIFIED");
  assert.equal(claim(report, "service_acknowledgement").status, "VERIFIED");
  assert.equal(claim(report, "service_result_attestation").status, "SERVICE_ATTESTED");
  // Signatures never make the content correct.
  assert.equal(claim(report, "result_correctness").status, "NOT_PROVABLE_FROM_BUNDLE");
  assert.ok(honest.logs.some((entry) => entry.event === "authority.service_acknowledged"));
});

test("without a pinned service key the service's statement is NOT verified, only reported as unchecked", async () => {
  const report = await verifyEvidenceBundle(honest.bundle, TRUST);
  assert.equal(report.overall, "VALID");
  assert.equal(claim(report, "service_authorization").status, "VERIFIED");
  assert.equal(claim(report, "service_trusted").status, "NOT_CHECKED");
  assert.equal(claim(report, "service_acknowledgement").status, "NOT_CHECKED");
  assert.equal(claim(report, "service_result_attestation").status, "NOT_PROVABLE_FROM_BUNDLE");
});

const tampers: Array<{ name: string; change: (b: Record<string, any>) => void; invalid: string[] }> = [
  { name: "acknowledged result digest", change: (b) => (b.serviceAcknowledgement.result.sha256 = "d".repeat(64)), invalid: ["service_acknowledgement", "artifact_digests"] },
  { name: "acknowledged operation", change: (b) => (b.serviceAcknowledgement.received.operation = "export"), invalid: ["service_acknowledgement"] },
  { name: "acknowledged transaction", change: (b) => (b.serviceAcknowledgement.payment.transaction = b.purchasePermit.signature.signature), invalid: ["service_acknowledgement"] },
  { name: "service key named in the acknowledgement", change: (b) => (b.serviceAcknowledgement.service = rogueServiceAddress), invalid: ["service_trusted", "service_acknowledgement"] },
  { name: "acknowledgement removed", change: (b) => (b.serviceAcknowledgement = null), invalid: ["service_acknowledgement", "artifact_digests"] },
  { name: "authorized amount", change: (b) => (b.serviceAuthorization.payment.amountAtomic = "20000"), invalid: ["service_authorization", "artifact_digests"] },
  { name: "authorized request digest", change: (b) => (b.serviceAuthorization.request.requestSha256 = "0".repeat(64)), invalid: ["service_authorization"] },
  { name: "unknown field in the acknowledgement", change: (b) => (b.serviceAcknowledgement.extra = 1), invalid: ["bundle_format"] },
];

for (const { name, change, invalid } of tampers) {
  test(`tamper ${name} -> INVALID`, async () => {
    const copy = structuredClone(honest.bundle) as Record<string, any>;
    change(copy);
    const report = await verifyEvidenceBundle(copy, TRUST_WITH_SERVICE);
    assert.equal(report.overall, "INVALID");
    for (const id of invalid) {
      assert.equal(claim(report, id).status, "INVALID", `${id}: ${JSON.stringify(report.claims.find((c) => c.id === id))}`);
    }
  });
}

test("an acknowledgement signed by an unpinned key is dropped by the authority; pinning the real service then makes the bundle INVALID", async () => {
  const rogue = await purchase("rogue-key");
  assert.equal(rogue.result.receipt.decision, "ALLOW"); // payment is unaffected
  assert.ok(rogue.logs.some((entry) => entry.event === "authority.service_acknowledgement_rejected"));
  assert.equal((rogue.bundle as { serviceAcknowledgement: unknown }).serviceAcknowledgement, null);

  assert.equal((await verifyEvidenceBundle(rogue.bundle, TRUST)).overall, "VALID");
  const pinned = await verifyEvidenceBundle(rogue.bundle, TRUST_WITH_SERVICE);
  assert.equal(pinned.overall, "INVALID");
  assert.equal(claim(pinned, "service_acknowledgement").status, "INVALID");
});

test("an acknowledgement for different result bytes is dropped by the authority", async () => {
  const wrong = await purchase("wrong-result");
  assert.equal(wrong.result.receipt.decision, "ALLOW");
  assert.ok(wrong.logs.some((entry) => entry.event === "authority.service_acknowledgement_rejected" && String(entry.reason).includes("result")));
  assert.equal((wrong.bundle as { serviceAcknowledgement: unknown }).serviceAcknowledgement, null);
});

test("legacy EvidenceBundleV1 still verifies; it simply carries no service exchange", async () => {
  const bundle = await honest.authority.exportEvidence(honest.invocationId, { bundleVersion: 1 });
  assert.equal(bundle.version, 1);
  const report = await verifyEvidenceBundle(JSON.parse(JSON.stringify(bundle)), TRUST_WITH_SERVICE);
  assert.equal(report.overall, "VALID");
  assert.equal(claim(report, "service_acknowledgement").status, "NOT_CHECKED");
  assert.equal(claim(report, "service_result_attestation").status, "NOT_PROVABLE_FROM_BUNDLE");
});

test("a validly signed acknowledgement that disagrees with the bundle is INVALID even if the authority vouched for it", async () => {
  // A buggy or colluding authority includes a genuine service signature over
  // DIFFERENT facts and re-signs the manifest. Every signature verifies; the
  // verifier must still catch the inconsistency itself.
  const original = honest.bundle as Extract<EvidenceBundle, { version: 2 }>;
  const genuineAck = original.serviceAcknowledgement!;

  for (const [name, change] of [
    ["result bytes", { result: { ...genuineAck.result, sha256: "c".repeat(64) } }],
    ["payment transaction", { payment: { ...genuineAck.payment, transaction: original.purchasePermit.signature.signature } }],
    ["performed operation", { received: { ...genuineAck.received, operation: "export" } }],
  ] as const) {
    const { signature: _old, ...unsigned } = genuineAck;
    const resignedAck = await signServiceAcknowledgement({ ...unsigned, ...change }, serviceKey);
    const { manifest, ...artifacts } = { ...original, serviceAcknowledgement: resignedAck };
    const { signature: _sig, ...unsignedManifest } = manifest;
    const resigned = { ...artifacts, manifest: await signEvidenceManifest({ ...unsignedManifest, digests: (await computeEvidenceDigests(artifacts)) as typeof manifest.digests }, authoritySigner) };

    const report = await verifyEvidenceBundle(JSON.parse(JSON.stringify(resigned)), TRUST_WITH_SERVICE);
    assert.equal(claim(report, "manifest_signature").status, "VERIFIED", name);
    assert.equal(claim(report, "artifact_digests").status, "VERIFIED", name);
    assert.equal(claim(report, "service_acknowledgement").status, "INVALID", name);
    assert.equal(report.overall, "INVALID", name);
  }
});
