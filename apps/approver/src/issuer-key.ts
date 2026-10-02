import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { getAddressFromPublicKey } from "@solana/addresses";
import { createKeyPairFromPrivateKeyBytes } from "@solana/keys";

export type IssuerKey = {
  /** Non-extractable WebCrypto Ed25519 key pair; the private key never exists as JS bytes after loading. */
  keyPair: CryptoKeyPair;
  /** Base58 public key (the permit `issuer`). */
  address: string;
};

const SEED_BYTES = 32;
const APPROVAL_CODE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Reads a private file, creating it with `create()` on first use. Created
 * exclusively ("wx": never overwrites) with mode 0600, and refused if
 * group/other can read it. Such files must live only in the approver's
 * private volume (never the source tree, never a volume another service
 * mounts).
 */
function readOrCreatePrivateFile(path: string, create: () => Buffer): { contents: Buffer; created: boolean } {
  try {
    const stats = statSync(path);

    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`${path} is readable by group/other; refusing to use it (expected mode 0600).`);
    }

    return { contents: readFileSync(path), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const contents = create();
  const fd = openSync(path, "wx", 0o600);

  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }

  chmodSync(path, 0o600);
  return { contents, created: true };
}

/**
 * Loads the human issuer's Ed25519 key from `path` (raw 32-byte seed),
 * creating it on first use. After loading, the seed buffer is zeroed and only
 * a non-extractable CryptoKey remains.
 *
 * Hackathon-grade custody, not production: a real issuer key belongs in a
 * wallet, HSM or OS keystore under the human's control.
 */
export async function loadOrCreateIssuerKey(path: string): Promise<IssuerKey & { created: boolean }> {
  const { contents: seed, created } = readOrCreatePrivateFile(path, () => randomBytes(SEED_BYTES));

  if (seed.byteLength !== SEED_BYTES) {
    seed.fill(0);
    throw new Error(`Issuer key file ${path} must contain exactly ${SEED_BYTES} bytes.`);
  }

  try {
    const keyPair = await createKeyPairFromPrivateKeyBytes(seed, false);
    return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey), created };
  } finally {
    seed.fill(0);
  }
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
