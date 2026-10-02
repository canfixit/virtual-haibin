import { operationRequestBody, type AuthorizationRequestV2, type ExactOperationV1 } from "@virtual-haibin/mandate";
import {
  createPaidRequest,
  type ChallengeResult,
  type PaidRequest,
  type PaidResource,
  type PaymentRequirement,
  type SettlementProfile,
} from "@virtual-haibin/payments";

/**
 * Trusted registry of paid resources, keyed by (serviceId, capability).
 * The authority only ever fetches URLs from here -- never a URL supplied by
 * the agent, the service or a challenge (SSRF / destination substitution).
 */
export type PaidServiceRegistry = ReadonlyMap<string, PaidResource>;

export function paidServiceKey(serviceId: string, capability: string): string {
  return `${serviceId}\u0000${capability}`;
}

export function createPaidServiceRegistry(resources: readonly PaidResource[]): PaidServiceRegistry {
  const registry = new Map<string, PaidResource>();

  for (const resource of resources) {
    const url = new URL(resource.url);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Paid resource ${resource.url} must be http(s).`);
    }

    if (url.username || url.password) {
      throw new Error(`Paid resource ${resource.url} must not embed credentials.`);
    }

    if (url.search || url.hash) {
      throw new Error(`Paid resource ${resource.url} must not carry a query or fragment; the operation travels in the body.`);
    }

    registry.set(paidServiceKey(resource.serviceId, resource.capability), Object.freeze({ ...resource, url: url.toString() }));
  }

  return registry;
}

/**
 * Builds the exact outbound HTTP request for a verified operation: the
 * trusted registry URL, the operation's method, and a body derived only
 * from the operation's fields (see operationRequestBody). Returns null if
 * the configured resource does not serve this method/path -- the authority
 * never invents a URL from the operation.
 *
 * Pure and deterministic: called once to build the request, and again from
 * the durably stored, authenticated request right before payment to prove
 * the request about to be paid for is still that operation.
 */
export function buildPaidRequest(resource: PaidResource, operation: ExactOperationV1): PaidRequest | null {
  if (resource.method !== operation.method || new URL(resource.url).pathname !== operation.resource) {
    return null;
  }

  return createPaidRequest({ url: resource.url, method: operation.method, body: operationRequestBody(operation) });
}

export type ChallengeReasonCode =
  | "CHALLENGE_NOT_PAYMENT_REQUIRED"
  | "CHALLENGE_REDIRECT"
  | "CHALLENGE_MALFORMED"
  | "UNSUPPORTED_PAYMENT_PROTOCOL"
  | "UNSUPPORTED_PAYMENT_SCHEME"
  | "CHALLENGE_NETWORK_MISMATCH"
  | "ASSET_NOT_ALLOWED"
  | "CHALLENGE_RESOURCE_MISMATCH"
  | "CHALLENGE_FEE_PAYER_INVALID"
  | "CHALLENGE_REQUEST_MISMATCH";

export type ChallengeSelection = {
  /** The single requirement the authority may pay, or null if none is acceptable. */
  requirement: PaymentRequirement | null;
  /** Non-empty means DENY. Permit-level checks (mint/recipient/amount/budget) run separately. */
  reasonCodes: ChallengeReasonCode[];
};

/**
 * Validates an untrusted 402 challenge against the trusted settlement
 * profile, the configured resource and the agent's signed request.
 *
 * Note: for the Solana Payment Sandbox, `network` matching only confirms the
 * challenge uses the identifier the sandbox advertises (which equals
 * mainnet's). Settlement-environment safety comes from the profile's pinned
 * RPC and authority-fetched blockhash, not from this string.
 */
export function selectAndValidateChallenge(
  challenge: ChallengeResult,
  context: {
    profile: SettlementProfile;
    /** The exact request the challenge was fetched with. */
    paidRequest: PaidRequest;
    request: AuthorizationRequestV2;
    payerAddress: string;
  },
): ChallengeSelection {
  if (challenge.kind === "rejected") {
    return { requirement: null, reasonCodes: [challenge.reasonCode] };
  }

  const { profile, paidRequest, request, payerAddress } = context;
  const sameScheme = challenge.requirements.filter((candidate) => candidate.scheme === profile.scheme);
  const candidates = sameScheme.filter((candidate) => profile.acceptedChallengeNetworks.includes(candidate.network));
  const requirement = candidates[0];

  if (!requirement) {
    return {
      requirement: null,
      reasonCodes: [sameScheme.length > 0 ? "CHALLENGE_NETWORK_MISMATCH" : "UNSUPPORTED_PAYMENT_SCHEME"],
    };
  }

  const reasonCodes: ChallengeReasonCode[] = [];

  if (requirement.protocol !== profile.protocol || requirement.x402Version !== profile.x402Version) {
    reasonCodes.push("UNSUPPORTED_PAYMENT_PROTOCOL");
  }

  if (!profile.allowedAssets.some((asset) => asset.mint === requirement.asset)) {
    reasonCodes.push("ASSET_NOT_ALLOWED");
  }

  if (requirement.resourceUrl !== paidRequest.url || challenge.requestSha256 !== paidRequest.sha256) {
    reasonCodes.push("CHALLENGE_RESOURCE_MISMATCH");
  }

  // The facilitator must pay fees; our payment wallet must never be the fee payer.
  if (requirement.feePayer === null || requirement.feePayer === payerAddress) {
    reasonCodes.push("CHALLENGE_FEE_PAYER_INVALID");
  }

  // The service must ask for exactly what the agent signed.
  if (
    requirement.asset !== request.mint ||
    requirement.payTo !== request.recipient ||
    requirement.amountAtomic !== request.amountAtomic
  ) {
    reasonCodes.push("CHALLENGE_REQUEST_MISMATCH");
  }

  return { requirement, reasonCodes };
}
