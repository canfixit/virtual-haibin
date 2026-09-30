import { getAddressFromPublicKey } from "@solana/addresses";
import { getBase58Decoder } from "@solana/codecs-strings";
import { signBytes } from "@solana/keys";
import canonicalize from "canonicalize";

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

export type AuthorizationReceiptSignature = {
  algorithm: "ed25519";
  signature: string;
};

export type SignedAuthorizationReceiptV1 = UnsignedAuthorizationReceiptV1 & {
  signature: AuthorizationReceiptSignature;
};

function canonicalizeReceipt(receipt: UnsignedAuthorizationReceiptV1): Uint8Array {
  const canonicalJson = canonicalize(receipt);

  if (canonicalJson === undefined) {
    throw new Error("Authorization receipt contains a value that cannot be canonicalized.");
  }

  const domainPrefix = `${AUTHORIZATION_RECEIPT_DOMAIN}:v${receipt.version}\n`;
  return new TextEncoder().encode(domainPrefix + canonicalJson);
}

export async function signAuthorizationReceipt(
  unsigned: UnsignedAuthorizationReceiptV1,
  authoritySigner: CryptoKeyPair,
): Promise<SignedAuthorizationReceiptV1> {
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
