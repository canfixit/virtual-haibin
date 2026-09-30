import { address, getAddressFromPublicKey, getPublicKeyFromAddress } from "@solana/addresses";
import { getBase58Decoder, getBase58Encoder } from "@solana/codecs-strings";
import { isSignature, signBytes, signatureBytes, verifySignature } from "@solana/keys";
import { canonicalizeUnsignedPurchasePermit } from "./canonical.js";
import { validateUnsignedPurchasePermit } from "./validate.js";
import type {
  PermitSignature,
  PermitVerificationResult,
  SignedPurchasePermitV1,
  UnsignedPurchasePermitV1,
} from "./types.js";

/**
 * Dev/test-only signing helper. This takes a Solana Kit CryptoKeyPair (see
 * @solana/keys' generateKeyPair/createKeyPairFromBytes) and is meant for
 * test fixtures and offline tooling that issues permits on a human's behalf
 * -- it must never run inside the autonomous agent process, which must not
 * hold an unrestricted signing key (see CLAUDE.md security invariant #1).
 *
 * Signing runs through the platform WebCrypto Ed25519 implementation, so
 * the private key material never needs to exist as an extractable raw byte
 * array in JS memory (unlike a tweetnacl-style secretKey).
 */
export async function signPurchasePermit(
  unsigned: UnsignedPurchasePermitV1,
  signer: CryptoKeyPair,
): Promise<SignedPurchasePermitV1> {
  const validation = validateUnsignedPurchasePermit(unsigned);

  if (!validation.valid) {
    throw new Error(`Cannot sign an invalid purchase permit (${validation.reasonCode}): ${validation.message}`);
  }

  const signerAddress = await getAddressFromPublicKey(signer.publicKey);

  if (signerAddress !== validation.permit.issuer) {
    throw new Error("Signer keypair public key does not match the permit issuer field.");
  }

  const bytes = canonicalizeUnsignedPurchasePermit(validation.permit);
  const rawSignature = await signBytes(signer.privateKey, bytes);

  const signature: PermitSignature = {
    algorithm: "ed25519",
    signature: getBase58Decoder().decode(rawSignature),
  };

  return { ...validation.permit, signature };
}

/**
 * Verifies an untrusted candidate as a signed purchase permit. Fails closed:
 * any structural, schema, or cryptographic problem returns a typed failure
 * rather than throwing, so malformed input can never crash the caller.
 *
 * The signing key used for verification is always the permit's own `issuer`
 * field -- there is no separate "public key" carried in the signature
 * metadata, which removes an entire class of confusion where the signature
 * metadata's key and the permit's claimed issuer could diverge.
 */
export async function verifyPurchasePermit(candidate: unknown): Promise<PermitVerificationResult> {
  try {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { verified: false, reasonCode: "INVALID_SCHEMA", message: "Purchase permit must be a JSON object." };
    }

    const record = candidate as Record<string, unknown>;
    const validation = validateUnsignedPurchasePermit(record);

    if (!validation.valid) {
      return { verified: false, reasonCode: validation.reasonCode, message: validation.message };
    }

    const signatureCandidate = record.signature;

    if (typeof signatureCandidate !== "object" || signatureCandidate === null || Array.isArray(signatureCandidate)) {
      return { verified: false, reasonCode: "INVALID_SIGNATURE", message: "Missing or malformed signature metadata." };
    }

    const signatureRecord = signatureCandidate as Record<string, unknown>;

    if (signatureRecord.algorithm !== "ed25519") {
      return { verified: false, reasonCode: "INVALID_SIGNATURE", message: "Unsupported signature algorithm." };
    }

    if (typeof signatureRecord.signature !== "string" || !isSignature(signatureRecord.signature)) {
      return {
        verified: false,
        reasonCode: "INVALID_SIGNATURE",
        message: "signature value must be a valid base58-encoded 64-byte Ed25519 signature.",
      };
    }

    let issuerPublicKey: CryptoKey;

    try {
      issuerPublicKey = await getPublicKeyFromAddress(address(validation.permit.issuer));
    } catch {
      return { verified: false, reasonCode: "INVALID_ISSUER", message: "issuer is not a valid Ed25519 public key." };
    }

    const rawSignature = signatureBytes(getBase58Encoder().encode(signatureRecord.signature));
    const signedBytes = canonicalizeUnsignedPurchasePermit(validation.permit);
    const isValid = await verifySignature(issuerPublicKey, rawSignature, signedBytes);

    if (!isValid) {
      return {
        verified: false,
        reasonCode: "INVALID_SIGNATURE",
        message: "Signature does not match the permit contents and issuer key.",
      };
    }

    const permit: SignedPurchasePermitV1 = {
      ...validation.permit,
      signature: { algorithm: "ed25519", signature: signatureRecord.signature },
    };

    return { verified: true, permit };
  } catch {
    return { verified: false, reasonCode: "INVALID_SCHEMA", message: "Purchase permit could not be parsed." };
  }
}
