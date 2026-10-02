import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { issuerAddress } from "./test-support.js";
import { loadIssuerEntitlement } from "./trust.js";

const dir = mkdtempSync(join(tmpdir(), "vh-trust-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

test("a file holding one base58 public key becomes the issuer entitlement", () => {
  const entitlement = loadIssuerEntitlement(file("ok", `${issuerAddress}\n`), ["solana-payment-sandbox"]);
  assert.deepEqual(entitlement, { issuer: issuerAddress, settlementProfiles: ["solana-payment-sandbox"] });
  assert.ok(Object.isFrozen(entitlement));
});

test("a missing, empty, malformed or multi-key trust file fails startup closed", () => {
  assert.throws(() => loadIssuerEntitlement(join(dir, "missing"), ["solana-payment-sandbox"]));
  for (const [name, contents] of [
    ["empty", ""],
    ["garbage", "not-a-key"],
    ["two", `${issuerAddress}\n${issuerAddress}\n`],
    ["json", JSON.stringify({ issuer: issuerAddress })],
  ] as const) {
    assert.throws(() => loadIssuerEntitlement(file(name, contents), ["solana-payment-sandbox"]), name);
  }
});

test("an issuer with no settlement profile is refused", () => {
  assert.throws(() => loadIssuerEntitlement(file("ok2", issuerAddress), []));
});
