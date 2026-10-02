import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadOrCreateSigningKey, publishPublicKey } from "./key-file.js";

const dir = mkdtempSync(join(tmpdir(), "vh-keyfile-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a signing key is created once (0600), survives reloads as the same key, and is non-extractable", async () => {
  const path = join(dir, "signer.seed");
  const first = await loadOrCreateSigningKey(path);
  const restarted = await loadOrCreateSigningKey(path);

  assert.equal(first.created, true);
  assert.equal(restarted.created, false);
  assert.equal(restarted.address, first.address);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(first.keyPair.privateKey.extractable, false);
});

test("a different seed file is a different key", async () => {
  const a = await loadOrCreateSigningKey(join(dir, "a.seed"));
  const b = await loadOrCreateSigningKey(join(dir, "b.seed"));
  assert.notEqual(a.address, b.address);
});

test("loose permissions or a wrong-size seed are refused", async () => {
  const loose = join(dir, "loose.seed");
  writeFileSync(loose, Buffer.alloc(32, 1));
  chmodSync(loose, 0o644);
  await assert.rejects(loadOrCreateSigningKey(loose), /group\/other/);

  const short = join(dir, "short.seed");
  writeFileSync(short, Buffer.alloc(16, 1), { mode: 0o600 });
  await assert.rejects(loadOrCreateSigningKey(short), /exactly 32 bytes/);
});

test("publishPublicKey writes only the public key", async () => {
  const key = await loadOrCreateSigningKey(join(dir, "pub.seed"));
  const out = join(dir, "authority.pub");
  publishPublicKey(out, key.address);
  assert.equal(readFileSync(out, "utf8"), `${key.address}\n`);
});
