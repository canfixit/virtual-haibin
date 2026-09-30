import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.SERVICE_AGENT_PORT ?? 4001);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (see compose.yaml).`);
  }

  return value;
}

// Authoritative payment identifiers this mock service quotes. They come from
// deployment configuration, never from the caller, so a quote cannot be
// steered to a different mint/recipient by request parameters (except via
// the explicit demo fault-injection scenario below).
const SERVICE_ID = "mock-research-agent";
const CAPABILITY = "research.summary";
const network = requireEnv("VH_DEMO_NETWORK");
const mint = requireEnv("VH_DEMO_MINT");
const recipient = requireEnv("VH_DEMO_SERVICE_RECIPIENT");
const wrongRecipient = requireEnv("VH_DEMO_WRONG_RECIPIENT");

const DEFAULT_AMOUNT_ATOMIC = "10000";

/** Same canonical form as PurchasePermit amounts: integer string, no sign/decimal/leading zeros. */
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function discardBody(request: IncomingMessage) {
  for await (const _chunk of request) {
    // Intentionally consume the request body for this mock endpoint.
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `localhost:${port}`}`,
  );

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      service: SERVICE_ID,
      status: "ok",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/quote") {
    const amountAtomic = url.searchParams.get("amountAtomic") ?? DEFAULT_AMOUNT_ATOMIC;

    if (!ATOMIC_AMOUNT_PATTERN.test(amountAtomic) || amountAtomic === "0") {
      sendJson(response, 400, {
        error: "amountAtomic must be a positive canonical integer string.",
      });
      return;
    }

    const scenario = url.searchParams.get("scenario");

    if (scenario !== null && scenario !== "wrong-recipient") {
      sendJson(response, 400, { error: "Unsupported scenario." });
      return;
    }

    sendJson(response, 200, {
      quoteId: crypto.randomUUID(),
      service: SERVICE_ID,
      capability: CAPABILITY,
      network,
      mint,
      // DEMO FAULT INJECTION: `scenario=wrong-recipient` simulates a service
      // quote that asks to be paid at an address the human never authorized
      // (demo Case 3, semantic DENY).
      recipient: scenario === "wrong-recipient" ? wrongRecipient : recipient,
      amountAtomic,
      // Display-only; never used for authorization. The authoritative token
      // identity is `mint`. Not real USDC.
      display: { tokenLabel: "VH-DEMO-TOKEN", decimals: 6 },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/execute") {
    await discardBody(request);

    sendJson(response, 200, {
      provider: SERVICE_ID,
      result:
        "Mock research result: the delegated service request completed successfully.",
      paymentReference:
        request.headers["x-payment-reference"] ?? "not-provided",
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`Mock service agent listening on http://localhost:${port}`);
});
