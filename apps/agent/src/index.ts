import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { InMemoryAuditLog } from "@virtual-haibin/audit";
import {
  AUTHORIZATION_REQUEST_PROTOCOL,
  AUTHORIZATION_REQUEST_VERSION_2,
  computePermitDigest,
  signAuthorizationRequest,
  validateExactOperation,
  verifyPurchasePermitV2,
  type AuthorizationRequestV2,
  type ExactOperationV1,
  type SignedPurchasePermitV2,
} from "@virtual-haibin/mandate";

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

const authorityAudience = requireEnv("AUTHORITY_AUDIENCE");

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
// boundary (apps/approver) and only *installed* here (POST /permit).
const agentIdentity = await generateKeyPair();
const agentIdentityAddress = await getAddressFromPublicKey(agentIdentity.publicKey);

const auditLog = new InMemoryAuditLog();

/** Same canonical form as PurchasePermit amounts: integer string, no sign/decimal/leading zeros. */
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The permit the human approved for this agent, as received. The agent
 * checks only that it is a well-formed, correctly signed v2 permit addressed
 * to its own identity -- whether the issuer is *trusted* is the authority's
 * decision, never the agent's.
 */
let installed: { permit: SignedPurchasePermitV2; digest: string } | null = null;

async function installPermit(candidate: unknown): Promise<SignedPurchasePermitV2> {
  const verification = await verifyPurchasePermitV2(candidate);

  if (!verification.verified) {
    throw new HttpInputError(`permit is not a valid signed PurchasePermit v2 (${verification.reasonCode}).`, 400);
  }

  if (verification.permit.authorizedAgent !== agentIdentityAddress) {
    throw new HttpInputError("permit is issued to a different agent identity.", 400);
  }

  installed = { permit: verification.permit, digest: await computePermitDigest(verification.permit) };
  return verification.permit;
}

/**
 * DEMO FAULT INJECTION for the mock merchant. "honest" pays normally; the
 * others make the merchant's *real* 402 challenge differ from its advertised
 * quote (price, recipient or asset) so the authority's validation is visible.
 */
const DEMO_SCENARIOS = ["honest", "overcharge", "wrong-recipient", "wrong-asset", "lost-response", "drop-credential"] as const;
type DemoScenario = (typeof DEMO_SCENARIOS)[number];

type DemoInput = {
  /** Optional override of the amount the agent signs (defaults to the quoted amount). */
  amountAtomic: string | null;
  invocationId: string;
  scenario: DemoScenario;
  /** The business operation the agent decides to buy (may or may not be what the human approved). */
  operation: string;
  datasetId: string;
};

