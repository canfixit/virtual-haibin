import { createVerifierServer } from "./server.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see compose.yaml).`);
  return value;
}

const port = Number(process.env.VERIFIER_PORT ?? 4004);
const server = createVerifierServer({
  issuerTrustFile: requireEnv("VERIFIER_ISSUER_TRUST_FILE"),
  authorityTrustFile: requireEnv("VERIFIER_AUTHORITY_TRUST_FILE"),
  ...(process.env.VERIFIER_SERVICE_TRUST_FILE ? { serviceTrustFile: process.env.VERIFIER_SERVICE_TRUST_FILE } : {}),
  ...(process.env.VERIFIER_RPC_URL ? { rpcUrl: process.env.VERIFIER_RPC_URL } : {}),
  allowedOrigin: requireEnv("VERIFIER_ALLOWED_ORIGIN"),
});

server.listen(port, () => console.log(JSON.stringify({ component: "verifier-api", event: "verifier.started", port })));
