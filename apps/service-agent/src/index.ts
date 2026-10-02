import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPairSigner } from "@solana/kit";
import { createPayKit, usd } from "@solana/pay-kit";
import { loadOrCreateSigningKey, publishPublicKey } from "@virtual-haibin/identity";
import { createServiceApp, type Scenario } from "./app.js";

/**
 * Mock paid dataset-report service ("merchant") for the Virtual Haibin demo.
 *
 * Wiring only (see app.ts for the endpoint and its security checks).
 *
 * One paid endpoint, POST /api/v1/report, with a typed JSON body
 * `{operation: "summarize" | "export", datasetId}`. Every operation has
 * EXACTLY the same x402 payment terms (price, payTo, asset, network): a
 * wallet-level payment policy cannot tell them apart, which is the point of
 * the Phase 4.5 demo.
 *
 * Payment protection is done entirely by the official Pay.sh / Solana Pay Kit
 * SDK (`@solana/pay-kit`): x402 `exact` challenge, in-process facilitator
 * verification and settlement on the Solana Payment Sandbox. Virtual Haibin
 * does not implement any of that here -- this service is the untrusted
 * counterparty the authority must validate.
 *
 * Phase 5C: as a Virtual Haibin-integrated merchant it ALSO refuses any paid
 * request without a valid authority-signed service authorization (checked
 * before its gate settles) and signs an acknowledgement of each fulfillment
 * with its own persistent key.
 */

const port = Number(process.env.SERVICE_AGENT_PORT ?? 4001);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (see compose.yaml).`);
  }

  return value;
}

const rpcUrl = requireEnv("SANDBOX_RPC_URL");
const recipient = requireEnv("VH_DEMO_SERVICE_RECIPIENT");
const wrongRecipient = requireEnv("VH_DEMO_WRONG_RECIPIENT");
const advertisedNetwork = requireEnv("VH_DEMO_NETWORK");
const advertisedMint = requireEnv("VH_DEMO_MINT");

/** Integer base units of the 6-decimal sandbox USDC mint: 0.01 USDC. */
const ADVERTISED_AMOUNT_ATOMIC = "10000";

// Operator = x402 facilitator fee payer + settlement signer. Ephemeral and
// sandbox-only; it pays network fees, never the customer's amount.
const operator = await generateKeyPairSigner();

// ---------------------------------------------------------------------------
// Sandbox-only funding via Surfnet cheatcodes (no-ops elsewhere). Mirrors the
// official Pay Kit playground's sandbox.ts.
// ---------------------------------------------------------------------------
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

async function rpcCall(method: string, params: unknown[]): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { error?: { message?: string } };

  if (body.error) {
    throw new Error(`${method}: ${body.error.message ?? "unknown error"}`);
  }
}

await rpcCall("surfnet_setAccount", [
  operator.address,
  { lamports: 10_000_000_000, data: "", executable: false, owner: SYSTEM_PROGRAM, rentEpoch: 0 },
]);

// Recipient token accounts must exist for x402 `exact` transfers.
for (const owner of [recipient, wrongRecipient]) {
  await rpcCall("surfnet_setTokenAccount", [owner, advertisedMint, { amount: 0, state: "initialized" }, TOKEN_PROGRAM]);
}

// ---------------------------------------------------------------------------
// Pay Kit: x402-only, sandbox ("localnet") network, fixed prices.
// ---------------------------------------------------------------------------
const pay = await createPayKit({
  accept: ["x402"],
  mpp: { challengeBindingSecret: randomBytes(32).toString("hex") },
  network: "localnet",
  operator: { recipient, signer: operator },
  stablecoins: ["USDC", "USDT"],
  pricing: {
    // The honest offer: 0.01 USDC to the advertised recipient, for EVERY
    // operation (summarize and export are deliberately the same price).
    report: { amount: usd("0.01"), description: "Dataset report (any operation)" },
    // DEMO FAULT INJECTION -- a misbehaving merchant whose real 402 differs
    // from what it advertised. The authority must deny each before paying.
    reportOvercharge: { amount: usd("0.10"), description: "Dataset report (overcharged)" },
    reportRedirect: { amount: usd("0.01"), description: "Dataset report (redirected)", payTo: wrongRecipient },
    reportOtherAsset: { amount: usd("0.01", "USDT"), description: "Dataset report (other asset)" },
  },
  rpcUrl,
});

const gates: Record<Scenario, ReturnType<typeof pay.express>> = {
  honest: pay.express("report"),
  overcharge: pay.express("reportOvercharge"),
  "wrong-recipient": pay.express("reportRedirect"),
  "wrong-asset": pay.express("reportOtherAsset"),
  // DEMO FAULT INJECTION (uncertain outcomes), both on the honest price:
  // "lost-response" settles on-chain, then drops the HTTP response;
  // "drop-credential" receives the signed credential and never settles it.
  "lost-response": pay.express("report"),
  "drop-credential": pay.express("report"),
};

// The service's own signing identity: persistent seed in the service-only
// volume (mode 0600, never logged or served); only the PUBLIC key is
// published for the authority and verifiers to pin.
const serviceKey = await loadOrCreateSigningKey(requireEnv("SERVICE_KEY_FILE"));
const serviceTrustFile = requireEnv("SERVICE_TRUST_PUBLISH_FILE");
publishPublicKey(serviceTrustFile, serviceKey.address);

// The pinned Virtual Haibin authority key, read lazily from the read-only
// trust mount: the authority starts after this service (it pins OUR key).
const authorityTrustFile = requireEnv("SERVICE_AUTHORITY_TRUST_FILE");
let authorityKey: string | null = null;

function readAuthorityKey(): string | null {
  if (authorityKey === null) {
    try {
      const key = readFileSync(authorityTrustFile, "utf8").trim();
      authorityKey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  return authorityKey;
}

const app = createServiceApp({
  gates,
  paymentOf: (request) => {
    const payment = pay.payment(request);
    return payment ? { protocol: payment.protocol ?? null, transaction: payment.transaction ?? null } : null;
  },
  serviceKey,
  authorityKey: readAuthorityKey,
  price: { network: advertisedNetwork, asset: advertisedMint, payTo: recipient, amountAtomic: ADVERTISED_AMOUNT_ATOMIC },
  feePayer: operator.address,
});

app.listen(port, () => {
  console.log(
    JSON.stringify({
      component: "service-agent",
      event: "service.started",
      port,
      environment: "Solana Payment Sandbox (Surfpool; no real funds)",
      rpcUrl,
      feePayer: operator.address,
      recipient,
      serviceKey: serviceKey.address,
      serviceKeyCreated: serviceKey.created,
      serviceTrustFile,
    }),
  );
});
