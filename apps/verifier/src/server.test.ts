import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createVerifierServer } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "vh-verifier-api-"));
const KEY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const issuerFile = join(dir, "issuer.pub");
const authorityFile = join(dir, "authority.pub");
const ORIGIN = "http://localhost:5173";
let base: string;
let close: () => Promise<void>;

before(async () => {
  writeFileSync(issuerFile, `${KEY}\n`);
  const server = createVerifierServer({
    issuerTrustFile: issuerFile,
    authorityTrustFile: authorityFile, // created later: trust is re-read per request
    allowedOrigin: ORIGIN,
    rpcFactory: () => assert.fail("offline verification must not build an RPC client"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

after(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const verify = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/verify?mode=offline`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

test("without pinned trust roots it refuses to verify (503)", async () => {
  assert.equal((await verify("{}")).status, 503);
});

test("hostile bundles come back as INVALID reports, oversized ones as 413; CORS only for the UI origin", async () => {
  writeFileSync(authorityFile, `${KEY}\n`);

  const response = await verify("not json", { origin: ORIGIN });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  const { report } = (await response.json()) as { report: { overall: string; mode: string } };
  assert.equal(report.overall, "INVALID");
  assert.equal(report.mode, "offline");

  assert.equal((await verify("x".repeat(600 * 1024))).status, 413);
  assert.equal((await verify("{}", { origin: "http://evil.example" })).headers.get("access-control-allow-origin"), null);
});

test("health exposes only public trust keys", async () => {
  const body = (await (await fetch(`${base}/health`)).json()) as { trust: { issuer: string } };
  assert.equal(body.trust.issuer, KEY);
  assert.doesNotMatch(JSON.stringify(body), /seed|private|secret/i);
});
