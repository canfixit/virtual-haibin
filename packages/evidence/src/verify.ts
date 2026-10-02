import { createHash } from "node:crypto";
import {
  computeOperationDigest,
  computePermitDigest,
  operationRequestBody,
  operationsEqual,
  validateAuthorizationRequestV2,
  verifyAuthorizationRequestSignature,
  verifyPurchasePermitV2,
} from "@virtual-haibin/mandate";
import {
  checkSettledTransaction,
  computePaidRequestDigest,
  validateExactPaymentTransaction,
  verifyTransactionPayerSignature,
  type RpcTransaction,
  type SettlementProfile,
} from "@virtual-haibin/payments";
import { evaluateExactOperation, evaluatePurchasePermit } from "@virtual-haibin/policy";
import { computeEvidenceDigests, verifyEvidenceManifestSignature } from "./manifest.js";
import { EvidenceFormatError, parseEvidenceBundle } from "./parse.js";
import { verifyAuthorizationReceiptSignature } from "./receipt.js";
import { serviceAuthorizationDigest, verifyServiceAcknowledgementSignature, verifyServiceAuthorizationSignature } from "./service.js";
import type { Claim, ClaimCategory, ClaimStatus, EvidenceBundle, VerificationReport } from "./types.js";

/**
 * Verifier trust configuration. Everything here comes from the verifier's
 * own configuration -- NEVER from the bundle. A bundle may name keys, but a
 * key named by the bundle is trusted only if it equals the pinned one.
 */
export type VerifierTrust = {
  /** Pinned human-issuer public key (base58). */
  issuer: string;
  /** Pinned Virtual Haibin authority receipt/manifest public key (base58). */
  authority: string;
  /** Known settlement profiles by name (offline facts: accepted networks, assets, scheme, blockhash prefix). */
  settlementProfiles: ReadonlyMap<string, SettlementProfile>;
  /**
   * Optional pinned paid-service public key (base58). When set, a CONFIRMED
   * v2 bundle must carry that service's valid signed acknowledgement.
   */
  service?: string;
};

/** Read-only access to the verifier-configured settlement RPC (online mode only). */
export type OnlineSettlementSource = {
  getVersion(): Promise<Record<string, unknown>>;
  getTransaction(signature: string): Promise<RpcTransaction | null>;
};

export type VerifyOptions = { mode: "offline" } | { mode: "online"; rpc: OnlineSettlementSource };

/** Properties no single bundle can establish, in any mode. Reported verbatim. */
export const NOT_PROVEN = [
  "that the human understood the permit they approved",
  "that the authority never bypassed policy on some other invocation",
  "the complete global cumulative budget history of the grant",
  "that no other payment was made for the same intent outside this invocation",
  "that the paid service's returned information is factually correct",
  "that the recipient actually consumed or acted on the result",
  "that the configured settlement RPC is honest (it is trusted, not trustless)",
] as const;

const ALLOW_STATES = new Set(["CONFIRMED", "FAILED", "RECONCILIATION_REQUIRED"]);

function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class Claims {
  readonly list: Claim[] = [];

  add(id: string, category: ClaimCategory, status: ClaimStatus, required: boolean, detail?: string): void {
    this.list.push(detail === undefined ? { id, category, status, required } : { id, category, status, required, detail });
  }

  /** VERIFIED when `problems` is empty, otherwise `failStatus` with the problems as detail. */
  check(id: string, category: ClaimCategory, problems: string[], required: boolean, failStatus: ClaimStatus = "INVALID", okDetail?: string): void {
    this.add(id, category, problems.length === 0 ? "VERIFIED" : failStatus, required, problems.length === 0 ? okDetail : problems.join("; "));
  }
}

function overallOf(claims: Claim[]): VerificationReport["overall"] {
  if (claims.some((claim) => claim.status === "INVALID")) {
    return "INVALID";
  }

  const unmet = claims.filter((claim) => claim.required && claim.status !== "VERIFIED");

  if (unmet.length === 0) {
    return "VALID";
  }

  return unmet.every((claim) => claim.status === "INDETERMINATE") ? "INDETERMINATE" : "INVALID";
}

