import type { AgentRequestSignature, AuthorizationRequestV2, SignedPurchasePermitV2 } from "@virtual-haibin/mandate";
import type { ConfirmedSettlement, PaymentAttempt, PaymentRequirement } from "@virtual-haibin/payments";
import type { SignedAuthorizationReceiptV2 } from "./receipt.js";
import type { SignedServiceAcknowledgementV1, SignedServiceAuthorizationV1 } from "./service.js";

/**
 * EvidenceBundleV1: the portable record of ONE Virtual Haibin purchase
 * invocation, specific to this MVP (not a general receipt standard).
 *
 * Every artifact is a public protocol object (signed permit, signed agent
 * request, signed authority receipt, x402 requirement, payment attempt,
 * settlement report, result bytes) -- never a database row -- and the
 * authority-signed manifest binds all of them by digest. A verifier
 * re-derives every relationship itself; the manifest signature alone proves
 * only that the pinned authority vouched for this exact set of artifacts.
 */
export const EVIDENCE_BUNDLE_DOMAIN = "virtual-haibin/evidence-bundle";
export const EVIDENCE_BUNDLE_VERSION = 1;
/** v2 (Phase 5C) adds the authority->service authorization and the service's signed acknowledgement. */
export const EVIDENCE_BUNDLE_VERSION_2 = 2;
export const EVIDENCE_MANIFEST_DOMAIN = "virtual-haibin/evidence-manifest";
export const EVIDENCE_MANIFEST_VERSION = 1;
export const EVIDENCE_MANIFEST_VERSION_2 = 2;

export const PURCHASE_STATES = ["CONFIRMED", "DENIED", "FAILED", "RECONCILIATION_REQUIRED"] as const;
export type PurchaseState = (typeof PURCHASE_STATES)[number];

/** The agent's signed request exactly as the authority verified it. */
export type EvidenceAuthorizationRequest = {
  request: AuthorizationRequestV2;
  agentSignature: AgentRequestSignature;
};

/** The exact HTTP request the authority sent (unpaid probe and paid retry). */
export type EvidenceOutboundRequest = {
  method: "POST";
  url: string;
  contentType: "application/json";
  body: string;
  /** computePaidRequestDigest of the four fields above. */
  sha256: string;
};

/** The paid service's response as the authority observed it (not signed by the service). */
export type EvidenceResult = {
  httpStatus: number;
  contentType: "application/json";
  /** Exact response body bytes. */
  bodyBase64: string;
  bytes: number;
  /** SHA-256 (hex) of the decoded body bytes. */
  sha256: string;
};

export type EvidenceDigests = {
  purchasePermit: string;
  authorizationRequest: string;
  operation: string;
  authorityDecision: string | null;
  outboundRequest: string | null;
  paymentRequirement: string | null;
  paymentAttempt: string | null;
  settlement: string | null;
  result: string | null;
};

export type EvidenceDigestsV2 = EvidenceDigests & {
  serviceAuthorization: string | null;
  serviceAcknowledgement: string | null;
};

export type UnsignedEvidenceManifestV1 = {
  version: typeof EVIDENCE_MANIFEST_VERSION;
  domain: typeof EVIDENCE_MANIFEST_DOMAIN;
  /** Base58 Ed25519 public key of the signing authority (its key id). */
  authority: string;
  issuedAt: number;
  settlementProfile: string;
  grantId: string;
  invocationId: string;
  purchaseState: PurchaseState;
  /** ALLOW for CONFIRMED / FAILED / RECONCILIATION_REQUIRED (payment was authorized), DENY for DENIED. */
  decision: "ALLOW" | "DENY";
  reasonCodes: string[];
  digests: EvidenceDigests;
};

export type EvidenceSignature = { algorithm: "ed25519"; signature: string };

export type SignedEvidenceManifestV1 = UnsignedEvidenceManifestV1 & { signature: EvidenceSignature };

export type UnsignedEvidenceManifestV2 = Omit<UnsignedEvidenceManifestV1, "version" | "digests"> & {
  version: typeof EVIDENCE_MANIFEST_VERSION_2;
  digests: EvidenceDigestsV2;
};
export type SignedEvidenceManifestV2 = UnsignedEvidenceManifestV2 & { signature: EvidenceSignature };
export type UnsignedEvidenceManifest = UnsignedEvidenceManifestV1 | UnsignedEvidenceManifestV2;
export type SignedEvidenceManifest = SignedEvidenceManifestV1 | SignedEvidenceManifestV2;

