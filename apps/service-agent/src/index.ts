import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.SERVICE_AGENT_PORT ?? 4001);

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
      service: "mock-research-agent",
      status: "ok",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/quote") {
    const requestedPrice = Number(url.searchParams.get("price") ?? 0.01);
    const price =
      Number.isFinite(requestedPrice) && requestedPrice > 0
        ? requestedPrice
        : 0.01;

    sendJson(response, 200, {
      provider: "mock-research-agent",
      service: "research.summary",
      price,
      token: "USDC",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/execute") {
    await discardBody(request);

    sendJson(response, 200, {
      provider: "mock-research-agent",
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
