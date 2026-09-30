import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION,
  computePermitDigest,
  signAuthorizationRequest,
  signPurchasePermit,
  type AuthorizationRequestV1,
  type SignedPurchasePermitV1,
  type UnsignedPurchasePermitV1,
} from "@virtual-haibin/mandate";
import {
  MockPaymentProvider,
  type MockChallengeTerms,
  type PaidResource,
  type SettlementProfile,
} from "@virtual-haibin/payments";
import type { AuthorityService, AuthorizeRequestInput } from "./authorize.js";
import { createPaidServiceRegistry } from "./payment-challenge.js";

// Test-only fixtures. All keys are generated per test run; none are persisted.

export const TEST_AUDIENCE = "test-authority";

export const authoritySigner = await generateKeyPair();
export const authorityAddress = await getAddressFromPublicKey(authoritySigner.publicKey);
export const issuerKeypair = await generateKeyPair();
export const issuerAddress = await getAddressFromPublicKey(issuerKeypair.publicKey);
/** The permit's authorizedAgent identity key (non-spending). */
export const agentIdentity = await generateKeyPair();
export const agentAddress = await getAddressFromPublicKey(agentIdentity.publicKey);
/** A different agent that holds the transport bearer token but not the permit's identity key. */
export const otherAgentIdentity = await generateKeyPair();
export const mintAddress = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
export const recipientAddress = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
export const otherRecipientAddress = await getAddressFromPublicKey((await generateKeyPair()).publicKey);

/** Challenge network the test sandbox profile accepts. */
export const TEST_CHALLENGE_NETWORK = "solana:test-sandbox";

export const TEST_PROFILE: SettlementProfile = Object.freeze({
  name: "solana-payment-sandbox",
  permitNetwork: "solana-payment-sandbox",
  environment: "sandbox",
  rpcUrl: "http://127.0.0.1:9/never-called",
  acceptedChallengeNetworks: [TEST_CHALLENGE_NETWORK],
  allowedAssets: [{ mint: mintAddress, label: "test sandbox token" }],
  protocol: "x402",
  x402Version: 2,
  scheme: "exact",
  requiredBlockhashPrefix: "SURFNET",
} satisfies SettlementProfile);

export const TEST_RESOURCE: PaidResource = {
  serviceId: "mock-research-agent",
  capability: "research.summary",
  url: "http://paid.test/api/v1/research",
  method: "GET",
};

/** Paid-service registry + settlement profiles for AuthorityService options. */
export const TEST_PAYMENT_CONFIG = {
  paidServices: createPaidServiceRegistry([TEST_RESOURCE]),
  settlementProfiles: new Map([[TEST_PROFILE.permitNetwork, TEST_PROFILE]]),
};

/**
 * The honest mock merchant quotes, per invocation, exactly the amount the
 * test's signed request uses (recorded by signedInput), to the permit's
 * recipient, in the permit's mint. Tests make it misbehave with `terms`.
 */
const quotedAmounts = new Map<string, string>();

export type CountingPaymentProviderOptions = {
  /** Override challenge terms (all invocations), e.g. a wrong payTo. */
  terms?: Partial<MockChallengeTerms>;
};

/** MockPaymentProvider with honest defaults; `calls` = payment executions (signer invocations). */
export class CountingPaymentProvider extends MockPaymentProvider {
  constructor(options: CountingPaymentProviderOptions & { behavior?: MockPaymentProvider["behavior"] } = {}) {
    super({
      ...(options.behavior === undefined ? {} : { behavior: options.behavior }),
      challenge: (_resource, reference) => ({
        network: TEST_CHALLENGE_NETWORK,
        asset: mintAddress,
        payTo: recipientAddress,
        amountAtomic: quotedAmounts.get(reference) ?? "10000",
        ...options.terms,
      }),
    });
  }

  get calls() {
    return this.executions;
  }
}

/** Transmits, then the outcome is unknown (e.g. timeout after the paid retry was sent). */
export class TimingOutPaymentProvider extends CountingPaymentProvider {
  constructor(options: CountingPaymentProviderOptions = {}) {
    super({ ...options, behavior: "unknown" });
  }
}

export function buildUnsignedPermit(overrides: Partial<UnsignedPurchasePermitV1> = {}): UnsignedPurchasePermitV1 {
  const issuedAt = Date.now();

  return {
    version: 1,
    domain: "virtual-haibin/purchase-permit",
    grantId: `VH-GRANT-${Math.random().toString(36).slice(2)}`,
    issuer: issuerAddress,
    authorizedAgent: agentAddress,
    service: "mock-research-agent",
    capability: "research.summary",
    network: "solana-payment-sandbox",
    mint: mintAddress,
    recipient: recipientAddress,
    maxPerCallAtomic: "20000",
    maxTotalAtomic: "50000",
    issuedAt,
    expiresAt: issuedAt + 30 * 60 * 1000,
    subdelegation: false,
    ...overrides,
  };
}

export async function buildSignedPermit(overrides: Partial<UnsignedPurchasePermitV1> = {}): Promise<SignedPurchasePermitV1> {
  return signPurchasePermit(buildUnsignedPermit(overrides), issuerKeypair);
}

export type SignedInputOptions = {
  invocationId: string;
  amountAtomic?: string;
  /** Overrides applied *before* signing (an honest agent asking for these values). */
  fields?: Partial<AuthorizationRequestV1>;
  /** Signing identity; defaults to the permit's authorized agent. */
  agent?: CryptoKeyPair;
};

/** Builds an authorization request for `permit` and signs it like the agent does. */
export async function signedInput(permit: SignedPurchasePermitV1, options: SignedInputOptions): Promise<AuthorizeRequestInput> {
  const authorizationRequest: AuthorizationRequestV1 = {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION,
    audience: TEST_AUDIENCE,
    grantId: permit.grantId,
    permitDigest: await computePermitDigest(permit),
    invocationId: options.invocationId,
    service: permit.service,
    capability: permit.capability,
    network: permit.network,
    mint: permit.mint,
    recipient: permit.recipient,
    amountAtomic: options.amountAtomic ?? "10000",
    issuedAt: Date.now(),
    ...options.fields,
  };

  const agentSignature = await signAuthorizationRequest(authorizationRequest, options.agent ?? agentIdentity);
  quotedAmounts.set(authorizationRequest.invocationId, authorizationRequest.amountAtomic);
  return { permit, authorizationRequest, agentSignature };
}

/** Modifies signed request fields *after* signing, as an attacker in transit would. */
export function tamperRequest(input: AuthorizeRequestInput, fields: Partial<AuthorizationRequestV1>): AuthorizeRequestInput {
  return { ...input, authorizationRequest: { ...input.authorizationRequest, ...fields } };
}

/** Durable committed (reserved + consumed) total for a permit's grant, as a string. */
export async function committedAtomic(service: AuthorityService, permit: SignedPurchasePermitV1): Promise<string> {
  const budget = await service.getGrantBudget(permit.issuer, permit.grantId);
  return budget === null ? "0" : (BigInt(budget.reservedAtomic) + BigInt(budget.consumedAtomic)).toString();
}
