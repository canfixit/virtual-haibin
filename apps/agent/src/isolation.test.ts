import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Static guarantees that the autonomous agent sits outside the human-approval
// boundary: it has no code path that can sign a permit, and the Compose
// topology gives it no access to the issuer key, the trust volume or the
// approver. (Runtime checks against the live stack are in
// scripts/semantic-demo.mjs / the Phase 4.5 report.)

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const agentSources = readdirSync(here)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));

/** Extracts one top-level service block from compose.yaml (2-space indented keys under `services:`). */
function composeService(name: string): string {
  const compose = readFileSync(join(repoRoot, "compose.yaml"), "utf8");
  const services = compose.slice(compose.indexOf("\nservices:\n"));
  const start = services.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `service ${name} not found in compose.yaml`);
  const rest = services.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n|\n[A-Za-z]/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  // Configuration only: drop YAML comment lines (they may mention other services).
  return block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

test("agent source has no permit-signing or issuer-key code path", () => {
  assert.ok(agentSources.length > 0);
  for (const { name, text } of agentSources) {
    for (const forbidden of [/signPurchasePermit/, /createKeyPairFromPrivateKeyBytes/, /createKeyPairFromBytes/, /APPROVER_/, /issuer-ed25519/, /\/keys\//]) {
      assert.doesNotMatch(text, forbidden, `${name} must not reference ${forbidden}`);
    }
  }
});

test("agent package does not depend on the approver", () => {
  const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.ok(!Object.keys(manifest.dependencies ?? {}).includes("@virtual-haibin/approver"));
});

test("compose: only the approver mounts the issuer key volume; the agent has no key, trust volume or approval network", () => {
  const agent = composeService("agent");
  assert.doesNotMatch(agent, /approver_keys|issuer_trust|\/keys|\/trust|APPROVER_|approval/);
  assert.match(composeService("approver"), /APPROVER_CODE_FILE: "\/keys\/approval-code"/);

  for (const service of ["agent", "web", "service-agent", "authority", "demo-driver"]) {
    assert.doesNotMatch(composeService(service), /approver_keys/, `${service} must not mount approver_keys`);
  }

  const approver = composeService("approver");
  assert.match(approver, /approver_keys:\/keys/);
  assert.match(approver, /127\.0\.0\.1:4003:4003/);
  assert.match(approver, /networks:\n\s+- approval\n/);

  // The authority sees only the public trust file, read-only.
  assert.match(composeService("authority"), /issuer_trust:\/trust:ro/);
});

test("compose: the authority receipt key volume is authority-only; verifiers get public keys read-only and the offline verifier has no network", () => {
  for (const service of ["agent", "web", "approver", "demo-driver"]) {
    assert.doesNotMatch(composeService(service), /authority_data|authority_trust/, `${service} must not mount authority key/trust volumes`);
  }
  // The paid service pins the authority's PUBLIC key, read-only; never its data volume.
  assert.doesNotMatch(composeService("service-agent"), /authority_data/);
  assert.match(composeService("service-agent"), /authority_trust:\/trust\/authority:ro/);

  const authority = composeService("authority");
  assert.match(authority, /authority_data:\/data/);
  assert.match(authority, /AUTHORITY_RECEIPT_KEY_FILE: "\/data\//);

  const compose = readFileSync(join(repoRoot, "compose.yaml"), "utf8");
  const verifierTemplate = compose.slice(compose.indexOf("x-verifier:"), compose.indexOf("x-dev-volumes:"));
  assert.match(verifierTemplate, /authority_trust:\/trust\/authority:ro/);
  assert.match(verifierTemplate, /issuer_trust:\/trust\/issuer:ro/);
  assert.match(verifierTemplate, /- \.:\/workspace:ro/);
  assert.doesNotMatch(verifierTemplate, /authority_data|approver_keys/);
  assert.match(composeService("verifier"), /network_mode: none/);
});

test("compose: the service signing key is service-only; others see only its public key, read-only", () => {
  for (const service of ["agent", "web", "approver", "authority", "demo-driver", "verifier"]) {
    assert.doesNotMatch(composeService(service), /service_keys/, `${service} must not mount the service key volume`);
  }

  const serviceAgent = composeService("service-agent");
  assert.match(serviceAgent, /service_keys:\/keys/);
  assert.match(serviceAgent, /SERVICE_KEY_FILE: "\/keys\//);
  assert.match(composeService("authority"), /service_trust:\/service-trust:ro/);

  const compose = readFileSync(join(repoRoot, "compose.yaml"), "utf8");
  const verifierTemplate = compose.slice(compose.indexOf("x-verifier:"), compose.indexOf("x-dev-volumes:"));
  assert.match(verifierTemplate, /service_trust:\/trust\/service:ro/);
  assert.doesNotMatch(verifierTemplate, /service_keys/);
});

test("compose: the UI-facing verifier holds no private keys, mounts read-only, and is isolated from Virtual Haibin", () => {
  const verifierApi = composeService("verifier-api");
  assert.doesNotMatch(verifierApi, /approver_keys|authority_data|service_keys/);
  assert.match(verifierApi, /- \.:\/workspace:ro/);
  for (const trust of ["issuer_trust:/trust/issuer:ro", "authority_trust:/trust/authority:ro", "service_trust:/trust/service:ro"]) {
    assert.ok(verifierApi.includes(trust), trust);
  }
  // Its own network only: it cannot resolve the authority, agent, approver or service.
  assert.match(verifierApi, /networks:\n\s+- verification\n/);
  assert.doesNotMatch(verifierApi, /- default|- approval/);
});
