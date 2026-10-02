import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { generateKeyPairSigner } from "@solana/kit";
import { createPayKit, usd } from "@solana/pay-kit";

/**
 * Mock paid dataset-report service ("merchant") for the Virtual Haibin demo.
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
 */

const port = Number(process.env.SERVICE_AGENT_PORT ?? 4001);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (see compose.yaml).`);
  }

  return value;
}

const SERVICE_ID = "mock-dataset-reports";
const CAPABILITY = "reports.generate";
const REPORT_RESOURCE = "/api/v1/report";
const OPERATIONS = ["summarize", "export"] as const;
type Operation = (typeof OPERATIONS)[number];

// Synthetic demo data. "export" returns the rows; "summarize" only aggregates.
const DATASETS: Record<string, Array<{ region: string; revenue: number }>> = {
  "dataset-a": [
    { region: "north", revenue: 120 },
    { region: "south", revenue: 95 },
    { region: "east", revenue: 143 },
  ],
  "dataset-b": [
    { region: "west", revenue: 88 },
    { region: "central", revenue: 131 },
  ],
};
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

type Scenario = "honest" | "overcharge" | "wrong-recipient" | "wrong-asset" | "lost-response" | "drop-credential";

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

// Advertised (honest) terms the agent signs. Identical for every operation.
// The *real* 402 challenge may differ under a fault-injection scenario;
// that is exactly what the authority checks.
app.get("/quote", (_request, response) => {
  response.json({
    quoteId: randomBytes(8).toString("hex"),
    service: SERVICE_ID,
    capability: CAPABILITY,
    method: "POST",
    resource: REPORT_RESOURCE,
    operations: OPERATIONS,
    network: advertisedNetwork,
    mint: advertisedMint,
    recipient,
    amountAtomic: ADVERTISED_AMOUNT_ATOMIC,
    display: { tokenLabel: "sandbox USDC (no real value)", decimals: 6, note: "same price for every operation" },
  });
});

type ReportRequest = { operation: Operation; datasetId: string };

/** Strict body validation: exactly {operation, datasetId}; anything else is 400 before any 402. */
function parseReportRequest(body: unknown): ReportRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (keys.length !== 2 || keys[0] !== "datasetId" || keys[1] !== "operation") {
    return null;
  }

  if (typeof record.operation !== "string" || !(OPERATIONS as readonly string[]).includes(record.operation)) {
    return null;
  }

  if (typeof record.datasetId !== "string" || !Object.hasOwn(DATASETS, record.datasetId)) {
    return null;
  }

  return { operation: record.operation as Operation, datasetId: record.datasetId };
}

function runReport({ operation, datasetId }: ReportRequest): unknown {
  const rows = DATASETS[datasetId] ?? [];

  if (operation === "export") {
    return { kind: "export", rowCount: rows.length, rows };
  }

  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  return { kind: "summary", rowCount: rows.length, totalRevenue: total, topRegion: [...rows].sort((a, b) => b.revenue - a.revenue)[0]?.region ?? null };
}

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
// Pay Kit's facilitator, then the protected result for exactly the
// requested operation. The body is validated before the payment gate, so a
// malformed request is a 400, never a priced 402.
app.post(
  REPORT_RESOURCE,
  (request: Request, response: Response, next: NextFunction) => {
    const report = parseReportRequest(request.body);

    if (report === null) {
      response.status(400).json({ error: `Body must be exactly {operation: ${OPERATIONS.join("|")}, datasetId: ${Object.keys(DATASETS).join("|")}}.` });
      return;
    }

    response.locals.report = report;
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
    const report = response.locals.report as ReportRequest;
    console.log(
      JSON.stringify({
        component: "service-agent",
        event: "service.fulfilled",
        invocationId: request.get("x-vh-invocation-id") ?? null,
        operation: report.operation,
        datasetId: report.datasetId,
        transaction: payment?.transaction ?? null,
      }),
    );
    response.json({
      service: SERVICE_ID,
      capability: CAPABILITY,
      // Echo of exactly what this service received and performed.
      received: { method: request.method, resource: REPORT_RESOURCE, operation: report.operation, datasetId: report.datasetId },
      result: runReport(report),
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
