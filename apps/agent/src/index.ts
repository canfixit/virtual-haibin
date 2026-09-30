import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION,
  computePermitDigest,
  signAuthorizationRequest,
  signPurchasePermit,
  type AuthorizationRequestV1,
  type SignedPurchasePermitV1,
} from "@virtual-haibin/mandate";

const port = Number(process.env.AGENT_PORT ?? 4000);
const serviceAgentUrl = process.env.SERVICE_AGENT_URL ?? "http://localhost:4001";
const authorityUrl = process.env.AUTHORITY_URL ?? "http://localhost:4002";
const authoritySharedSecret = process.env.AUTHORITY_SHARED_SECRET;

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

// Public demo payment identifiers the simulated human authorizes. The mock
// service is configured with the same values, so an honest quote matches the
// permit; the authority -- not this agent -- decides whether it does.
const demoNetwork = requireEnv("VH_DEMO_NETWORK");
const demoMint = requireEnv("VH_DEMO_MINT");
const demoServiceRecipient = requireEnv("VH_DEMO_SERVICE_RECIPIENT");
const authorityAudience = requireEnv("AUTHORITY_AUDIENCE");

// The agent's *identity* key: it signs authorization requests so the
// authority can verify the caller is the permit's authorizedAgent. It is
// deliberately not a spending key -- it controls no funds and the authority
// never accepts it for payment; only the authority constructs and signs
// payments. Generated as a non-extractable WebCrypto key, fresh per process:
// an ephemeral identity is acceptable for the demo because the demo permit
// below is issued to this same identity at startup. Persistent agent
// identity storage (and re-issuing permits to it) is future work.
const agentIdentity = await generateKeyPair();
const agentIdentityAddress = await getAddressFromPublicKey(agentIdentity.publicKey);

const auditLog = new InMemoryAuditLog();

/** Same canonical form as PurchasePermit amounts: integer string, no sign/decimal/leading zeros. */
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const DEFAULT_AMOUNT_ATOMIC = "10000";
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

// Simulates the human's one-time signing step from the target architecture
// (CLAUDE.md §4: "Human -- signs PurchasePermit --> Agent"). DEMO ONLY:
// `issuerKeypair` stands in for the human and is used only here, at startup,
// to issue one permit to this agent's identity; nothing downstream needs it
// again. In a real deployment the human signs elsewhere and the agent only
// ever receives the signed permit.
async function createDemoPermit(): Promise<SignedPurchasePermitV1> {
  const issuerKeypair = await generateKeyPair();
  const issuer = await getAddressFromPublicKey(issuerKeypair.publicKey);
  const issuedAt = Date.now();

  if (demoNetwork !== "devnet") {
    throw new Error("VH_DEMO_NETWORK must be devnet for the hackathon demo.");
  }

  return signPurchasePermit(
    {
      version: 1,
      domain: "virtual-haibin/purchase-permit",
      grantId: `VH-GRANT-${crypto.randomUUID()}`,
      issuer,
      authorizedAgent: agentIdentityAddress,
      service: "mock-research-agent",
      capability: "research.summary",
      network: demoNetwork,
      mint: demoMint,
      recipient: demoServiceRecipient,
      // 0.02 / 0.05 of a 6-decimal demo token, expressed directly in atomic units.
      maxPerCallAtomic: "20000",
      maxTotalAtomic: "50000",
      issuedAt,
      expiresAt: issuedAt + 30 * 60 * 1000,
      subdelegation: false,
    },
    issuerKeypair,
  );
}

const demoPermit = await createDemoPermit();
const demoPermitDigest = await computePermitDigest(demoPermit);

type DemoScenario = "honest" | "wrong-recipient";

type DemoInput = {
  amountAtomic: string;
  invocationId: string;
  scenario: DemoScenario;
};

/** The authoritative fields of a service quote; forwarded verbatim to the authority. */
type ServiceQuote = {
  quoteId: string;
  service: string;
  capability: string;
  network: string;
  mint: string;
  recipient: string;
  amountAtomic: string;
  display?: unknown;
};

class HttpInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The quote is untrusted input from an external service. The agent only
 * checks it is well-formed; whether it is *authorized* is decided by the
 * authority against the signed permit.
 */
function parseServiceQuote(value: unknown): ServiceQuote {
  if (!isPlainObject(value)) {
    throw new Error("Service quote must be a JSON object.");
  }

  for (const field of ["quoteId", "service", "capability", "network", "mint", "recipient", "amountAtomic"] as const) {
    const fieldValue = value[field];

    if (typeof fieldValue !== "string" || fieldValue.length === 0 || fieldValue.length > 256) {
      throw new Error(`Service quote field ${field} must be a non-empty string.`);
    }
  }

  return value as ServiceQuote;
}

function parseDemoInput(body: unknown): DemoInput {
  if (!isPlainObject(body)) {
    throw new HttpInputError("Request body must be a JSON object.", 400);
  }

  if ("quotedPrice" in body) {
    throw new HttpInputError(
      "quotedPrice (decimal number) is no longer supported; send amountAtomic as a canonical integer string.",
      400,
    );
  }

  const amountAtomic = body.amountAtomic ?? DEFAULT_AMOUNT_ATOMIC;

  if (typeof amountAtomic !== "string" || !ATOMIC_AMOUNT_PATTERN.test(amountAtomic)) {
    throw new HttpInputError("amountAtomic must be a canonical non-negative integer string.", 400);
  }

  const invocationId = body.invocationId ?? crypto.randomUUID();

  if (typeof invocationId !== "string" || !INVOCATION_ID_PATTERN.test(invocationId)) {
    throw new HttpInputError("invocationId must be 1-128 characters of [A-Za-z0-9_.:-].", 400);
  }

  const scenario = body.scenario ?? "honest";

  if (scenario !== "honest" && scenario !== "wrong-recipient") {
    throw new HttpInputError('scenario must be "honest" or "wrong-recipient".', 400);
  }

  return { amountAtomic, invocationId, scenario };
}

