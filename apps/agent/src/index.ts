import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { createAgentServer } from "./server.js";

const port = Number(process.env.AGENT_PORT ?? 4000);
const serviceAgentUrl = process.env.SERVICE_AGENT_URL ?? "http://localhost:4001";
const authorityUrl = process.env.AUTHORITY_URL ?? "http://localhost:4002";
const authoritySharedSecret = process.env.AUTHORITY_SHARED_SECRET;
// Explicit development CORS origin (the demo web UI); never "*".
const allowedOrigin = process.env.AGENT_ALLOWED_ORIGIN ?? "http://localhost:5173";

if (!authoritySharedSecret) {
  throw new Error(
    "AUTHORITY_SHARED_SECRET is required. This agent process must present it " +
      "to reach the protected authority service; set it in the gitignored .env " +
      "file for local development.",
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (see compose.yaml).`);
  }

  return value;
}

// The agent's *identity* key: it signs authorization requests so the
// authority can verify the caller is the permit's authorizedAgent. It is
// deliberately not a spending key -- it controls no funds and the authority
// never accepts it for payment; only the authority constructs and signs
// payments. Generated as a non-extractable WebCrypto key, fresh per process:
// the human approves a permit for this identity (GET /identity) after the
// agent starts. Persistent agent identity storage is future work.
//
// This process holds NO permit-issuer key and cannot create or widen a
// PurchasePermit: permits are issued by the separate human-approval
// boundary (apps/approver) and only *installed* here (POST /permit), into
// the caller's own demo session (see sessions.ts).
const agentIdentity = await generateKeyPair();
const agentAddress = await getAddressFromPublicKey(agentIdentity.publicKey);

const server = createAgentServer({
  agentIdentity,
  agentAddress,
  serviceAgentUrl,
  authorityUrl,
  authoritySharedSecret,
  authorityAudience: requireEnv("AUTHORITY_AUDIENCE"),
  allowedOrigin,
});

server.listen(port, () => {
  console.log(`Virtual Haibin agent listening on http://localhost:${port}; service agent: ${serviceAgentUrl}; authority: ${authorityUrl}`);
});
