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
import type { PaymentProvider, PaymentReceipt, PaymentRequest } from "@virtual-haibin/payments";
import type { AuthorizeRequestInput } from "./authorize.js";

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

export class CountingPaymentProvider implements PaymentProvider {
  calls: PaymentRequest[] = [];

  async pay(request: PaymentRequest): Promise<PaymentReceipt> {
    this.calls.push(request);
    return { ...request, transactionId: `mock-${this.calls.length}`, status: "simulated", settledAt: Date.now() };
  }
}

/** Simulates a provider whose submission outcome is unknown (e.g. RPC timeout after send). */
export class TimingOutPaymentProvider implements PaymentProvider {
  calls: PaymentRequest[] = [];

  async pay(request: PaymentRequest): Promise<PaymentReceipt> {
    this.calls.push(request);
    throw new Error("simulated RPC timeout after submission");
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
    network: "devnet",
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
  return { permit, authorizationRequest, agentSignature };
}

/** Modifies signed request fields *after* signing, as an attacker in transit would. */
export function tamperRequest(input: AuthorizeRequestInput, fields: Partial<AuthorizationRequestV1>): AuthorizeRequestInput {
  return { ...input, authorizationRequest: { ...input.authorizationRequest, ...fields } };
}
