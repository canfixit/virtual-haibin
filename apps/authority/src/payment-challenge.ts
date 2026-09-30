import type { AuthorizationRequestV1 } from "@virtual-haibin/mandate";
import type { ChallengeResult, PaidResource, PaymentRequirement, SettlementProfile } from "@virtual-haibin/payments";

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

    registry.set(paidServiceKey(resource.serviceId, resource.capability), Object.freeze({ ...resource, url: url.toString() }));
  }

  return registry;
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
    resource: PaidResource;
    request: AuthorizationRequestV1;
    payerAddress: string;
  },
): ChallengeSelection {
  if (challenge.kind === "rejected") {
    return { requirement: null, reasonCodes: [challenge.reasonCode] };
  }

  const { profile, resource, request, payerAddress } = context;
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

  if (requirement.resourceUrl !== resource.url) {
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
