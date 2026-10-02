import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION_2,
  computePermitDigest,
  signAuthorizationRequest,
  signPurchasePermitV2,
  type AuthorizationRequestV2,
  type ExactOperationV1,
  type SignedPurchasePermitV2,
  type UnsignedPurchasePermitV2,
} from "@virtual-haibin/mandate";
import {
  MockPaymentProvider,
  type MockChallengeTerms,
  type PaidResource,
  type SettlementProfile,
} from "@virtual-haibin/payments";
import type { AuthorityService, AuthorizeRequestInput, IssuerEntitlement } from "./authorize.js";
import { createPaidServiceRegistry } from "./payment-challenge.js";

// Test-only fixtures. All keys are generated per test run; none are persisted.

export const TEST_AUDIENCE = "test-authority";

export const authoritySigner = await generateKeyPair();
export const authorityAddress = await getAddressFromPublicKey(authoritySigner.publicKey);
/** The trusted human issuer (stands in for apps/approver's key). */
export const issuerKeypair = await generateKeyPair();
export const issuerAddress = await getAddressFromPublicKey(issuerKeypair.publicKey);
/** A key anyone (including the agent) could generate: produces valid signatures, but is not entitled. */
export const rogueIssuerKeypair = await generateKeyPair();
export const rogueIssuerAddress = await getAddressFromPublicKey(rogueIssuerKeypair.publicKey);
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
  serviceId: "mock-dataset-reports",
  capability: "reports.generate",
  url: "http://paid.test/api/v1/report",
  method: "POST",
};

/** The operation the test human approves. */
export const APPROVED_OPERATION: ExactOperationV1 = Object.freeze({
  method: "POST",
  resource: "/api/v1/report",
  operation: "summarize",
  datasetId: "dataset-a",
});

export const TEST_ISSUER_ENTITLEMENT: IssuerEntitlement = Object.freeze({
  issuer: issuerAddress,
  settlementProfiles: [TEST_PROFILE.permitNetwork],
});

/** Paid-service registry, settlement profiles and the issuer trust root for AuthorityService options. */
export const TEST_PAYMENT_CONFIG = {
  paidServices: createPaidServiceRegistry([TEST_RESOURCE]),
  settlementProfiles: new Map([[TEST_PROFILE.permitNetwork, TEST_PROFILE]]),
  issuerEntitlement: TEST_ISSUER_ENTITLEMENT,
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

export function buildUnsignedPermit(overrides: Partial<UnsignedPurchasePermitV2> = {}): UnsignedPurchasePermitV2 {
  const issuedAt = Date.now();

  return {
    version: 2,
    domain: "virtual-haibin/purchase-permit",
    grantId: `VH-GRANT-${Math.random().toString(36).slice(2)}`,
    issuer: issuerAddress,
    authorizedAgent: agentAddress,
    service: TEST_RESOURCE.serviceId,
    capability: TEST_RESOURCE.capability,
    network: "solana-payment-sandbox",
    mint: mintAddress,
    recipient: recipientAddress,
    maxPerCallAtomic: "20000",
    maxTotalAtomic: "50000",
    issuedAt,
    expiresAt: issuedAt + 30 * 60 * 1000,
    subdelegation: false,
    operation: { ...APPROVED_OPERATION },
    ...overrides,
  };
}

/** Signs with the trusted issuer, or with `signer` (whose address becomes the issuer). */
export async function buildSignedPermit(
  overrides: Partial<UnsignedPurchasePermitV2> = {},
  signer: CryptoKeyPair = issuerKeypair,
): Promise<SignedPurchasePermitV2> {
  const issuer = await getAddressFromPublicKey(signer.publicKey);
  return signPurchasePermitV2(buildUnsignedPermit({ issuer, ...overrides }), signer);
}

export type SignedInputOptions = {
  invocationId: string;
  amountAtomic?: string;
  /** Overrides applied *before* signing (an honest agent asking for these values). */
  fields?: Partial<AuthorizationRequestV2>;
  /** Signing identity; defaults to the permit's authorized agent. */
  agent?: CryptoKeyPair;
};

/** Builds an authorization request for `permit` and signs it like the agent does. */
export async function signedInput(permit: SignedPurchasePermitV2, options: SignedInputOptions): Promise<AuthorizeRequestInput> {
  const authorizationRequest: AuthorizationRequestV2 = {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION_2,
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
    operation: { ...APPROVED_OPERATION },
    ...options.fields,
  };

  const agentSignature = await signAuthorizationRequest(authorizationRequest, options.agent ?? agentIdentity);
  quotedAmounts.set(authorizationRequest.invocationId, authorizationRequest.amountAtomic);
  return { permit, authorizationRequest, agentSignature };
}

/** Modifies signed request fields *after* signing, as an attacker in transit would. */
export function tamperRequest(input: AuthorizeRequestInput, fields: Partial<AuthorizationRequestV2>): AuthorizeRequestInput {
  return { ...input, authorizationRequest: { ...input.authorizationRequest, ...fields } };
}

/** Durable committed (reserved + consumed) total for a permit's grant, as a string. */
export async function committedAtomic(service: AuthorityService, permit: SignedPurchasePermitV2): Promise<string> {
  const budget = await service.getGrantBudget(permit.issuer, permit.grantId);
  return budget === null ? "0" : (BigInt(budget.reservedAtomic) + BigInt(budget.consumedAtomic)).toString();
}
