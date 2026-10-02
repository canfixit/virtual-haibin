import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import {
  verifyEvidenceBundle,
  type EvidenceBundleV1,
  type OnlineSettlementSource,
  type VerificationReport,
  type VerifierTrust,
} from "@virtual-haibin/evidence";
import { loadOrCreateSigningKey } from "@virtual-haibin/identity";
import { signPurchasePermitV2 } from "@virtual-haibin/mandate";
import {
  associatedTokenAddress,
  generateMockPaymentWallet,
  MockPaymentProvider,
  type MockExecuteBehavior,
  type RpcTransaction,
} from "@virtual-haibin/payments";
import { AuthorityRequestError, AuthorityService, ReconciliationRequiredError } from "./authorize.js";
import { createAuthorityServer } from "./server.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import type { AuthorityStore } from "./store/types.js";
import {
  APPROVED_OPERATION,
  authorityAddress,
  authoritySigner,
  buildSignedPermit,
  buildUnsignedPermit,
  issuerAddress,
  mintAddress,
  otherAgentIdentity,
  otherRecipientAddress,
  recipientAddress,
  rogueIssuerKeypair,
  signedInput,
  TEST_AUDIENCE,
  TEST_CHALLENGE_NETWORK,
  TEST_PAYMENT_CONFIG,
} from "./test-support.js";

// Phase 5A/5B: portable evidence. Bundles are produced by the real
// authorize -> pay -> export path (mock provider with a REAL signed exact
// transfer) and checked only by the standalone verifier library with
// independently pinned trust -- no authority, store or network involved.