/**
 * Verifies an EvidenceBundleV1 against independently pinned trust roots.
 * Never contacts the authority; offline mode performs no I/O at all; online
 * mode only queries the verifier-configured settlement RPC. Never throws on
 * hostile input: every problem becomes a claim.
 */
export async function verifyEvidenceBundle(input: unknown, trust: VerifierTrust, options: VerifyOptions = { mode: "offline" }): Promise<VerificationReport> {
  const claims = new Claims();
  let bundle: EvidenceBundle;

  try {
    bundle = parseEvidenceBundle(input);
  } catch (error) {
    const detail = error instanceof EvidenceFormatError ? error.message : "bundle could not be parsed";
    claims.add("bundle_format", "FORMAT", "INVALID", true, detail);
    return { overall: "INVALID", mode: options.mode, decision: null, purchaseState: null, invocationId: null, claims: claims.list, notProven: [...NOT_PROVEN] };
  }

  claims.add("bundle_format", "FORMAT", "VERIFIED", true, `EvidenceBundleV${bundle.version}, strict schema`);

  try {
    await verifyParsed(bundle, trust, options, claims);
  } catch (error) {
    // Defensive: a verifier bug must never produce VALID.
    claims.add("verifier_internal", "FORMAT", "INVALID", true, error instanceof Error ? error.message : "unknown error");
  }

  return {
    overall: overallOf(claims.list),
    mode: options.mode,
    decision: bundle.manifest.decision,
    purchaseState: bundle.manifest.purchaseState,
    invocationId: bundle.identifiers.invocationId,
    claims: claims.list,
    notProven: [...NOT_PROVEN],
  };
}

