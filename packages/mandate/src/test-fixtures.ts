import { getAddressFromPublicKey, type Address } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { PURCHASE_PERMIT_DOMAIN, PURCHASE_PERMIT_VERSION } from "./domain.js";
import type { UnsignedPurchasePermitV1 } from "./types.js";

export const issuerKeypair = await generateKeyPair();
export const otherIssuerKeypair = await generateKeyPair();
export const agentKeypair = await generateKeyPair();
export const mintKeypair = await generateKeyPair();
export const recipientKeypair = await generateKeyPair();

export const issuerAddress: Address = await getAddressFromPublicKey(issuerKeypair.publicKey);
export const otherIssuerAddress: Address = await getAddressFromPublicKey(otherIssuerKeypair.publicKey);
export const agentAddress: Address = await getAddressFromPublicKey(agentKeypair.publicKey);
export const mintAddress: Address = await getAddressFromPublicKey(mintKeypair.publicKey);
export const recipientAddress: Address = await getAddressFromPublicKey(recipientKeypair.publicKey);

const BASE_ISSUED_AT = Date.parse("2026-09-22T00:00:00.000Z");

export function buildUnsignedPermit(overrides: Partial<UnsignedPurchasePermitV1> = {}): UnsignedPurchasePermitV1 {
  return {
    version: PURCHASE_PERMIT_VERSION,
    domain: PURCHASE_PERMIT_DOMAIN,
    grantId: "VH-GRANT-0001",
    issuer: issuerAddress,
    authorizedAgent: agentAddress,
    service: "research-agent",
    capability: "research.summary",
    network: "devnet",
    mint: mintAddress,
    recipient: recipientAddress,
    maxPerCallAtomic: "20000",
    maxTotalAtomic: "50000",
    issuedAt: BASE_ISSUED_AT,
    expiresAt: BASE_ISSUED_AT + 30 * 60 * 1000,
    subdelegation: false,
    ...overrides,
  };
}
