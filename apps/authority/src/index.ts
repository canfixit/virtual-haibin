import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { MockPaymentProvider } from "@virtual-haibin/payments";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AuthorityService } from "./authorize.js";
import { createAuthorityServer } from "./server.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";

const port = Number(process.env.AUTHORITY_PORT ?? 4002);
const sharedSecret = process.env.AUTHORITY_SHARED_SECRET;
// Stable, non-secret identifier agents must name in every signed request.
// The authority key itself is ephemeral per process, so it is not used as
// the audience.
const audience = process.env.AUTHORITY_AUDIENCE;
// Durable budget/invocation state. In Compose this is a named volume, never
// a path inside the source tree.
const databasePath = process.env.AUTHORITY_DB_PATH;

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

mkdirSync(dirname(databasePath), { recursive: true });
const store = new SqliteAuthorityStore(databasePath);

const authorityService = new AuthorityService({
  authoritySigner,
  authorityAddress,
  audience,
  paymentProvider: new MockPaymentProvider(),
  store,
});

// Before serving: anything a previous process left mid-payment has an
// unknown outcome and must never be paid again automatically.
const interrupted = await authorityService.recoverInterruptedInvocations();

const server = createAuthorityServer({ authorityService, authorityAddress, sharedSecret });

server.listen(port, () => {
  console.log(
    JSON.stringify({
      component: "authority",
      event: "authority.started",
      port,
      authorityAddress,
      databasePath,
      recoveredToReconciliation: interrupted.length,
    }),
  );
});

function shutdown(signal: string): void {
  server.close(() => {
    void store.close().finally(() => {
      console.log(JSON.stringify({ component: "authority", event: "authority.stopped", signal }));
      process.exit(0);
    });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
