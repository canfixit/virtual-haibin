import { getAddressFromPublicKey, type Address } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { PURCHASE_PERMIT_DOMAIN, PURCHASE_PERMIT_VERSION, PURCHASE_PERMIT_VERSION_2 } from "./domain.js";
import type { ExactOperationV1 } from "./operation.js";
import type { UnsignedPurchasePermitV1, UnsignedPurchasePermitV2 } from "./types.js";

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

export const REPORT_RESOURCE = "/api/v1/report";

export function buildOperation(overrides: Partial<ExactOperationV1> = {}): ExactOperationV1 {
  return { method: "POST", resource: REPORT_RESOURCE, operation: "summarize", datasetId: "dataset-a", ...overrides };
}

export function buildUnsignedPermitV2(overrides: Partial<UnsignedPurchasePermitV2> = {}): UnsignedPurchasePermitV2 {
  const { version: _v1, ...shared } = buildUnsignedPermit();
  return { ...shared, version: PURCHASE_PERMIT_VERSION_2, operation: buildOperation(), ...overrides };
}