export type EvidenceBundleV1 = {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  domain: typeof EVIDENCE_BUNDLE_DOMAIN;
  environment: { settlementProfile: string };
  identifiers: { grantId: string; invocationId: string };
  purchasePermit: SignedPurchasePermitV2;
  authorizationRequest: EvidenceAuthorizationRequest;
  /** Signed authority decision receipt (DENIED and CONFIRMED only). */
  authorityDecision: SignedAuthorizationReceiptV2 | null;
  outboundRequest: EvidenceOutboundRequest | null;
  paymentRequirement: PaymentRequirement | null;
  paymentAttempt: PaymentAttempt | null;
  /** The authority's settlement report (CONFIRMED only); independently checkable online. */
  settlement: ConfirmedSettlement | null;
  result: EvidenceResult | null;
  manifest: SignedEvidenceManifestV1;
};

/** EvidenceBundleV2 (Phase 5C): v1 artifacts plus the service-side authorization exchange. */
export type EvidenceBundleV2 = Omit<EvidenceBundleV1, "version" | "manifest"> & {
  version: typeof EVIDENCE_BUNDLE_VERSION_2;
  /** Authority-signed authorization sent with the paid retry (null when no payment was attempted). */
  serviceAuthorization: SignedServiceAuthorizationV1 | null;
  /** Service-signed acknowledgement of fulfillment (CONFIRMED only, when the service provided a valid one). */
  serviceAcknowledgement: SignedServiceAcknowledgementV1 | null;
  manifest: SignedEvidenceManifestV2;
};

export type EvidenceBundle = EvidenceBundleV1 | EvidenceBundleV2;
/** A bundle's artifacts without its manifest (distributive over versions). */
export type EvidenceArtifacts = Omit<EvidenceBundleV1, "manifest"> | Omit<EvidenceBundleV2, "manifest">;

// ---------------------------------------------------------------------------
// Verification result model
// ---------------------------------------------------------------------------

/**
 * VERIFIED                  checked by the verifier from the bundle (+ pinned trust, + RPC online)
 * INVALID                   checked and wrong: the evidence is not acceptable
 * NOT_SATISFIED             a policy condition does not hold, consistently with an authority DENY
 * AUTHORITY_ATTESTED        only the pinned authority's signed statement supports it
 * SERVICE_ATTESTED          only the paid service's statement supports it
 * NOT_CHECKED               not applicable to this bundle/mode, or input absent
 * NOT_PROVABLE_FROM_BUNDLE  cannot be established from one bundle, by design
 * INDETERMINATE             could not be decided (e.g. RPC unreachable, outcome not final)
 */
export type ClaimStatus =
  | "VERIFIED"
  | "INVALID"
  | "NOT_SATISFIED"
  | "AUTHORITY_ATTESTED"
  | "SERVICE_ATTESTED"
  | "NOT_CHECKED"
  | "NOT_PROVABLE_FROM_BUNDLE"
  | "INDETERMINATE";

export type ClaimCategory = "FORMAT" | "TRUST" | "INTEGRITY" | "AUTHORIZATION" | "STATIC_POLICY" | "PAYMENT" | "RESULT" | "SETTLEMENT" | "BUDGET" | "SERVICE";

export type Claim = {
  id: string;
  category: ClaimCategory;
  status: ClaimStatus;
  /** Whether this claim must be VERIFIED for overall VALID (depends on decision, state and mode). */
  required: boolean;
  detail?: string;
};

export type VerificationReport = {
  /**
   * VALID: every REQUIRED claim is VERIFIED and no claim is INVALID. It does
   * not mean every business/security property is proven -- see `notProven`
   * and the non-VERIFIED claims.
   */
  overall: "VALID" | "INVALID" | "INDETERMINATE";
  mode: "offline" | "online";
  decision: "ALLOW" | "DENY" | null;
  purchaseState: PurchaseState | null;
  invocationId: string | null;
  claims: Claim[];
  /** Properties this bundle cannot establish, in any mode. */
  notProven: string[];
};
