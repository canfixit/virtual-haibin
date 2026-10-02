import { address, getAddressFromPublicKey, getPublicKeyFromAddress } from "@solana/addresses";
import { getBase58Decoder, getBase58Encoder } from "@solana/codecs-strings";
import { isSignature, signatureBytes, signBytes, verifySignature } from "@solana/keys";
import canonicalize from "canonicalize";
import { computeOperationDigest, computePermitDigest } from "@virtual-haibin/mandate";
import type { EvidenceBundleV1, EvidenceDigests, SignedEvidenceManifestV1, UnsignedEvidenceManifestV1 } from "./types.js";
import { EVIDENCE_MANIFEST_DOMAIN } from "./types.js";

const ARTIFACT_DOMAIN = "virtual-haibin/evidence-artifact";

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalBytes(prefix: string, value: unknown): Uint8Array<ArrayBuffer> {
  const json = canonicalize(value);

  if (json === undefined) {
    throw new Error("Value cannot be canonicalized.");
  }

  return new TextEncoder().encode(prefix + json);
}

/** Domain-separated SHA-256 of an artifact's RFC 8785 canonical JSON, per artifact name. */
export async function artifactDigest(name: string, value: unknown): Promise<string> {
  return sha256Hex(canonicalBytes(`${ARTIFACT_DOMAIN}:${name}:v1\n`, value));
}

/**
 * Recomputes every artifact digest from the bundle's own contents. The
 * permit and operation reuse their protocol digests (the same values the
 * agent's request binds to), so the manifest and request agree on identity.
 */
export async function computeEvidenceDigests(bundle: Omit<EvidenceBundleV1, "manifest">): Promise<EvidenceDigests> {
  const optional = async (name: string, value: unknown) => (value === null ? null : artifactDigest(name, value));

  return {
    purchasePermit: await computePermitDigest(bundle.purchasePermit),
    authorizationRequest: await artifactDigest("authorization-request", bundle.authorizationRequest),
    operation: await computeOperationDigest(bundle.authorizationRequest.request.operation),
    authorityDecision: await optional("authority-decision", bundle.authorityDecision),
    outboundRequest: await optional("outbound-request", bundle.outboundRequest),
    paymentRequirement: await optional("payment-requirement", bundle.paymentRequirement),
    paymentAttempt: await optional("payment-attempt", bundle.paymentAttempt),
    settlement: await optional("settlement", bundle.settlement),
    result: await optional("result", bundle.result),
  };
}

export function canonicalizeManifest(manifest: UnsignedEvidenceManifestV1): Uint8Array {
  return canonicalBytes(`${EVIDENCE_MANIFEST_DOMAIN}:v${manifest.version}\n`, manifest);
}

/** Signs a manifest with the authority's persistent receipt key. */
export async function signEvidenceManifest(unsigned: UnsignedEvidenceManifestV1, signer: CryptoKeyPair): Promise<SignedEvidenceManifestV1> {
  if ((await getAddressFromPublicKey(signer.publicKey)) !== unsigned.authority) {
    throw new Error("Manifest signer does not match the manifest's authority field.");
  }

  const raw = await signBytes(signer.privateKey, canonicalizeManifest(unsigned));
  return { ...unsigned, signature: { algorithm: "ed25519", signature: getBase58Decoder().decode(raw) } };
}

/**
 * Verifies the manifest signature against `pinnedAuthority`. The manifest's
 * own `authority` field must equal the pinned key; it is never used as the
 * verification key by itself. Fails closed.
 */
export async function verifyEvidenceManifestSignature(manifest: SignedEvidenceManifestV1, pinnedAuthority: string): Promise<boolean> {
  try {
    if (manifest.authority !== pinnedAuthority || manifest.signature.algorithm !== "ed25519" || !isSignature(manifest.signature.signature)) {
      return false;
    }

    const { signature, ...unsigned } = manifest;
    const publicKey = await getPublicKeyFromAddress(address(pinnedAuthority));
    return await verifySignature(publicKey, signatureBytes(getBase58Encoder().encode(signature.signature)), canonicalizeManifest(unsigned));
  } catch {
    return false;
  }
}
