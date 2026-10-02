import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { getAddressFromPublicKey } from "@solana/addresses";
import { createKeyPairFromPrivateKeyBytes } from "@solana/keys";

/**
 * Reads a private file, creating it with `create()` on first use. Created
 * exclusively ("wx": never overwrites an existing key) with mode 0600, and
 * refused if group/other can read it. Such files must live only in the
 * owning service's private Docker volume -- never the source tree, never a
 * volume another service mounts.
 */
export function readOrCreatePrivateFile(path: string, create: () => Buffer): { contents: Buffer; created: boolean } {
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

export type PersistentSigningKey = {
  /** Non-extractable WebCrypto Ed25519 key pair; the seed never stays in JS memory after loading. */
  keyPair: CryptoKeyPair;
  /** Base58 public key (Solana address form). */
  address: string;
  created: boolean;
};

const SEED_BYTES = 32;

/**
 * Loads a persistent Ed25519 signing key from a raw 32-byte seed file,
 * creating it on first use (see readOrCreatePrivateFile for custody rules).
 * The seed buffer is zeroed after import; only a non-extractable CryptoKey
 * remains. Hackathon-grade custody: production keys belong in an HSM/KMS.
 */
export async function loadOrCreateSigningKey(path: string): Promise<PersistentSigningKey> {
  const { contents: seed, created } = readOrCreatePrivateFile(path, () => randomBytes(SEED_BYTES));

  if (seed.byteLength !== SEED_BYTES) {
    seed.fill(0);
    throw new Error(`Key file ${path} must contain exactly ${SEED_BYTES} bytes.`);
  }

  try {
    const keyPair = await createKeyPairFromPrivateKeyBytes(seed, false);
    return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey), created };
  } finally {
    seed.fill(0);
  }
}

/**
 * Publishes a PUBLIC key (base58, one line) for other parties to pin, via
 * write + atomic rename so a reader never sees a half-written trust root.
 */
export function publishPublicKey(path: string, publicKey: string): void {
  writeFileSync(`${path}.tmp`, `${publicKey}\n`, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}
