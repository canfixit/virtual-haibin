import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import type { Mandate } from "@virtual-haibin/mandate";
import { MockPaymentProvider } from "@virtual-haibin/payments";
import { evaluateMandate } from "@virtual-haibin/policy";

const port = Number(process.env.AGENT_PORT ?? 4000);
const serviceAgentUrl =
  process.env.SERVICE_AGENT_URL ?? "http://localhost:4001";

const auditLog = new InMemoryAuditLog();
const paymentProvider = new MockPaymentProvider();

type DemoRequest = {
  quotedPrice?: number;
};

type ServiceQuote = {
  provider: string;
  service: string;
  price: number;
  token: string;
};

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  setCors(response);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function createDemoMandate(): Mandate {
  const issuedAt = Date.now();

  return {
    id: "VH-DEMO-001",
    issuer: "demo-human",
    agent: "virtual-haibin",
    capabilities: ["research.summary"],
    spending: {
      token: "USDC",
      maxPerTransaction: 0.02,
      maxTotal: 0.05,
    },
    issuedAt,
    expiresAt: issuedAt + 30 * 60 * 1000,
    nonce: crypto.randomUUID(),
    signature: "mock-signature",
  };
}

async function runDemo(quotedPrice: number) {
  const mandate = createDemoMandate();

  const quoteResponse = await fetch(
    `${serviceAgentUrl}/quote?price=${encodeURIComponent(quotedPrice)}`,
  );

  if (!quoteResponse.ok) {
    throw new Error(
      `Service quote failed with status ${quoteResponse.status}.`,
    );
  }

  const quote = (await quoteResponse.json()) as ServiceQuote;

  const decision = evaluateMandate(mandate, {
    capability: quote.service,
    amount: quote.price,
    token: quote.token,
    alreadySpent: 0,
  });

  auditLog.append({
    type: "policy.decision",
    actor: mandate.agent,
    mandateId: mandate.id,
    data: {
      allowed: decision.allowed,
      reasons: decision.reasons,
      requestedAmount: quote.price,
      capability: quote.service,
    },
  });

  if (!decision.allowed) {
    return {
      status: "DENIED",
      mandate,
      quote,
      decision,
      audit: auditLog.list(),
    };
  }

  const payment = await paymentProvider.pay({
    from: mandate.agent,
    to: quote.provider,
    token: quote.token,
    amount: quote.price,
    reference: mandate.id,
  });

  auditLog.append({
    type: "payment.completed",
    actor: mandate.agent,
    mandateId: mandate.id,
    data: payment,
  });

  const executionResponse = await fetch(`${serviceAgentUrl}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-reference": payment.transactionId,
    },
    body: JSON.stringify({
      task: "Provide a concise market summary.",
      mandateId: mandate.id,
    }),
  });

  if (!executionResponse.ok) {
    throw new Error(
      `Service execution failed with status ${executionResponse.status}.`,
    );
  }

  const result = (await executionResponse.json()) as unknown;

  auditLog.append({
    type: "service.completed",
    actor: mandate.agent,
    mandateId: mandate.id,
    data: { provider: quote.provider },
  });

  return {
    status: "COMPLETED",
    mandate,
    quote,
    decision,
    payment,
    result,
    audit: auditLog.list(),
  };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      setCors(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        service: "virtual-haibin-agent",
        status: "ok",
      });
      return;
    }

    if (request.method === "POST" && request.url === "/demo") {
      const body = await readJson<DemoRequest>(request);
      const quotedPrice =
        typeof body.quotedPrice === "number" ? body.quotedPrice : 0.01;

      const result = await runDemo(quotedPrice);
      const statusCode = result.status === "DENIED" ? 403 : 200;

      sendJson(response, statusCode, result);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

server.listen(port, () => {
  console.log(
    `Virtual Haibin agent listening on http://localhost:${port}; service agent: ${serviceAgentUrl}`,
  );
});