async function verifyParsed(bundle: EvidenceBundle, trust: VerifierTrust, options: VerifyOptions, claims: Claims): Promise<void> {
  const { manifest, purchasePermit: permit, authorityDecision: receipt, paymentRequirement: requirement, paymentAttempt: attempt } = bundle;
  const { request, agentSignature } = bundle.authorizationRequest;
  const state = manifest.purchaseState;
  const allowed = ALLOW_STATES.has(state);
  const confirmed = state === "CONFIRMED";

  // ---- TRUST: keys named by the bundle must equal the pinned keys. --------
  claims.check(
    "issuer_trusted",
    "TRUST",
    permit.issuer === trust.issuer ? [] : [`permit issuer ${permit.issuer} is not the pinned trusted issuer`],
    true,
    "INVALID",
    "permit issuer equals the pinned issuer key",
  );
  const authorityProblems: string[] = [];
  if (manifest.authority !== trust.authority) authorityProblems.push(`manifest authority ${manifest.authority} is not the pinned authority`);
  if (receipt !== null && receipt.authority !== trust.authority) authorityProblems.push(`receipt authority ${receipt.authority} is not the pinned authority`);
  claims.check("authority_trusted", "TRUST", authorityProblems, true, "INVALID", "manifest (and receipt) authority equals the pinned authority key");

  // ---- INTEGRITY: manifest signature + recomputed artifact digests. -------
  claims.check(
    "manifest_signature",
    "INTEGRITY",
    (await verifyEvidenceManifestSignature(manifest, trust.authority)) ? [] : ["manifest signature does not verify against the pinned authority key"],
    true,
  );

  const { manifest: _manifest, ...artifacts } = bundle;
  const recomputed = await computeEvidenceDigests(artifacts);
  const recomputedDigests = recomputed as Record<string, string | null>;
  const signedDigests = manifest.digests as Record<string, string | null>;
  const digestProblems = [...new Set([...Object.keys(recomputedDigests), ...Object.keys(signedDigests)])]
    .filter((name) => recomputedDigests[name] !== signedDigests[name])
    .map((name) => `${name} digest does not match the signed manifest`);
  claims.check("artifact_digests", "INTEGRITY", digestProblems, true, "INVALID", "every bundled artifact re-hashes to its manifest digest");

  // ---- INTEGRITY: identifiers and state shape agree everywhere. -----------
  const stateProblems: string[] = [];
  const ids = { grantId: bundle.identifiers.grantId, invocationId: bundle.identifiers.invocationId };
  if (manifest.grantId !== ids.grantId || permit.grantId !== ids.grantId || request.grantId !== ids.grantId) stateProblems.push("grantId differs between artifacts");
  if (manifest.invocationId !== ids.invocationId || request.invocationId !== ids.invocationId) stateProblems.push("invocationId differs between artifacts");
  if (manifest.settlementProfile !== bundle.environment.settlementProfile || permit.network !== bundle.environment.settlementProfile) {
    stateProblems.push("settlement profile differs between environment, manifest and permit");
  }
  if ((manifest.decision === "DENY") !== (state === "DENIED")) stateProblems.push(`decision ${manifest.decision} is inconsistent with state ${state}`);
  const expectReceipt = state === "CONFIRMED" || state === "DENIED";
  if ((receipt !== null) !== expectReceipt) stateProblems.push(`state ${state} ${expectReceipt ? "requires" : "must not carry"} a decision receipt`);
  if (receipt !== null) {
    if (receipt.invocationId !== ids.invocationId || receipt.grantId !== ids.grantId) stateProblems.push("receipt identifiers differ");
    if (receipt.decision !== manifest.decision || JSON.stringify(receipt.reasonCodes) !== JSON.stringify(manifest.reasonCodes)) {
      stateProblems.push("receipt decision/reason codes differ from the manifest");
    }
  }
  if (confirmed) {
    for (const [name, value] of [["outboundRequest", bundle.outboundRequest], ["paymentRequirement", requirement], ["paymentAttempt", attempt], ["settlement", bundle.settlement], ["result", bundle.result]] as const) {
      if (value === null) stateProblems.push(`CONFIRMED requires ${name}`);
    }
  } else if (bundle.settlement !== null || bundle.result !== null) {
    stateProblems.push(`state ${state} must not carry settlement or result evidence`);
  }
  if (state === "RECONCILIATION_REQUIRED" && attempt === null) stateProblems.push("RECONCILIATION_REQUIRED requires the recorded payment attempt");
  if (state === "DENIED" && attempt !== null) stateProblems.push("DENIED must not carry a payment attempt");
  if (bundle.version === 2) {
    if (bundle.serviceAcknowledgement !== null && !confirmed) stateProblems.push(`state ${state} must not carry a service acknowledgement`);
    if (bundle.serviceAuthorization !== null && attempt === null) stateProblems.push("a service authorization requires a payment attempt");
  }
  claims.check("state_consistent", "INTEGRITY", stateProblems, true, "INVALID", `${state}: identifiers and artifacts agree`);

  // ---- AUTHORIZATION ------------------------------------------------------
  const permitVerification = await verifyPurchasePermitV2(permit);
  claims.check(
    "permit_signature",
    "AUTHORIZATION",
    permitVerification.verified ? [] : [`${permitVerification.reasonCode}: ${permitVerification.message}`],
    true,
    "INVALID",
    "PurchasePermit v2 signature valid for its issuer",
  );

  const requestValid = validateAuthorizationRequestV2(request);
  const agentSigned = requestValid.valid && (await verifyAuthorizationRequestSignature(requestValid.request, agentSignature, permit.authorizedAgent));
  claims.check(
    "agent_request_signature",
    "AUTHORIZATION",
    agentSigned ? [] : [requestValid.valid ? "request is not signed by the permit's authorizedAgent" : requestValid.message],
    true,
    "INVALID",
    "AuthorizationRequest v2 signed by the permit's authorizedAgent",
  );

  const permitDigest = await computePermitDigest(permit);
  claims.check(
    "request_bound_to_permit",
    "AUTHORIZATION",
    request.permitDigest === permitDigest ? [] : ["request permitDigest is not the digest of the bundled permit"],
    true,
    "INVALID",
    "request.permitDigest equals the recomputed permit digest",
  );

  if (receipt === null) {
    claims.add("authority_decision_signature", "AUTHORIZATION", "NOT_CHECKED", false, `no decision receipt for state ${state}; the decision is attested by the manifest only`);
  } else {
    const problems: string[] = [];
    if (!(await verifyAuthorizationReceiptSignature(receipt, trust.authority))) problems.push("receipt signature does not verify against the pinned authority key");
    const fields = ["service", "capability", "network", "mint", "recipient", "amountAtomic", "permitDigest"] as const;
    for (const field of fields) if (receipt[field] !== request[field]) problems.push(`receipt ${field} differs from the signed request`);
    if (receipt.agent !== permit.authorizedAgent) problems.push("receipt agent is not the permit's authorizedAgent");
    if (!operationsEqual(receipt.operation, request.operation)) problems.push("receipt operation differs from the signed request");
    if (receipt.operationDigest !== (await computeOperationDigest(request.operation))) problems.push("receipt operationDigest is wrong");
    if (confirmed && receipt.paymentTransactionId !== bundle.settlement?.transactionId) problems.push("receipt transaction differs from the settlement evidence");
    claims.check("authority_decision_signature", "AUTHORIZATION", problems, true, "INVALID", `signed ${receipt.decision} receipt by the pinned authority, consistent with the request`);
  }

  // ---- STATIC POLICY (recomputed; budget is NOT static) --------------------
  const operationCodes = evaluateExactOperation(permit.operation, request.operation).reasonCodes as string[];
  const permitCodes = evaluatePurchasePermit(permit, {
    service: request.service,
    capability: request.capability,
    network: request.network,
    mint: request.mint,
    recipient: request.recipient,
    amountAtomic: request.amountAtomic,
    alreadySpentAtomic: "0",
    now: request.issuedAt,
  }).reasonCodes.filter((code) => code !== "TOTAL_BUDGET_EXCEEDED") as string[];
  if (request.issuedAt < permit.issuedAt) permitCodes.push("PERMIT_NOT_YET_VALID");
  const staticCodes = [...new Set([...operationCodes, ...permitCodes])];

  const policyClaims: Array<[string, string[], string]> = [
    ["permit_time_bounds", ["PERMIT_EXPIRED", "PERMIT_NOT_YET_VALID"], "request signed within the permit's validity window"],
    ["service_capability_match", ["SERVICE_MISMATCH", "CAPABILITY_MISMATCH"], "service and capability match the permit"],
    ["network_profile_match", ["NETWORK_MISMATCH"], "network matches the permit"],
    ["mint_match", ["MINT_MISMATCH"], "requested mint matches the permit"],
    ["recipient_match", ["RECIPIENT_MISMATCH"], "requested recipient matches the permit"],
    ["per_call_limit", ["PER_CALL_LIMIT_EXCEEDED", "INVALID_AMOUNT"], "amount is positive and within the per-call limit"],
    ["method_resource_match", ["OPERATION_METHOD_MISMATCH", "OPERATION_RESOURCE_MISMATCH"], "method and resource match the human-approved operation"],
    ["operation_matches_permit", ["OPERATION_NOT_AUTHORIZED"], "requested operation equals the human-approved operation"],
    ["operation_arguments_match", ["OPERATION_ARGUMENT_NOT_AUTHORIZED"], "datasetId equals the human-approved argument"],
  ];

  for (const [id, codes, okDetail] of policyClaims) {
    const hits = staticCodes.filter((code) => codes.includes(code));
    // In a DENY bundle a failed condition is expected evidence, not tampering.
    claims.check(id, "STATIC_POLICY", hits, allowed, allowed ? "INVALID" : "NOT_SATISFIED", okDetail);
  }

  if (allowed) {
    claims.check(
      "decision_matches_static_policy",
      "STATIC_POLICY",
      staticCodes.length === 0 ? [] : [`authority allowed, but static policy fails: ${staticCodes.join(", ")}`],
      true,
      "INVALID",
      "ALLOW is consistent with every recomputed static constraint",
    );
  } else if (staticCodes.length > 0) {
    const missing = staticCodes.filter((code) => !manifest.reasonCodes.includes(code));
    claims.check(
      "decision_matches_static_policy",
      "STATIC_POLICY",
      missing.map((code) => `recomputed ${code} is not among the authority's reasons`),
      true,
      "INVALID",
      `DENY independently justified: ${staticCodes.join(", ")}`,
    );
  } else {
    claims.add("decision_matches_static_policy", "STATIC_POLICY", "AUTHORITY_ATTESTED", false, `DENY for non-static reasons (${manifest.reasonCodes.join(", ")}); attested by the authority`);
  }

  // ---- PAYMENT CONSISTENCY ------------------------------------------------
  const profile = trust.settlementProfiles.get(permit.network);
  const payment = allowed && requirement !== null;

  if (!payment) {
    for (const id of ["settlement_profile_match", "x402_asset_matches", "x402_recipient_matches", "x402_amount_matches", "outbound_request_matches_operation", "payment_attempt_matches_requirement", "payment_transaction"]) {
      claims.add(id, "PAYMENT", "NOT_CHECKED", false, state === "DENIED" ? "denied: no payment was made" : "no payment requirement was obtained");
    }
  } else {
    const profileProblems: string[] = [];
    if (profile === undefined) {
      profileProblems.push(`verifier has no trusted settlement profile named ${permit.network}`);
    } else {
      if (manifest.settlementProfile !== profile.name) profileProblems.push("manifest settlement profile is not the permit's profile");
      if (requirement.protocol !== profile.protocol || requirement.x402Version !== profile.x402Version) profileProblems.push("unsupported payment protocol/version");
      if (requirement.scheme !== profile.scheme) profileProblems.push("unsupported payment scheme");
      if (!profile.acceptedChallengeNetworks.includes(requirement.network)) profileProblems.push("challenge network not accepted by the profile");
      if (!profile.allowedAssets.some((asset) => asset.mint === requirement.asset)) profileProblems.push("asset not allowed by the profile");
      if (attempt !== null && attempt.settlementProfile !== profile.name) profileProblems.push("payment attempt names another settlement profile");
      if (attempt !== null && !attempt.blockhash.startsWith(profile.requiredBlockhashPrefix)) profileProblems.push("payment is not bound to a blockhash of the profile's environment");
    }
    claims.check("settlement_profile_match", "PAYMENT", profileProblems, true, "INVALID", `x402 ${requirement.scheme} on ${permit.network}`);

    claims.check("x402_asset_matches", "PAYMENT", requirement.asset === request.mint && request.mint === permit.mint ? [] : ["x402 asset differs from the authorized mint"], true, "INVALID", "x402 asset == request mint == permit mint");
    claims.check("x402_recipient_matches", "PAYMENT", requirement.payTo === request.recipient && request.recipient === permit.recipient ? [] : ["x402 payTo differs from the authorized recipient"], true, "INVALID", "x402 payTo == request recipient == permit recipient");
    claims.check(
      "x402_amount_matches",
      "PAYMENT",
      requirement.amountAtomic === request.amountAtomic && BigInt(requirement.amountAtomic) <= BigInt(permit.maxPerCallAtomic) ? [] : ["x402 amount differs from the authorized amount or exceeds the per-call limit"],
      true,
      "INVALID",
      `x402 amount ${requirement.amountAtomic} == request amount, <= per-call limit`,
    );

    const outbound = bundle.outboundRequest;
    const outboundProblems: string[] = [];
    if (outbound === null) {
      outboundProblems.push("no outbound request evidence");
    } else {
      const op = request.operation;
      let path: string | null = null;
      try {
        path = new URL(outbound.url).pathname;
      } catch {
        outboundProblems.push("outbound URL is malformed");
      }
      if (outbound.method !== op.method) outboundProblems.push("outbound method differs from the authorized operation");
      if (path !== null && path !== op.resource) outboundProblems.push("outbound path differs from the authorized resource");
      if (outbound.body !== operationRequestBody(op)) outboundProblems.push("outbound body is not the authorized operation");
      if (computePaidRequestDigest(outbound) !== outbound.sha256) outboundProblems.push("outbound request digest does not match its contents");
      if (requirement.resourceUrl !== outbound.url) outboundProblems.push("x402 resource URL differs from the outbound URL");
      if (attempt !== null && attempt.requestSha256 !== outbound.sha256) outboundProblems.push("payment attempt pays for a different request");
    }
    claims.check("outbound_request_matches_operation", "PAYMENT", outboundProblems, true, "INVALID", "outbound POST body/path re-derived from the signed operation; attempt pays for that request digest");

    if (attempt === null) {
      claims.add("payment_attempt_matches_requirement", "PAYMENT", "NOT_CHECKED", false, "no payment attempt was recorded (never submitted)");
      claims.add("payment_transaction", "PAYMENT", "NOT_CHECKED", false, "no payment attempt");
    } else {
      const problems: string[] = [];
      for (const [field, expected] of [
        ["scheme", requirement.scheme],
        ["network", requirement.network],
        ["asset", requirement.asset],
        ["payTo", requirement.payTo],
        ["amountAtomic", requirement.amountAtomic],
        ["feePayer", requirement.feePayer],
        ["resourceUrl", requirement.resourceUrl],
      ] as const) {
        if (attempt[field] !== expected) problems.push(`attempt ${field} differs from the selected x402 requirement`);
      }
      if (attempt.feePayer === attempt.payer) problems.push("payment wallet must not be the fee payer");
      claims.check("payment_attempt_matches_requirement", "PAYMENT", problems, true, "INVALID", "attempt facts equal the selected requirement");

      if (attempt.transactionBase64 === undefined) {
        claims.add("payment_transaction", "PAYMENT", "NOT_CHECKED", false, "attempt carries no transaction bytes");
      } else {
        const tx = await validateExactPaymentTransaction(attempt.transactionBase64, {
          payer: attempt.payer,
          feePayer: attempt.feePayer,
          asset: attempt.asset,
          payTo: attempt.payTo,
          amountAtomic: attempt.amountAtomic,
          blockhash: attempt.blockhash,
        });
        const txProblems: string[] = [];
        if (!tx.valid) txProblems.push(`transaction does not match the attempt: ${tx.reason}`);
        else if (tx.payerSignature !== attempt.payerSignature) txProblems.push("transaction payer signature differs from the recorded attempt");
        if (!(await verifyTransactionPayerSignature(attempt.transactionBase64, attempt.payer))) txProblems.push("payer signature does not verify over the transaction message");
        claims.check("payment_transaction", "PAYMENT", txProblems, true, "INVALID", "payer signed exactly this TransferChecked (amount, mint, payTo token account, blockhash)");
      }
    }
  }

  // ---- RESULT ---------------------------------------------------------------
  if (bundle.result === null) {
    claims.add("result_digest", "RESULT", "NOT_CHECKED", false, `no result for state ${state}`);
  } else {
    let bytes: Buffer | null = null;
    try {
      bytes = Buffer.from(bundle.result.bodyBase64, "base64");
    } catch {
      bytes = null;
    }
    const problems: string[] = [];
    if (bytes === null || bytes.toString("base64") !== bundle.result.bodyBase64) problems.push("result body is not canonical base64");
    else if (sha256HexOf(bytes) !== bundle.result.sha256 || bytes.byteLength !== bundle.result.bytes) problems.push("result bytes do not hash to the recorded result digest");
    claims.check("result_digest", "RESULT", problems, true, "INVALID", "bundled result bytes hash to the recorded SHA-256");
    claims.add("result_observed_by_authority", "RESULT", "AUTHORITY_ATTESTED", false, "the authority's signed manifest binds this result to the invocation; the service did not sign it");
  }

  // ---- BUDGET ---------------------------------------------------------------
  claims.add(
    "total_budget_decision",
    "BUDGET",
    "AUTHORITY_ATTESTED",
    false,
    manifest.reasonCodes.includes("TOTAL_BUDGET_EXCEEDED")
      ? "authority denied for the grant's total budget (its durable state, not in the bundle)"
      : "reserved + consumed + amount <= maxTotal was decided by the authority against its durable state",
  );
  claims.add("global_budget_completeness", "BUDGET", "NOT_PROVABLE_FROM_BUNDLE", false, "one bundle does not contain the grant's complete invocation history");

  // ---- SERVICE (Phase 5C) ---------------------------------------------------
  await serviceClaims(bundle, trust, claims);

  // ---- SETTLEMENT -----------------------------------------------------------
  await settlementClaims(bundle, profile, options, claims);
}

