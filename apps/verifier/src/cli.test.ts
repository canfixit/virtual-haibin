import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runVerifierCli } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "vh-verifier-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Any valid base58 public key works for argument handling.
const key = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const issuerFile = join(dir, "issuer.pub");
const authorityFile = join(dir, "authority.pub");
writeFileSync(issuerFile, `${key}\n`);
writeFileSync(authorityFile, `${key}\n`);

function file(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function run(argv: string[], rpcFactory?: () => never) {
  let stdout = "";
  let stderr = "";
  const code = await runVerifierCli(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), ...(rpcFactory ? { rpcFactory } : {}) });
  return { code, stdout, stderr };
}

test("usage and trust-configuration errors exit 64 without verifying", async () => {
  const bundle = file("b.json", "{}");
  for (const argv of [
    [],
    ["check", bundle],
    ["verify", bundle],
    ["verify", bundle, "--issuer-trust", issuerFile],
    ["verify", bundle, "--issuer-trust", issuerFile, "--authority-trust", authorityFile, "--offline", "--online"],
    ["verify", bundle, "--issuer-trust", file("bad.pub", "not a key"), "--authority-trust", authorityFile],
    ["verify", join(dir, "missing.json"), "--issuer-trust", issuerFile, "--authority-trust", authorityFile],
    ["verify", bundle, "--issuer-trust", issuerFile, "--authority-trust", authorityFile, "--service-trust", file("bad-service.pub", "nope")],
    ["verify", bundle, "--issuer-trust", issuerFile, "--authority-trust", authorityFile, "--service-trust"],
  ]) {
    const { code, stderr } = await run(argv);
    assert.equal(code, 64, JSON.stringify(argv));
    assert.match(stderr, /Usage:/);
  }
});

test("a malformed or oversized bundle is INVALID (exit 1), and offline mode never builds an RPC client", async () => {
  const noRpc = () => assert.fail("offline mode must not create an RPC client") as never;
  for (const contents of ["not json", JSON.stringify({ version: 1, domain: "x" }), "x".repeat(600 * 1024)]) {
    const { code, stdout } = await run(["verify", file("bad.json", contents), "--issuer-trust", issuerFile, "--authority-trust", authorityFile, "--json"], noRpc);
    assert.equal(code, 1);
    const report = JSON.parse(stdout) as { overall: string; mode: string; claims: Array<{ id: string; status: string }> };
    assert.equal(report.overall, "INVALID");
    assert.equal(report.mode, "offline");
    assert.equal(report.claims[0]?.id, "bundle_format");
  }
});
