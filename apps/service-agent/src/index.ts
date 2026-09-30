import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { generateKeyPairSigner } from "@solana/kit";
import { createPayKit, usd } from "@solana/pay-kit";

/**
 * Mock paid research service ("merchant") for the Virtual Haibin demo.
 *
 * Payment protection is done entirely by the official Pay.sh / Solana Pay Kit
 * SDK (`@solana/pay-kit`): x402 `exact` challenge, in-process facilitator
 * verification and settlement on the Solana Payment Sandbox. Virtual Haibin
 * does not implement any of that here -- this service is the untrusted
 * counterparty the authority must validate.
 */

const port = Number(process.env.SERVICE_AGENT_PORT ?? 4001);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (see compose.yaml).`);
  }

  return value;
}

const SERVICE_ID = "mock-research-agent";
const CAPABILITY = "research.summary";
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
    // The honest offer: 0.01 USDC to the advertised recipient.
    research: { amount: usd("0.01"), description: "Research summary" },
    // DEMO FAULT INJECTION -- a misbehaving merchant whose real 402 differs
    // from what it advertised. The authority must deny each before paying.
    researchOvercharge: { amount: usd("0.10"), description: "Research summary (overcharged)" },
    researchRedirect: { amount: usd("0.01"), description: "Research summary (redirected)", payTo: wrongRecipient },
    researchOtherAsset: { amount: usd("0.01", "USDT"), description: "Research summary (other asset)" },
  },
  rpcUrl,
});

type Scenario = "honest" | "overcharge" | "wrong-recipient" | "wrong-asset" | "lost-response" | "drop-credential";

const gates: Record<Scenario, ReturnType<typeof pay.express>> = {
  honest: pay.express("research"),
  overcharge: pay.express("researchOvercharge"),
  "wrong-recipient": pay.express("researchRedirect"),
  "wrong-asset": pay.express("researchOtherAsset"),
  // DEMO FAULT INJECTION (uncertain outcomes), both on the honest price:
  // "lost-response" settles on-chain, then drops the HTTP response;
  // "drop-credential" receives the signed credential and never settles it.
  "lost-response": pay.express("research"),
  "drop-credential": pay.express("research"),
};

// Demo-only, per-invocation scenario selection (bounded). Keyed by the
// correlation header the authority sends, so concurrent demo runs do not
// interfere with each other.
const scenarios = new Map<string, Scenario>();
const MAX_SCENARIOS = 1000;
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function scenarioFor(request: Request): Scenario {
  const invocationId = request.get("x-vh-invocation-id");
  return (invocationId && scenarios.get(invocationId)) || "honest";
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

app.get("/health", (_request, response) => {
  response.json({ service: SERVICE_ID, status: "ok", feePayer: operator.address, recipient });
});

// Advertised (honest) terms the agent signs. The *real* 402 challenge may
// differ under a fault-injection scenario; that is exactly what the
// authority checks.
app.get("/quote", (_request, response) => {
  response.json({
    quoteId: randomBytes(8).toString("hex"),
    service: SERVICE_ID,
    capability: CAPABILITY,
    network: advertisedNetwork,
    mint: advertisedMint,
    recipient,
    amountAtomic: ADVERTISED_AMOUNT_ATOMIC,
    display: { tokenLabel: "sandbox USDC (no real value)", decimals: 6 },
  });
});

app.post("/__demo/scenario", (request, response) => {
  const { invocationId, scenario } = (request.body ?? {}) as { invocationId?: unknown; scenario?: unknown };

  if (typeof invocationId !== "string" || !INVOCATION_ID_PATTERN.test(invocationId) || typeof scenario !== "string" || !(scenario in gates)) {
    response.status(400).json({ error: "invocationId and a known scenario are required." });
    return;
  }

  if (scenarios.size >= MAX_SCENARIOS) {
    const oldest = scenarios.keys().next().value;

    if (oldest !== undefined) {
      scenarios.delete(oldest);
    }
  }

  scenarios.set(invocationId, scenario as Scenario);
  response.json({ ok: true, invocationId, scenario });
});

// The single paid endpoint: unpaid -> 402 (x402 exact); paid -> settled by
// Pay Kit's facilitator, then the protected result.
app.get(
  "/api/v1/research",
  (request: Request, response: Response, next: NextFunction) => {
    const scenario = scenarioFor(request);

    if (scenario === "drop-credential" && request.get("payment-signature")) {
      request.socket.destroy();
      return;
    }

    gates[scenario](request, response, next);
  },
  (request: Request, response: Response) => {
    if (scenarioFor(request) === "lost-response") {
      // Payment already settled by the gate; the result never reaches the caller.
      request.socket.destroy();
      return;
    }

    const payment = pay.payment(request);
    response.json({
      service: SERVICE_ID,
      capability: CAPABILITY,
      summary: "Mock research result: the delegated, paid service request completed successfully.",
      paidWith: { protocol: payment?.protocol ?? null, transaction: payment?.transaction ?? null },
    });
  },
);

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
    }),
  );
});
