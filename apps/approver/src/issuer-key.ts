import { randomBytes } from "node:crypto";
import { loadOrCreateSigningKey, readOrCreatePrivateFile } from "@virtual-haibin/identity";

export type IssuerKey = {
  /** Non-extractable WebCrypto Ed25519 key pair; the private key never exists as JS bytes after loading. */
  keyPair: CryptoKeyPair;
  /** Base58 public key (the permit `issuer`). */
  address: string;
};

const APPROVAL_CODE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Loads the human issuer's Ed25519 key from `path` (raw 32-byte seed, mode
 * 0600, approver-only volume), creating it on first use. See
 * @virtual-haibin/identity loadOrCreateSigningKey for custody rules.
 *
 * Hackathon-grade custody, not production: a real issuer key belongs in a
 * wallet, HSM or OS keystore under the human's control.
 */
export async function loadOrCreateIssuerKey(path: string): Promise<IssuerKey & { created: boolean }> {
  return loadOrCreateSigningKey(path);
}

/**
 * Loads the human's approval code (32 lowercase hex chars, 128 bits),
 * creating it on first use. Every approval must present it, so a process
 * that can merely *reach* the approver over the network -- such as the
 * agent container on Docker Desktop via host.docker.internal -- still cannot
 * obtain a permit. It is never logged or returned; the human reads it from
 * the approver's private volume:
 *
 *   docker compose exec approver cat /keys/approval-code
 */
export function loadOrCreateApprovalCode(path: string): { code: string; created: boolean } {
  const { contents, created } = readOrCreatePrivateFile(path, () => Buffer.from(randomBytes(16).toString("hex"), "utf8"));
  const code = contents.toString("utf8").trim();

  if (!APPROVAL_CODE_PATTERN.test(code)) {
    throw new Error(`Approval code file ${path} must contain 32 lowercase hex characters.`);
  }

  return { code, created };
}