/** The authoritative fields of a service quote; forwarded verbatim to the authority. */
type ServiceQuote = {
  quoteId: string;
  service: string;
  capability: string;
  method: string;
  resource: string;
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

  for (const field of ["quoteId", "service", "capability", "method", "resource", "network", "mint", "recipient", "amountAtomic"] as const) {
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

  const amountAtomic = body.amountAtomic ?? null;

  if (amountAtomic !== null && (typeof amountAtomic !== "string" || !ATOMIC_AMOUNT_PATTERN.test(amountAtomic))) {
    throw new HttpInputError("amountAtomic must be a canonical non-negative integer string.", 400);
  }

  const invocationId = body.invocationId ?? crypto.randomUUID();

  if (typeof invocationId !== "string" || !INVOCATION_ID_PATTERN.test(invocationId)) {
    throw new HttpInputError("invocationId must be 1-128 characters of [A-Za-z0-9_.:-].", 400);
  }

  const scenario = body.scenario ?? "honest";

  if (typeof scenario !== "string" || !(DEMO_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new HttpInputError(`scenario must be one of: ${DEMO_SCENARIOS.join(", ")}.`, 400);
  }

  const operation = body.operation ?? "summarize";
  const datasetId = body.datasetId ?? "dataset-a";

  if (typeof operation !== "string" || typeof datasetId !== "string") {
    throw new HttpInputError("operation and datasetId must be strings.", 400);
  }

  return { amountAtomic, invocationId, scenario: scenario as DemoScenario, operation, datasetId };
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
  payment: { transactionId: string | null } & Record<string, unknown> | null;
  result: unknown;
};

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("vary", "origin");
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
  if (installed === null) {
    return { status: "NO_PERMIT", httpStatus: 409, invocationId: input.invocationId, message: "No human-approved permit is installed." };
  }

  const { permit, digest } = installed;
  const quoteResponse = await fetch(new URL("/quote", serviceAgentUrl));

  if (!quoteResponse.ok) {
    throw new Error(`Service quote failed with status ${quoteResponse.status}.`);
  }

  const quote = parseServiceQuote(await quoteResponse.json());

  // The operation the agent wants to buy: method/resource from the service's
  // quote, action/dataset from the agent's own task. Whether it is what the
  // human approved is decided by the authority, not here.
  const operationCheck = validateExactOperation({
    method: quote.method,
    resource: quote.resource,
    operation: input.operation,
    datasetId: input.datasetId,
  });

  if (!operationCheck.valid) {
    throw new HttpInputError(operationCheck.message, 400);
  }

  const operation: ExactOperationV1 = operationCheck.operation;

  if (input.scenario !== "honest") {
    const scenarioResponse = await fetch(new URL("/__demo/scenario", serviceAgentUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invocationId: input.invocationId, scenario: input.scenario }),
    });

    if (!scenarioResponse.ok) {
      throw new Error(`Demo scenario setup failed with status ${scenarioResponse.status}.`);
    }
  }

  // Forward the quote's authoritative fields verbatim. The agent does not
  // substitute values from the permit: the authority must see what the
  // service actually asked to be paid. The whole request is signed with the
  // agent identity key and bound to this exact permit and authority.
  const authorizationRequest: AuthorizationRequestV2 = {
    protocol: AUTHORIZATION_REQUEST_PROTOCOL,
    version: AUTHORIZATION_REQUEST_VERSION_2,
    audience: authorityAudience,
    grantId: permit.grantId,
    permitDigest: digest,
    invocationId: input.invocationId,
    service: quote.service,
    capability: quote.capability,
    network: quote.network,
    mint: quote.mint,
    recipient: quote.recipient,
    amountAtomic: input.amountAtomic ?? quote.amountAtomic,
    issuedAt: Date.now(),
    operation,
  };
  const agentSignature = await signAuthorizationRequest(authorizationRequest, agentIdentity);

  const authorizeResponse = await fetch(`${authorityUrl}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authoritySharedSecret}`,
    },
    body: JSON.stringify({ permit, authorizationRequest, agentSignature }),
  });

  if ([401, 403, 409, 502].includes(authorizeResponse.status)) {
    const refusal = (await authorizeResponse.json()) as { reasonCode?: string };
    return {
      // e.g. ISSUER_NOT_ENTITLED, INVOCATION_CONFLICT, RECONCILIATION_REQUIRED, AGENT_SIGNATURE_INVALID
      status: refusal.reasonCode ?? "REFUSED",
      httpStatus: authorizeResponse.status,
      invocationId: input.invocationId,
      operation,
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
    actor: permit.authorizedAgent,
    mandateId: permit.grantId,
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
      operation,
      quote,
      authorization,
      audit: auditLog.list(),
    };
  }

  // The authority performed the paid HTTP call (402 -> validated payment ->
  // retry with proof) and returns the protected result; the agent never
  // holds a payment key or payment credential.
  const result = authorization.result;

  auditLog.append({
    type: "service.completed",
    actor: permit.authorizedAgent,
    mandateId: permit.grantId,
    data: { service: quote.service, transactionId: authorization.payment?.transactionId ?? null },
  });

  return {
    status: authorization.replay ? "REPLAYED" : "COMPLETED",
    invocationId: input.invocationId,
    operation,
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

    if (request.method === "GET" && request.url === "/identity") {
      // Public key only: what the human approves a permit *for*.
      sendJson(response, 200, { agent: agentIdentityAddress });
      return;
    }

    if (request.method === "GET" && request.url === "/permit") {
      sendJson(response, installed === null ? 404 : 200, { permit: installed?.permit ?? null });
      return;
    }

    if (request.method === "POST" && request.url === "/permit") {
      // Receives a permit the human approved elsewhere. Nothing here can
      // create or widen one: any change breaks the issuer's signature.
      const body = await readJson(request);
      const permit = await installPermit(isPlainObject(body) ? body.permit : undefined);
      auditLog.append({
        type: "permit.installed",
        actor: agentIdentityAddress,
        mandateId: permit.grantId,
        data: { issuer: permit.issuer, operation: permit.operation.operation, datasetId: permit.operation.datasetId },
      });
      sendJson(response, 200, { installed: true, grantId: permit.grantId, issuer: permit.issuer, operation: permit.operation });
      return;
    }

    // UI relay for the portable evidence of one invocation. The browser must
    // not hold the authority's bearer secret, so the agent fetches the bundle
    // for it. Relaying is safe: the bundle is checked by signatures against
    // pinned keys, never trusted because of who delivered it.
    if (request.method === "GET" && request.url?.startsWith("/evidence/")) {
      const invocationId = decodeURIComponent(request.url.slice("/evidence/".length));

      if (!INVOCATION_ID_PATTERN.test(invocationId)) {
        throw new HttpInputError("invocationId must be 1-128 characters of [A-Za-z0-9_.:-].", 400);
      }

      const upstream = await fetch(`${authorityUrl}/evidence/${encodeURIComponent(invocationId)}`, {
        headers: { authorization: `Bearer ${authoritySharedSecret}` },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await upstream.text();

      if (text.length > 512 * 1024) {
        throw new Error("Evidence bundle exceeds the size limit.");
      }

      setCors(response);
      response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
      response.end(text);
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
