import {
  computeEvidenceDigests,
  EVIDENCE_BUNDLE_DOMAIN,
  EVIDENCE_BUNDLE_VERSION,
  EVIDENCE_MANIFEST_DOMAIN,
  EVIDENCE_MANIFEST_VERSION,
  signEvidenceManifest,
  type EvidenceBundleV1,
  type EvidenceOutboundRequest,
  type EvidenceResult,
  type PurchaseState,
} from "@virtual-haibin/evidence";
import { buildPaidRequest, paidServiceKey, type PaidServiceRegistry } from "./payment-challenge.js";
import type { InvocationRecord } from "./store/types.js";

/** Why an invocation cannot be exported (stable reason codes). */
export type EvidenceExportProblem =
  | "EVIDENCE_NOT_FINAL"
  | "EVIDENCE_UNAVAILABLE";

export class EvidenceExportError extends Error {
  constructor(
    readonly reasonCode: EvidenceExportProblem,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Builds the portable EvidenceBundleV1 for one invocation from the
 * authority's durable record, and signs its manifest with the persistent
 * authority receipt key. Only public protocol objects go into the bundle:
 * no database rows, no keys, no secrets.
 *
 * Refuses invocations still in flight (RESERVED) and invocations recorded
 * before evidence capture existed (no stored signed permit / agent
 * signature, no v2 receipt by this authority key, no raw result bytes).
 */
export async function buildEvidenceBundle(input: {
  invocation: InvocationRecord;
  paidServices: PaidServiceRegistry;
  authorityAddress: string;
  signer: CryptoKeyPair;
  issuedAt: number;
}): Promise<EvidenceBundleV1> {
  const { invocation, authorityAddress } = input;
  const state = invocation.state;

  if (state === "RESERVED") {
    throw new EvidenceExportError("EVIDENCE_NOT_FINAL", "Invocation is still being processed; export it once it is decided.");
  }

  const { request, authorization } = invocation;

  if (authorization === null || request.version !== 2) {
    throw new EvidenceExportError("EVIDENCE_UNAVAILABLE", "Invocation was recorded before evidence capture and cannot be exported.");
  }

  const receipt = invocation.receipt;

  if ((state === "CONFIRMED" || state === "DENIED") && (receipt === null || receipt.version !== 2 || receipt.authority !== authorityAddress)) {
    throw new EvidenceExportError("EVIDENCE_UNAVAILABLE", "Invocation's decision receipt was not signed by this authority's persistent key.");
  }

  let result: EvidenceResult | null = null;

  if (state === "CONFIRMED") {
    if (invocation.result?.bodyBase64 === undefined || invocation.settlement === null) {
      throw new EvidenceExportError("EVIDENCE_UNAVAILABLE", "Invocation has no recorded result bytes or settlement.");
    }

    result = {
      httpStatus: invocation.result.httpStatus,
      contentType: "application/json",
      bodyBase64: invocation.result.bodyBase64,
      bytes: invocation.result.bytes,
      sha256: invocation.result.sha256,
    };
  }

  // The outbound request is re-derived exactly as the authority built it:
  // trusted registry URL + the authenticated operation.
  let outboundRequest: EvidenceOutboundRequest | null = null;

  if (invocation.paymentRequirement !== null) {
    const resource = input.paidServices.get(paidServiceKey(request.service, request.capability));
    const paid = resource === undefined ? null : buildPaidRequest(resource, request.operation);
    outboundRequest = paid === null ? null : { method: paid.method, url: paid.url, contentType: paid.contentType, body: paid.body, sha256: paid.sha256 };
  }

  const purchaseState: PurchaseState = state;
  const artifacts = {
    version: EVIDENCE_BUNDLE_VERSION,
    domain: EVIDENCE_BUNDLE_DOMAIN,
    environment: { settlementProfile: authorization.permit.network },
    identifiers: { grantId: invocation.grantId, invocationId: invocation.invocationId },
    purchasePermit: authorization.permit,
    authorizationRequest: { request, agentSignature: authorization.agentSignature },
    authorityDecision: receipt !== null && receipt.version === 2 ? receipt : null,
    outboundRequest,
    paymentRequirement: invocation.paymentRequirement,
    paymentAttempt: invocation.paymentAttempt,
    settlement: state === "CONFIRMED" ? invocation.settlement : null,
    result,
  } satisfies Omit<EvidenceBundleV1, "manifest">;

  const manifest = await signEvidenceManifest(
    {
      version: EVIDENCE_MANIFEST_VERSION,
      domain: EVIDENCE_MANIFEST_DOMAIN,
      authority: authorityAddress,
      issuedAt: input.issuedAt,
      settlementProfile: authorization.permit.network,
      grantId: invocation.grantId,
      invocationId: invocation.invocationId,
      purchaseState,
      decision: state === "DENIED" ? "DENY" : "ALLOW",
      reasonCodes: invocation.reasonCodes,
      digests: await computeEvidenceDigests(artifacts),
    },
    input.signer,
  );

  return { ...artifacts, manifest };
}
