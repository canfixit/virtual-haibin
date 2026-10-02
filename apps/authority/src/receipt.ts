import { getAddressFromPublicKey } from "@solana/addresses";
import { getBase58Decoder } from "@solana/codecs-strings";
import { signBytes } from "@solana/keys";
import canonicalize from "canonicalize";
import type { ExactOperationV1 } from "@virtual-haibin/mandate";

/**
 * Domain-separated, signed record of one authority decision. This is
 * intentionally small: it proves "the authority, not the agent, decided
 * this" using key material the agent never sees. It is not the Phase 6
 * evidence bundle (which will additionally link Solana settlement, service
 * fulfillment, and a result hash) -- that comes later, once there is a real
 * transaction and service result to link.
 */
export const AUTHORIZATION_RECEIPT_DOMAIN = "virtual-haibin/authorization-receipt";
export const AUTHORIZATION_RECEIPT_VERSION = 1;
/**
 * v2 (Phase 4.5) adds the exact operation the decision was about. Issued
 * for every AuthorizationRequest v2; v1 receipts remain only for
 * invocations recorded before operation binding existed.
 */
export const AUTHORIZATION_RECEIPT_VERSION_2 = 2;

export type UnsignedAuthorizationReceiptV1 = {
  version: typeof AUTHORIZATION_RECEIPT_VERSION;
  domain: typeof AUTHORIZATION_RECEIPT_DOMAIN;
  invocationId: string;
  grantId: string;
  authority: string;
  /** The permit's authorizedAgent, whose request signature the authority verified. */
  agent: string;
  /** SHA-256 of the exact signed permit the request was bound to. */
  permitDigest: string;
  /** Deterministic fingerprint of the authorized request (see authorize.ts). */
  requestFingerprint: string;
  service: string;
  capability: string;
  network: string;
  mint: string;
  recipient: string;
  /** Integer atomic units, canonical decimal string. */
  amountAtomic: string;
  decision: "ALLOW" | "DENY";
  reasonCodes: string[];
  paymentTransactionId: string | null;
  decidedAt: number;
};

export type UnsignedAuthorizationReceiptV2 = Omit<UnsignedAuthorizationReceiptV1, "version"> & {
  version: typeof AUTHORIZATION_RECEIPT_VERSION_2;
  /** The operation the agent requested (and, on ALLOW, the human approved and the authority sent). */
  operation: ExactOperationV1;
  /** computeOperationDigest(operation). */
  operationDigest: string;
};

export type AuthorizationReceiptSignature = {
  algorithm: "ed25519";
  signature: string;
};

export type SignedAuthorizationReceiptV1 = UnsignedAuthorizationReceiptV1 & {
  signature: AuthorizationReceiptSignature;
};

export type SignedAuthorizationReceiptV2 = UnsignedAuthorizationReceiptV2 & {
  signature: AuthorizationReceiptSignature;
};

export type UnsignedAuthorizationReceipt = UnsignedAuthorizationReceiptV1 | UnsignedAuthorizationReceiptV2;
export type SignedAuthorizationReceipt = SignedAuthorizationReceiptV1 | SignedAuthorizationReceiptV2;

function canonicalizeReceipt(receipt: UnsignedAuthorizationReceipt): Uint8Array {
  const canonicalJson = canonicalize(receipt);

  if (canonicalJson === undefined) {
    throw new Error("Authorization receipt contains a value that cannot be canonicalized.");
  }

  const domainPrefix = `${AUTHORIZATION_RECEIPT_DOMAIN}:v${receipt.version}\n`;
  return new TextEncoder().encode(domainPrefix + canonicalJson);
}

export async function signAuthorizationReceipt<R extends UnsignedAuthorizationReceipt>(
  unsigned: R,
  authoritySigner: CryptoKeyPair,
): Promise<R & { signature: AuthorizationReceiptSignature }> {
  const signerAddress = await getAddressFromPublicKey(authoritySigner.publicKey);

  if (signerAddress !== unsigned.authority) {
    throw new Error("Authority signer keypair does not match the receipt's authority field.");
  }

  const bytes = canonicalizeReceipt(unsigned);
  const rawSignature = await signBytes(authoritySigner.privateKey, bytes);

  return {
    ...unsigned,
    signature: { algorithm: "ed25519", signature: getBase58Decoder().decode(rawSignature) },
  };
}
