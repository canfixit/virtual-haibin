import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { SANDBOX_USDC_MINT, solanaPaymentSandboxProfile, X402ExactPaymentProvider } from "@virtual-haibin/payments";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AuthorityService } from "./authorize.js";
import { createPaidServiceRegistry } from "./payment-challenge.js";
import { createAuthorityServer } from "./server.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import { loadIssuerEntitlement } from "./trust.js";

const port = Number(process.env.AUTHORITY_PORT ?? 4002);
const sharedSecret = process.env.AUTHORITY_SHARED_SECRET;
// Stable, non-secret identifier agents must name in every signed request.
// The authority key itself is ephemeral per process, so it is not used as
// the audience.
const audience = process.env.AUTHORITY_AUDIENCE;
// Durable budget/invocation state. In Compose this is a named volume, never
// a path inside the source tree.
const databasePath = process.env.AUTHORITY_DB_PATH;

// Trusted settlement + paid-service configuration (authority-only env).
const sandboxRpcUrl = process.env.SANDBOX_RPC_URL;
const paidReportUrl = process.env.PAID_SERVICE_REPORT_URL;
// Issuer trust root: file holding the one trusted issuer public key
// (read-only mount; see trust.ts).
const trustedIssuerFile = process.env.AUTHORITY_TRUSTED_ISSUER_FILE;

if (!sandboxRpcUrl || !paidReportUrl) {
  throw new Error("SANDBOX_RPC_URL and PAID_SERVICE_REPORT_URL are required (see compose.yaml).");
}

if (!trustedIssuerFile) {
  throw new Error("AUTHORITY_TRUSTED_ISSUER_FILE is required (see compose.yaml).");
}

if (!databasePath) {
  throw new Error("AUTHORITY_DB_PATH is required (see compose.yaml).");
}

if (!audience) {
  throw new Error("AUTHORITY_AUDIENCE is required (see compose.yaml).");
}

// Refuse to run with a missing, short, or copied-from-example secret so the
// placeholder in .env.example can never silently become the real credential.
const PLACEHOLDER_SECRET = "replace-with-local-development-secret";
const MIN_SECRET_LENGTH = 32;

if (!sharedSecret || sharedSecret.length < MIN_SECRET_LENGTH || sharedSecret === PLACEHOLDER_SECRET) {
  throw new Error(
    "AUTHORITY_SHARED_SECRET must be set to a random value of at least " +
      `${MIN_SECRET_LENGTH} characters (not the .env.example placeholder). ` +
      "It is a dev-only bearer token authenticating agent -> authority " +
      "requests; set it in the gitignored .env file for local development.",
  );
}

// The authority's own signing key. It is generated fresh in this process
// and never leaves it -- no other service, including the agent, has access
// to it. This is distinct from any future Solana payment-signing key
// (Phase 4); for now it signs only this service's own authorization
// receipts (see receipt.ts). Receipts stored by an earlier process remain
// valid evidence: each names the authority address that signed it.
const authoritySigner = await generateKeyPair();
const authorityAddress = await getAddressFromPublicKey(authoritySigner.publicKey);

// Settlement profile: Pay.sh Solana Payment Sandbox (hosted Surfpool test
// validator; no real funds), pinned to one RPC. See settlement-profile.ts
// for why the challenge alone cannot distinguish sandbox from mainnet.
const sandboxProfile = solanaPaymentSandboxProfile(sandboxRpcUrl);

// Payment wallet: a *separate*, ephemeral, sandbox-only key held only by the
// payment provider (not the receipt key above, not the agent's identity key,
// not the permit issuer's key). It is never logged or returned.
const paymentProvider = await X402ExactPaymentProvider.create({ profile: sandboxProfile });
const { surfnetVersion } = await paymentProvider.assertSandboxEnvironment();
// 100 sandbox USDC (6-decimal mint) via Surfnet cheatcode; sandbox only.
await paymentProvider.fundSandboxWallet(SANDBOX_USDC_MINT, 100_000_000n);

const paidServices = createPaidServiceRegistry([
  { serviceId: "mock-dataset-reports", capability: "reports.generate", url: paidReportUrl, method: "POST" },
]);

// Only this issuer may authorize spending from the payment wallet above, and
// only on the sandbox profile.
const issuerEntitlement = loadIssuerEntitlement(trustedIssuerFile, [sandboxProfile.permitNetwork]);

mkdirSync(dirname(databasePath), { recursive: true });
const store = new SqliteAuthorityStore(databasePath);

const authorityService = new AuthorityService({
  authoritySigner,
  authorityAddress,
  audience,
  issuerEntitlement,
  paymentProvider,
  paidServices,
  settlementProfiles: new Map([[sandboxProfile.permitNetwork, sandboxProfile]]),
  store,
});

// Before serving: anything a previous process left mid-payment has an
// unknown outcome and must never be paid again automatically.
const interrupted = await authorityService.recoverInterruptedInvocations();

// Reconciliation is read-only toward the chain (never pays). Run once now
// and periodically for invocations whose blockhash had not yet expired.
let reconciling = false;

async function reconcileOnce(trigger: string): Promise<void> {
  if (reconciling) {
    return;
  }

  reconciling = true;

  try {
    const reports = await authorityService.reconcile();

    // Log at startup, or when something changed/failed; stay quiet while
    // invocations are merely still pending.
    const notable = reports.filter((report) => report.outcome !== "still_pending" && report.outcome !== "no_attempt_recorded");

    if (trigger === "startup" ? reports.length > 0 : notable.length > 0) {
      console.log(JSON.stringify({ component: "authority", event: "authority.reconciliation_run", trigger, reports }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ component: "authority", event: "authority.reconciliation_error", error: error instanceof Error ? error.message : "unknown" }),
    );
  } finally {
    reconciling = false;
  }
}

await reconcileOnce("startup");
const reconcileTimer = setInterval(() => void reconcileOnce("interval"), 15_000);
reconcileTimer.unref();

const server = createAuthorityServer({ authorityService, authorityAddress, sharedSecret });

server.listen(port, () => {
  console.log(
    JSON.stringify({
      component: "authority",
      event: "authority.started",
      port,
      authorityAddress,
      trustedIssuer: issuerEntitlement.issuer,
      databasePath,
      recoveredToReconciliation: interrupted.reconciliationRequired.length,
      releasedNeverSubmitted: interrupted.releasedNeverSubmitted.length,
      settlementProfile: sandboxProfile.name,
      environment: "Solana Payment Sandbox (Surfpool; no real funds)",
      sandboxRpcUrl: sandboxProfile.rpcUrl,
      surfnetVersion,
      paymentWallet: paymentProvider.payerAddress,
    }),
  );
});

function shutdown(signal: string): void {
  clearInterval(reconcileTimer);
  server.close(() => {
    void store.close().finally(() => {
      console.log(JSON.stringify({ component: "authority", event: "authority.stopped", signal }));
      process.exit(0);
    });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