type AuthorizeResponseBody = {
  decision: "ALLOW" | "DENY";
  replay: boolean;
  receipt: {
    invocationId: string;
    grantId: string;
    decision: "ALLOW" | "DENY";
    reasonCodes: string[];
    paymentTransactionId: string | null;
    decidedAt: number;
    signature: { algorithm: string; signature: string };
  };
};

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  setCors(response);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpInputError("Request body too large.", 413);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpInputError("Request body must be valid JSON.", 400);
  }
}

async function runDemo(input: DemoInput) {
  const quoteUrl = new URL("/quote", serviceAgentUrl);
  quoteUrl.searchParams.set("amountAtomic", input.amountAtomic);

  if (input.scenario === "wrong-recipient") {
    quoteUrl.searchParams.set("scenario", "wrong-recipient");
  }

  const quoteResponse = await fetch(quoteUrl);

  if (!quoteResponse.ok) {
    throw new Error(`Service quote failed with status ${quoteResponse.status}.`);
  }

  const quote = parseServiceQuote(await quoteResponse.json());

  // Forward the quote's authoritative fields verbatim. The agent does not
  // substitute values from the permit: the authority must see what the
  // service actually asked to be paid. The whole request is signed with the
  // agent identity key and bound to this exact permit and authority.
  const authorizationRequest: AuthorizationRequestV1 = {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION,
    audience: authorityAudience,
    grantId: demoPermit.grantId,
    permitDigest: demoPermitDigest,
    invocationId: input.invocationId,
    service: quote.service,
    capability: quote.capability,
    network: quote.network,
    mint: quote.mint,
    recipient: quote.recipient,
    amountAtomic: quote.amountAtomic,
    issuedAt: Date.now(),
  };
  const agentSignature = await signAuthorizationRequest(authorizationRequest, agentIdentity);

  const authorizeResponse = await fetch(`${authorityUrl}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authoritySharedSecret}`,
    },
    body: JSON.stringify({ permit: demoPermit, authorizationRequest, agentSignature }),
  });

  if (authorizeResponse.status === 401 || authorizeResponse.status === 409) {
    const refusal = (await authorizeResponse.json()) as { reasonCode?: string };
    return {
      // e.g. INVOCATION_CONFLICT, RECONCILIATION_REQUIRED, AGENT_SIGNATURE_INVALID
      status: refusal.reasonCode ?? "REFUSED",
      httpStatus: authorizeResponse.status,
      invocationId: input.invocationId,
      quote,
      authority: refusal,
      audit: auditLog.list(),
    };
  }

  if (!authorizeResponse.ok) {
    throw new Error(`Authority request failed with status ${authorizeResponse.status}.`);
  }

  const authorization = (await authorizeResponse.json()) as AuthorizeResponseBody;

  auditLog.append({
    type: "authority.decision",
    actor: demoPermit.authorizedAgent,
    mandateId: demoPermit.grantId,
    data: {
      decision: authorization.decision,
      reasonCodes: authorization.receipt.reasonCodes,
      invocationId: input.invocationId,
      replay: authorization.replay,
    },
  });

  if (authorization.decision !== "ALLOW") {
    return {
      status: "DENIED",
      invocationId: input.invocationId,
      quote,
      authorization,
      audit: auditLog.list(),
    };
  }

  const executionResponse = await fetch(`${serviceAgentUrl}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-reference": authorization.receipt.paymentTransactionId ?? "",
    },
    body: JSON.stringify({
      task: "Provide a concise market summary.",
      grantId: demoPermit.grantId,
    }),
  });

  if (!executionResponse.ok) {
    throw new Error(`Service execution failed with status ${executionResponse.status}.`);
  }

  const result = (await executionResponse.json()) as unknown;

  auditLog.append({
    type: "service.completed",
    actor: demoPermit.authorizedAgent,
    mandateId: demoPermit.grantId,
    data: { service: quote.service },
  });

  return {
    status: authorization.replay ? "REPLAYED" : "COMPLETED",
    invocationId: input.invocationId,
    quote,
    authorization,
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
      sendJson(response, 200, { service: "virtual-haibin-agent", status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/permit") {
      sendJson(response, 200, { permit: demoPermit });
      return;
    }

    if (request.method === "POST" && request.url === "/demo") {
      // TRANSITIONAL demo entry point for the current UI. Phase 7 replaces it
      // with the judge-facing permission / attempt / decision / effect views.
      const input = parseDemoInput(await readJson(request));
      const result = await runDemo(input);
      const statusCode = "httpStatus" in result ? result.httpStatus : result.status === "DENIED" ? 403 : 200;

      sendJson(response, statusCode, result);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof HttpInputError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

server.listen(port, () => {
  console.log(
    `Virtual Haibin agent listening on http://localhost:${port}; service agent: ${serviceAgentUrl}; authority: ${authorityUrl}`,
  );
});