async function serviceClaims(bundle: EvidenceBundle, trust: VerifierTrust, claims: Claims): Promise<void> {
  const correctness = () =>
    claims.add("result_correctness", "SERVICE", "NOT_PROVABLE_FROM_BUNDLE", false, "whether the returned information is correct is never provable from signatures");

  if (bundle.version === 1) {
    for (const id of ["service_authorization", "service_trusted", "service_acknowledgement"]) {
      claims.add(id, "SERVICE", "NOT_CHECKED", false, "EvidenceBundleV1 predates the service authorization exchange");
    }
    claims.add("service_result_attestation", "SERVICE", "NOT_PROVABLE_FROM_BUNDLE", false, "no service signature in a v1 bundle");
    correctness();
    return;
  }

  const { serviceAuthorization: authorization, serviceAcknowledgement: ack, outboundRequest: outbound, paymentRequirement: requirement } = bundle;
  const { request } = bundle.authorizationRequest;
  const confirmed = bundle.manifest.purchaseState === "CONFIRMED";

  // What the authority told the service (verifiable with the pinned AUTHORITY key).
  if (authorization === null) {
    claims.add("service_authorization", "SERVICE", "NOT_CHECKED", false, bundle.paymentAttempt === null ? "no payment was attempted" : "no service authorization recorded for this attempt");
  } else {
    const problems: string[] = [];
    if (!(await verifyServiceAuthorizationSignature(authorization, trust.authority))) problems.push("authorization is not signed by the pinned authority");
    if (authorization.invocationId !== bundle.identifiers.invocationId || authorization.grantId !== bundle.identifiers.grantId) problems.push("authorization identifiers differ");
    if (outbound === null || authorization.request.url !== outbound.url || authorization.request.requestSha256 !== outbound.sha256) problems.push("authorization covers a different HTTP request");
    if (authorization.operationDigest !== (await computeOperationDigest(request.operation))) problems.push("authorization covers a different operation");
    if (
      requirement === null ||
      authorization.payment.network !== requirement.network ||
      authorization.payment.asset !== requirement.asset ||
      authorization.payment.payTo !== requirement.payTo ||
      authorization.payment.amountAtomic !== requirement.amountAtomic
    ) {
      problems.push("authorization payment terms differ from the x402 requirement");
    }
    claims.check("service_authorization", "SERVICE", problems, true, "INVALID", "authority-signed service authorization for exactly this request, operation and payment");
  }

  // What the service said back (verifiable only with a PINNED service key).
  if (trust.service === undefined) {
    claims.add("service_trusted", "SERVICE", "NOT_CHECKED", false, "no service key pinned (--service-trust)");
    claims.add("service_acknowledgement", "SERVICE", "NOT_CHECKED", false, ack === null ? "no service acknowledgement" : "present, but no service key pinned to verify it");
    claims.add("service_result_attestation", "SERVICE", "NOT_PROVABLE_FROM_BUNDLE", false, "no pinned service key");
    correctness();
    return;
  }

  if (!confirmed) {
    claims.add("service_trusted", "SERVICE", "NOT_CHECKED", false, `no fulfillment for state ${bundle.manifest.purchaseState}`);
    claims.add("service_acknowledgement", "SERVICE", "NOT_CHECKED", false, `no fulfillment for state ${bundle.manifest.purchaseState}`);
    claims.add("service_result_attestation", "SERVICE", "NOT_PROVABLE_FROM_BUNDLE", false, "nothing was fulfilled");
    correctness();
    return;
  }

  if (ack === null) {
    claims.add("service_trusted", "SERVICE", "INVALID", true, "a service key is pinned but the bundle has no service acknowledgement");
    claims.add("service_acknowledgement", "SERVICE", "INVALID", true, "missing");
    claims.add("service_result_attestation", "SERVICE", "NOT_PROVABLE_FROM_BUNDLE", false, "no service acknowledgement");
    correctness();
    return;
  }

  claims.check("service_trusted", "SERVICE", ack.service === trust.service ? [] : [`acknowledgement service ${ack.service} is not the pinned service`], true, "INVALID", "acknowledgement names the pinned service key");

  const problems: string[] = [];
  if (!(await verifyServiceAcknowledgementSignature(ack, trust.service))) problems.push("acknowledgement is not signed by the pinned service key");
  if (ack.invocationId !== bundle.identifiers.invocationId) problems.push("acknowledgement is for another invocation");
  if (authorization === null || ack.authorizationDigest !== (await serviceAuthorizationDigest(authorization))) problems.push("acknowledgement accepted a different authorization");
  if (outbound === null || ack.requestSha256 !== outbound.sha256) problems.push("service received a different HTTP request");
  const op = request.operation;
  if (ack.received.method !== op.method || ack.received.resource !== op.resource || ack.received.operation !== op.operation || ack.received.datasetId !== op.datasetId) {
    problems.push("service reports performing a different operation");
  }
  if (requirement === null || ack.payment.asset !== requirement.asset || ack.payment.payTo !== requirement.payTo || ack.payment.amountAtomic !== requirement.amountAtomic) {
    problems.push("service reports different payment terms");
  }
  if (ack.payment.transaction !== bundle.settlement?.transactionId) problems.push("service reports a different payment transaction");
  const result = bundle.result;
  if (result === null || ack.result.sha256 !== result.sha256 || ack.result.bytes !== result.bytes || ack.result.httpStatus !== result.httpStatus) {
    problems.push("service signed different result bytes than the bundle carries");
  }
  claims.check(
    "service_acknowledgement",
    "SERVICE",
    problems,
    true,
    "INVALID",
    `signed by the pinned service: accepted this authorization, performed ${op.operation}(${op.datasetId}), paid by ${ack.payment.transaction ?? "?"}, returned these result bytes`,
  );
  claims.add(
    "service_result_attestation",
    "SERVICE",
    problems.length === 0 ? "SERVICE_ATTESTED" : "INVALID",
    false,
    "the service (not only the authority) attests it produced exactly this result for this paid request",
  );
  correctness();
}