const dir = mkdtempSync(join(tmpdir(), "vh-evidence-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const paymentWallet = await generateMockPaymentWallet();
const facilitator = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const otherMint = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const rogueAuthority = await generateKeyPair();
const rogueAuthorityAddress = await getAddressFromPublicKey(rogueAuthority.publicKey);

const TRUST: VerifierTrust = { issuer: issuerAddress, authority: authorityAddress, settlementProfiles: TEST_PAYMENT_CONFIG.settlementProfiles };

function provider(behavior: MockExecuteBehavior = "settle"): MockPaymentProvider {
  return new MockPaymentProvider({
    payer: paymentWallet,
    behavior,
    challenge: () => ({ network: TEST_CHALLENGE_NETWORK, asset: mintAddress, payTo: recipientAddress, amountAtomic: "10000", feePayer: facilitator }),
  });
}

function service(options: { store?: AuthorityStore; signer?: CryptoKeyPair; address?: string; behavior?: MockExecuteBehavior } = {}) {
  const store = options.store ?? new SqliteAuthorityStore(":memory:");
  return {
    store,
    authority: new AuthorityService({
      authoritySigner: options.signer ?? authoritySigner,
      authorityAddress: options.address ?? authorityAddress,
      audience: TEST_AUDIENCE,
      ...TEST_PAYMENT_CONFIG,
      paymentProvider: provider(options.behavior),
      store,
      log: () => {},
    }),
  };
}

async function confirmedBundle(invocationId = `inv-ev-${Math.random().toString(36).slice(2)}`): Promise<EvidenceBundleV1> {
  const { authority } = service();
  const permit = await buildSignedPermit();
  const result = await authority.authorize(await signedInput(permit, { invocationId }));
  assert.equal(result.receipt.decision, "ALLOW");
  // Round-trip through JSON: exactly what leaves the authority.
  return JSON.parse(JSON.stringify(await authority.exportEvidence(invocationId))) as EvidenceBundleV1;
}

function claim(report: VerificationReport, id: string) {
  const found = report.claims.find((entry) => entry.id === id);
  assert.ok(found, `claim ${id} missing`);
  return found;
}

function tamper(bundle: EvidenceBundleV1, change: (copy: Record<string, any>) => void): unknown {
  const copy = structuredClone(bundle) as Record<string, any>;
  change(copy);
  return copy;
}

const genuine = await confirmedBundle("inv-ev-genuine");

// ---------------------------------------------------------------------------
// The valid path
// ---------------------------------------------------------------------------

test("an exported CONFIRMED bundle verifies offline as VALID, with explicit claim statuses", async () => {
  const report = await verifyEvidenceBundle(JSON.stringify(genuine), TRUST);

  assert.equal(report.overall, "VALID", JSON.stringify(report.claims.filter((c) => c.status !== "VERIFIED")));
  assert.equal(report.decision, "ALLOW");
  assert.equal(report.purchaseState, "CONFIRMED");

  for (const id of [
    "issuer_trusted",
    "authority_trusted",
    "manifest_signature",
    "artifact_digests",
    "permit_signature",
    "agent_request_signature",
    "request_bound_to_permit",
    "authority_decision_signature",
    "operation_matches_permit",
    "operation_arguments_match",
    "method_resource_match",
    "x402_amount_matches",
    "outbound_request_matches_operation",
    "payment_attempt_matches_requirement",
    "payment_transaction",
    "result_digest",
  ]) {
    assert.equal(claim(report, id).status, "VERIFIED", id);
  }

  // Not collapsed into "valid": attested and unprovable things say so.
  assert.equal(claim(report, "settlement").status, "AUTHORITY_ATTESTED");
  assert.equal(claim(report, "total_budget_decision").status, "AUTHORITY_ATTESTED");
  assert.equal(claim(report, "global_budget_completeness").status, "NOT_PROVABLE_FROM_BUNDLE");
  assert.equal(claim(report, "result_observed_by_authority").status, "AUTHORITY_ATTESTED");
  assert.equal(claim(report, "service_result_attestation").status, "NOT_PROVABLE_FROM_BUNDLE");
  assert.ok(report.notProven.some((item) => item.includes("factually correct")));
  assert.ok(report.notProven.some((item) => item.includes("understood")));
});

test("the bundle contains public protocol artifacts only -- no keys, seeds or secrets", () => {
  const text = JSON.stringify(genuine);
  assert.doesNotMatch(text, /privateKey|secretKey|seed|"d":|approval|Bearer|AUTHORITY_SHARED_SECRET/i);
  assert.ok(genuine.paymentAttempt?.transactionBase64, "the signed transfer is included for offline checking");
});

// ---------------------------------------------------------------------------
// Tamper matrix: every security-relevant edit makes the bundle INVALID
// ---------------------------------------------------------------------------

const resignedPermit = await signPurchasePermitV2(
  { ...buildUnsignedPermit({ grantId: genuine.purchasePermit.grantId, issuer: await getAddressFromPublicKey(rogueIssuerKeypair.publicKey) }), issuedAt: genuine.purchasePermit.issuedAt, expiresAt: genuine.purchasePermit.expiresAt },
  rogueIssuerKeypair,
);

const tamperCases: Array<{ name: string; change: (copy: Record<string, any>) => void; expectInvalid: string[] }> = [
  { name: "1 PurchasePermit issuer", change: (b) => (b.purchasePermit.issuer = resignedPermit.issuer), expectInvalid: ["issuer_trusted", "permit_signature"] },
  { name: "2 PurchasePermit operation", change: (b) => (b.purchasePermit.operation.operation = "export"), expectInvalid: ["permit_signature", "artifact_digests"] },
  { name: "3 PurchasePermit datasetId", change: (b) => (b.purchasePermit.operation.datasetId = "dataset-b"), expectInvalid: ["permit_signature"] },
  { name: "4 authorizedAgent", change: (b) => (b.purchasePermit.authorizedAgent = otherRecipientAddress), expectInvalid: ["permit_signature", "agent_request_signature"] },
  { name: "5 AuthorizationRequest operation", change: (b) => (b.authorizationRequest.request.operation.operation = "export"), expectInvalid: ["agent_request_signature", "operation_matches_permit"] },
  { name: "6 AuthorizationRequest invocationId", change: (b) => (b.authorizationRequest.request.invocationId = "inv-other"), expectInvalid: ["agent_request_signature", "state_consistent"] },
  { name: "7 permitDigest", change: (b) => (b.authorizationRequest.request.permitDigest = "0".repeat(64)), expectInvalid: ["request_bound_to_permit"] },
  { name: "8 x402 amount", change: (b) => (b.paymentRequirement.amountAtomic = "20000"), expectInvalid: ["x402_amount_matches", "artifact_digests"] },
  { name: "9 x402 payTo", change: (b) => (b.paymentRequirement.payTo = otherRecipientAddress), expectInvalid: ["x402_recipient_matches"] },
  { name: "10 x402 asset", change: (b) => (b.paymentRequirement.asset = otherMint), expectInvalid: ["x402_asset_matches", "settlement_profile_match"] },
  { name: "11 payment attempt", change: (b) => (b.paymentAttempt.payerSignature = genuine.purchasePermit.signature.signature), expectInvalid: ["payment_transaction", "artifact_digests"] },
  { name: "12 settlement transaction reference", change: (b) => (b.settlement.transactionId = genuine.purchasePermit.signature.signature), expectInvalid: ["authority_decision_signature", "artifact_digests"] },
  { name: "13 result body without digest", change: (b) => (b.result.bodyBase64 = Buffer.from('{"result":"forged"}').toString("base64")), expectInvalid: ["result_digest"] },
  { name: "14 result digest", change: (b) => (b.result.sha256 = "f".repeat(64)), expectInvalid: ["result_digest", "artifact_digests"] },
  { name: "15 evidence manifest", change: (b) => (b.manifest.reasonCodes = ["OVERRIDDEN"]), expectInvalid: ["manifest_signature"] },
  { name: "16 authority signature", change: (b) => (b.manifest.signature.signature = genuine.authorityDecision!.signature.signature), expectInvalid: ["manifest_signature"] },
  { name: "17 authority public key replaced in bundle", change: (b) => (b.manifest.authority = rogueAuthorityAddress), expectInvalid: ["authority_trusted", "manifest_signature"] },
  { name: "18 issuer public key replaced (permit re-signed by another issuer)", change: (b) => (b.purchasePermit = structuredClone(resignedPermit)), expectInvalid: ["issuer_trusted", "request_bound_to_permit"] },
  { name: "19 unknown evidence version", change: (b) => (b.version = 3), expectInvalid: ["bundle_format"] },
  { name: "19b bundle version relabelled (v2 -> v1)", change: (b) => (b.version = 1), expectInvalid: ["bundle_format"] },
  { name: "20 wrong evidence domain", change: (b) => (b.domain = "other/evidence-bundle"), expectInvalid: ["bundle_format"] },
  { name: "unknown nested field", change: (b) => (b.paymentRequirement.extraTerms = "x"), expectInvalid: ["bundle_format"] },
  { name: "operation argument smuggled into the request", change: (b) => (b.authorizationRequest.request.operation.format = "full"), expectInvalid: ["bundle_format"] },
];

for (const { name, change, expectInvalid } of tamperCases) {
  test(`tamper ${name} -> INVALID`, async () => {
    const report = await verifyEvidenceBundle(tamper(genuine, change), TRUST);
    assert.equal(report.overall, "INVALID");
    for (const id of expectInvalid) {
      assert.equal(claim(report, id).status, "INVALID", `${id}: ${JSON.stringify(report.claims.find((c) => c.id === id))}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Trust roots come from verifier configuration, never from the bundle
// ---------------------------------------------------------------------------

test("an attacker authority key signing a fully consistent bundle is INVALID under the pinned real authority", async () => {
  const rogue = service({ signer: rogueAuthority, address: rogueAuthorityAddress });
  const permit = await buildSignedPermit();
  await rogue.authority.authorize(await signedInput(permit, { invocationId: "inv-rogue-authority" }));
  const forged = JSON.parse(JSON.stringify(await rogue.authority.exportEvidence("inv-rogue-authority"))) as EvidenceBundleV1;

  // Internally consistent: it verifies if (and only if) the verifier trusts the rogue key.
  assert.equal((await verifyEvidenceBundle(forged, { ...TRUST, authority: rogueAuthorityAddress })).overall, "VALID");

  const report = await verifyEvidenceBundle(forged, TRUST);
  assert.equal(report.overall, "INVALID");
  assert.equal(claim(report, "authority_trusted").status, "INVALID");
  assert.equal(claim(report, "manifest_signature").status, "INVALID");
  assert.equal(claim(report, "authority_decision_signature").status, "INVALID");
});

test("a validly signed permit is not trusted just because its issuer key verifies it", async () => {
  const report = await verifyEvidenceBundle(genuine, { ...TRUST, issuer: await getAddressFromPublicKey(rogueIssuerKeypair.publicKey) });
  assert.equal(claim(report, "permit_signature").status, "VERIFIED");
  assert.equal(claim(report, "issuer_trusted").status, "INVALID");
  assert.equal(report.overall, "INVALID");
});

// ---------------------------------------------------------------------------
// Other states
// ---------------------------------------------------------------------------

test("a DENIED semantic-operation bundle is valid evidence of a consistent denial", async () => {
  const { authority } = service();
  const permit = await buildSignedPermit();
  const denied = await authority.authorize(
    await signedInput(permit, { invocationId: "inv-ev-denied", fields: { operation: { ...APPROVED_OPERATION, operation: "export" } } }),
  );
  assert.equal(denied.receipt.decision, "DENY");
  const bundle = await authority.exportEvidence("inv-ev-denied");

  const report = await verifyEvidenceBundle(bundle, TRUST);
  assert.equal(report.overall, "VALID");
  assert.equal(report.decision, "DENY");
  assert.equal(claim(report, "operation_matches_permit").status, "NOT_SATISFIED");
  assert.equal(claim(report, "decision_matches_static_policy").status, "VERIFIED");
  assert.match(claim(report, "decision_matches_static_policy").detail ?? "", /OPERATION_NOT_AUTHORIZED/);
  assert.equal(claim(report, "payment_transaction").status, "NOT_CHECKED");
  assert.equal(claim(report, "settlement").status, "NOT_CHECKED");

  // Turning the denial into an allowance breaks the authority's signature.
  const flipped = tamper(JSON.parse(JSON.stringify(bundle)) as EvidenceBundleV1, (b) => (b.manifest.decision = "ALLOW"));
  assert.equal((await verifyEvidenceBundle(flipped, TRUST)).overall, "INVALID");
});

test("a RECONCILIATION_REQUIRED bundle never reports settlement as confirmed", async () => {
  const { authority } = service({ behavior: "unknown" });
  const permit = await buildSignedPermit();
  await assert.rejects(authority.authorize(await signedInput(permit, { invocationId: "inv-ev-recon" })), ReconciliationRequiredError);
  const bundle = await authority.exportEvidence("inv-ev-recon");

  const report = await verifyEvidenceBundle(bundle, TRUST);
  assert.equal(report.purchaseState, "RECONCILIATION_REQUIRED");
  assert.equal(claim(report, "settlement").status, "INDETERMINATE");
  assert.equal(claim(report, "payment_transaction").status, "VERIFIED");
  assert.equal(bundle.settlement, null);
  assert.equal(bundle.result, null);

  // Smuggling a settlement into a RECONCILIATION_REQUIRED bundle fails.
  const forged = tamper(JSON.parse(JSON.stringify(bundle)) as EvidenceBundleV1, (b) => (b.settlement = genuine.settlement));
  assert.equal((await verifyEvidenceBundle(forged, TRUST)).overall, "INVALID");
});

test("export refuses unknown, in-flight and pre-evidence invocations", async () => {
  const unknown = service();
  await assert.rejects(unknown.authority.exportEvidence("inv-nope"), (error: unknown) => error instanceof AuthorityRequestError && error.reasonCode === "INVOCATION_NOT_FOUND");

  const hanging = service({ behavior: "hang" });
  const permit = await buildSignedPermit();
  void hanging.authority.authorize(await signedInput(permit, { invocationId: "inv-ev-inflight" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(hanging.authority.exportEvidence("inv-ev-inflight"), (error: unknown) => error instanceof AuthorityRequestError && error.reasonCode === "EVIDENCE_NOT_FINAL");

  // A row recorded without signed artifacts (as before schema v3).
  const legacy = service();
  const input = await signedInput(permit, { invocationId: "inv-ev-legacy" });
  await legacy.store.reserve(
    {
      invocationId: "inv-ev-legacy",
      fingerprint: "f".repeat(64),
      grant: { issuer: permit.issuer, grantId: permit.grantId, permitDigest: input.authorizationRequest.permitDigest, maxTotalAtomic: permit.maxTotalAtomic },
      agent: permit.authorizedAgent,
      request: input.authorizationRequest,
      amountAtomic: "10000",
      decidedAt: Date.now(),
      paymentRequirement: null,
    },
    () => ({ allowed: false, reasonCodes: ["TOTAL_BUDGET_EXCEEDED"] }),
  );
  await assert.rejects(legacy.authority.exportEvidence("inv-ev-legacy"), (error: unknown) => error instanceof AuthorityRequestError && error.reasonCode === "EVIDENCE_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// Persistent authority key across restarts
// ---------------------------------------------------------------------------

test("the persistent authority key survives restart; old evidence still verifies; a fresh key does not", async () => {
  const keyFile = join(dir, "authority-receipt.seed");
  const dbFile = join(dir, "authority.db");

  const keyA = await loadOrCreateSigningKey(keyFile);
  const first = service({ store: new SqliteAuthorityStore(dbFile), signer: keyA.keyPair, address: keyA.address });
  const permit = await buildSignedPermit();
  await first.authority.authorize(await signedInput(permit, { invocationId: "inv-ev-restart" }));
  const oldBundle = JSON.parse(JSON.stringify(await first.authority.exportEvidence("inv-ev-restart"))) as EvidenceBundleV1;
  await first.store.close();

  // "Restart": same key file, same database.
  const keyAfterRestart = await loadOrCreateSigningKey(keyFile);
  assert.equal(keyAfterRestart.address, keyA.address);
  const second = service({ store: new SqliteAuthorityStore(dbFile), signer: keyAfterRestart.keyPair, address: keyAfterRestart.address });
  const reexported = await second.authority.exportEvidence("inv-ev-restart");
  await second.store.close();

  const pinnedA = { ...TRUST, authority: keyA.address };
  assert.equal((await verifyEvidenceBundle(oldBundle, pinnedA)).overall, "VALID");
  assert.equal((await verifyEvidenceBundle(reexported, pinnedA)).overall, "VALID");

  const keyB = await loadOrCreateSigningKey(join(dir, "other-authority.seed"));
  const underB = await verifyEvidenceBundle(oldBundle, { ...TRUST, authority: keyB.address });
  assert.equal(underB.overall, "INVALID");
  assert.equal(claim(underB, "authority_trusted").status, "INVALID");
});

// ---------------------------------------------------------------------------
// Online settlement verification (fake RPC configured by the verifier)
// ---------------------------------------------------------------------------

async function settledTx(bundle: EvidenceBundleV1, overrides: { amount?: string; err?: unknown } = {}): Promise<RpcTransaction> {
  const attempt = bundle.paymentAttempt!;
  return {
    slot: 42,
    meta: { err: overrides.err ?? null },
    transaction: {
      signatures: [bundle.settlement!.transactionId, attempt.payerSignature],
      message: {
        recentBlockhash: attempt.blockhash,
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                mint: attempt.asset,
                authority: attempt.payer,
                destination: await associatedTokenAddress(attempt.payTo, attempt.asset, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
                tokenAmount: { amount: overrides.amount ?? attempt.amountAtomic, decimals: 6 },
              },
            },
          },
        ],
      },
    },
  };
}

function rpc(answer: { version?: Record<string, unknown>; tx?: RpcTransaction | null; fail?: boolean }): OnlineSettlementSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getVersion() {
      calls.push("getVersion");
      if (answer.fail) throw new Error("connection refused");
      return answer.version ?? { "surfnet-version": "1.6.0" };
    },
    async getTransaction(signature: string) {
      calls.push(`getTransaction:${signature}`);
      return answer.tx === undefined ? null : answer.tx;
    },
  };
}

test("online mode observes settlement on the verifier-configured RPC", async () => {
  const source = rpc({ tx: await settledTx(genuine) });
  const report = await verifyEvidenceBundle(genuine, TRUST, { mode: "online", rpc: source });
  assert.equal(report.overall, "VALID");
  assert.equal(claim(report, "settlement").status, "VERIFIED");
  assert.deepEqual(source.calls, ["getVersion", `getTransaction:${genuine.settlement!.transactionId}`]);
});

test("online mode: wrong on-chain facts or a failed transaction are INVALID", async () => {
  for (const tx of [await settledTx(genuine, { amount: "20000" }), await settledTx(genuine, { err: { InstructionError: [0, "Custom"] } })]) {
    const report = await verifyEvidenceBundle(genuine, TRUST, { mode: "online", rpc: rpc({ tx }) });
    assert.equal(claim(report, "settlement").status, "INVALID");
    assert.equal(report.overall, "INVALID");
  }
});

test("online mode: unavailable network state is INDETERMINATE, not INVALID", async () => {
  for (const source of [rpc({ fail: true }), rpc({ tx: null }), rpc({ version: { "solana-core": "2.0" } })]) {
    const report = await verifyEvidenceBundle(genuine, TRUST, { mode: "online", rpc: source });
    assert.equal(claim(report, "settlement").status, "INDETERMINATE");
    assert.equal(report.overall, "INDETERMINATE");
  }
});

test("offline mode performs no settlement lookup at all", async () => {
  const report = await verifyEvidenceBundle(genuine, TRUST, { mode: "offline" });
  assert.equal(claim(report, "settlement").status, "AUTHORITY_ATTESTED");
});

// ---------------------------------------------------------------------------
// Export endpoint
// ---------------------------------------------------------------------------

test("GET /evidence/:invocationId is bearer-protected, validated, bounded and returns a verifiable bundle", async () => {
  const { authority } = service();
  const permit = await buildSignedPermit();
  await authority.authorize(await signedInput(permit, { invocationId: "inv-ev-http" }));
  const server = createAuthorityServer({ authorityService: authority, authorityAddress, sharedSecret: "test-only-shared-secret" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, bearer: string | null = "test-only-shared-secret") =>
    fetch(`${base}${path}`, { headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` } });

  try {
    assert.equal((await get("/evidence/inv-ev-http", null)).status, 401);
    assert.equal((await get("/evidence/inv-ev-http", "wrong")).status, 401);
    assert.equal((await get("/evidence/..%2F..%2Fetc")).status, 400);
    assert.equal((await get("/evidence/inv-unknown")).status, 404);

    const response = await get("/evidence/inv-ev-http");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.length < 512 * 1024);
    // Deterministic RFC 8785 output: keys sorted at the top level.
    assert.ok(text.startsWith('{"authorityDecision":'));
    assert.equal((await verifyEvidenceBundle(text, TRUST)).overall, "VALID");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("hostile input never throws and is reported INVALID", async () => {
  for (const input of ["", "not json", "null", "[]", '{"__proto__":{"x":1}}', "x".repeat(600 * 1024), 42, { version: 1 }]) {
    const report = await verifyEvidenceBundle(input, TRUST);
    assert.equal(report.overall, "INVALID");
    assert.equal(claim(report, "bundle_format").status, "INVALID");
  }

  const longString = tamper(genuine, (b) => (b.identifiers.grantId = "g".repeat(10_000)));
  assert.equal((await verifyEvidenceBundle(longString, TRUST)).overall, "INVALID");
  void otherAgentIdentity;
});
