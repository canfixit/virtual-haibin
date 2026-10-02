import { renameSync, writeFileSync } from "node:fs";
import { loadOrCreateApprovalCode, loadOrCreateIssuerKey } from "./issuer-key.js";
import { createApproverServer } from "./server.js";

/**
 * Virtual Haibin human-approval boundary (demo).
 *
 * The ONLY process that holds the PurchasePermit issuer private key. The
 * key (and the human's approval code, APPROVER_CODE_FILE) live in the
 * approver-only Docker volume (APPROVER_KEY_FILE); this
 * process publishes just the issuer PUBLIC key to the trust volume
 * (APPROVER_TRUST_FILE), which the authority mounts read-only as its issuer
 * trust root. The agent, web app, paid service and authority never see the
 * private key.
 */

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (see compose.yaml).`);
  }

  return value;
}

const port = Number(process.env.APPROVER_PORT ?? 4003);
const keyFile = requireEnv("APPROVER_KEY_FILE");
const approvalCodeFile = requireEnv("APPROVER_CODE_FILE");
const trustFile = requireEnv("APPROVER_TRUST_FILE");
const allowedOrigin = requireEnv("APPROVER_ALLOWED_ORIGIN");
const network = requireEnv("VH_DEMO_NETWORK");

// Phase 4/4.5 settle only on the Solana Payment Sandbox (no real funds).
if (network !== "solana-payment-sandbox") {
  throw new Error("VH_DEMO_NETWORK must be solana-payment-sandbox for the hackathon demo.");
}

const issuer = await loadOrCreateIssuerKey(keyFile);
const approval = loadOrCreateApprovalCode(approvalCodeFile);

// Publish the public key atomically (write + rename) so the authority never
// reads a half-written trust root.
writeFileSync(`${trustFile}.tmp`, `${issuer.address}\n`, { mode: 0o644 });
renameSync(`${trustFile}.tmp`, trustFile);

const server = createApproverServer({
  issuer,
  approvalCode: approval.code,
  allowedOrigin,
  terms: {
    service: "mock-dataset-reports",
    capability: "reports.generate",
    network,
    mint: requireEnv("VH_DEMO_MINT"),
    recipient: requireEnv("VH_DEMO_SERVICE_RECIPIENT"),
    // 0.02 / 0.05 sandbox USDC (6-decimal mint), in base units.
    maxPerCallAtomic: "20000",
    maxTotalAtomic: "50000",
    ttlMs: 30 * 60 * 1000,
    method: "POST",
    resource: "/api/v1/report",
  },
});

server.listen(port, () => {
  console.log(
    JSON.stringify({
      component: "approver",
      event: "approver.started",
      port,
      issuer: issuer.address,
      issuerKeyCreated: issuer.created,
      // Location only, never the value: the human reads it with
      // `docker compose exec approver cat <file>`.
      approvalCodeFile,
      approvalCodeCreated: approval.created,
      trustFile,
      allowedOrigin,
    }),
  );
});

function shutdown(signal: string): void {
  server.close(() => {
    console.log(JSON.stringify({ component: "approver", event: "approver.stopped", signal }));
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