async function settlementClaims(bundle: EvidenceBundle, profile: SettlementProfile | undefined, options: VerifyOptions, claims: Claims): Promise<void> {
  const state = bundle.manifest.purchaseState;
  const attempt = bundle.paymentAttempt;
  const settlement = bundle.settlement;

  if (state !== "CONFIRMED" || settlement === null || attempt === null) {
    const detail =
      state === "RECONCILIATION_REQUIRED"
        ? "payment outcome unknown: NOT confirmed (authority must reconcile)"
        : state === "FAILED"
          ? "no settlement: the payment failed or was never submitted"
          : "no settlement: denied before payment";
    claims.add("settlement", "SETTLEMENT", state === "RECONCILIATION_REQUIRED" ? "INDETERMINATE" : "NOT_CHECKED", false, detail);
    return;
  }

  if (options.mode === "offline") {
    claims.add("settlement", "SETTLEMENT", "AUTHORITY_ATTESTED", false, `authority reports transaction ${settlement.transactionId}; use --online to observe it independently`);
    return;
  }

  // Online: query only the verifier-configured RPC; never a URL from the bundle.
  let status: ClaimStatus;
  let detail: string;

  try {
    const version = await options.rpc.getVersion();

    if (profile?.environment === "sandbox" && typeof version["surfnet-version"] !== "string") {
      status = "INDETERMINATE";
      detail = "configured RPC does not identify as the Solana Payment Sandbox; cannot observe this profile's settlement";
    } else {
      const tx = await options.rpc.getTransaction(settlement.transactionId);

      if (tx === null) {
        status = "INDETERMINATE";
        detail = `transaction ${settlement.transactionId} is not visible on the configured RPC`;
      } else {
        const check = await checkSettledTransaction(tx, attempt);

        if (check.status === "settled" && check.transactionId === settlement.transactionId) {
          status = "VERIFIED";
          detail = `observed on the configured RPC: succeeded, payer-signed TransferChecked ${attempt.amountAtomic} of ${attempt.asset} to payTo ${attempt.payTo}${check.slot === null ? "" : ` (slot ${check.slot})`}`;
        } else {
          status = "INVALID";
          detail =
            check.status === "not_this_payment"
              ? "transaction does not carry the recorded payer signature"
              : check.status === "failed_onchain"
                ? `transaction failed on-chain: ${check.error}`
                : check.status === "facts_mismatch"
                  ? check.detail
                  : "transaction id differs from the settlement evidence";
        }
      }
    }
  } catch (error) {
    status = "INDETERMINATE";
    detail = `settlement RPC unavailable: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  claims.add("settlement", "SETTLEMENT", status, true, detail);
}
