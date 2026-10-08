import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import { SessionStore, type Session } from "./sessions.js";

export type AgentServerOptions = {
  /** The agent's non-spending identity key (signs authorization requests only). */
  agentIdentity: CryptoKeyPair;
  agentAddress: string;
  serviceAgentUrl: string;
  authorityUrl: string;
  /** Transport secret for agent -> authority calls. Never sent to clients. */
  authoritySharedSecret: string;
  authorityAudience: string;
  /** Explicit development CORS origin (the demo web UI); never "*". */
  allowedOrigin: string;
  sessions?: SessionStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** Same canonical form as PurchasePermit amounts: integer string, no sign/decimal/leading zeros. */
const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;

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

type AuthorizeResponseBody = {
  decision: "ALLOW" | "DENY";
  replay: boolean;
  receipt: { reasonCodes: string[] } & Record<string, unknown>;
  payment: ({ transactionId: string | null } & Record<string, unknown>) | null;
  result: unknown;
};

class HttpInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly reasonCode?: string,
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
    throw new HttpInputError("quotedPrice (decimal number) is no longer supported; send amountAtomic as a canonical integer string.", 400);
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

/**
 * The agent's HTTP API. Everything except /health, /identity and
 * POST /session requires the caller's session capability
 * (`Authorization: Bearer <session token>`); see sessions.ts.
 */
export function createAgentServer(options: AgentServerOptions): Server {
  const sessions = options.sessions ?? new SessionStore(options.now ? { now: options.now } : {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const setCors = (response: ServerResponse) => {
    response.setHeader("access-control-allow-origin", options.allowedOrigin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-headers", "content-type, authorization");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  };

  const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
    setCors(response);
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(payload));
  };

  const requireSession = (request: IncomingMessage): Session => {
    const session = sessions.authenticate(request.headers.authorization);

    if (session === null) {
      throw new HttpInputError("A valid demo session is required (Authorization: Bearer <session token> from POST /session).", 401, "SESSION_REQUIRED");
    }

    return session;
  };

  async function installPermit(session: Session, candidate: unknown): Promise<SignedPurchasePermitV2> {
    const verification = await verifyPurchasePermitV2(candidate);

    if (!verification.verified) {
      throw new HttpInputError(`permit is not a valid signed PurchasePermit v2 (${verification.reasonCode}).`, 400);
    }

    if (verification.permit.authorizedAgent !== options.agentAddress) {
      throw new HttpInputError("permit is issued to a different agent identity.", 400);
    }

    session.installed = { permit: verification.permit, digest: await computePermitDigest(verification.permit) };
    return verification.permit;
  }

  async function runDemo(session: Session, input: DemoInput) {
    if (session.installed === null) {
      return { status: "NO_PERMIT", httpStatus: 409, invocationId: input.invocationId, message: "No human-approved permit is installed in this session." };
    }

    // Bind the invocation ID to this session BEFORE contacting anything. An
    // ID used by another session (live or ended) is refused outright.
    const claim = sessions.claimInvocation(session, input.invocationId);

    if (claim === "foreign") {
      throw new HttpInputError("invocationId is not available to this session.", 409, "INVOCATION_NOT_AVAILABLE");
    }

    if (claim === "limit") {
      throw new HttpInputError("This session has reached its invocation limit; start a new session.", 429, "SESSION_INVOCATION_LIMIT");
    }

    const { permit, digest } = session.installed;
    const quoteResponse = await fetchImpl(new URL("/quote", options.serviceAgentUrl));

    if (!quoteResponse.ok) {
      throw new Error(`Service quote failed with status ${quoteResponse.status}.`);
    }

    const quote = parseServiceQuote(await quoteResponse.json());

    // The operation the agent wants to buy: method/resource from the service's
    // quote, action/dataset from the agent's own task. Whether it is what the
    // human approved is decided by the authority, not here.
    const operationCheck = validateExactOperation({ method: quote.method, resource: quote.resource, operation: input.operation, datasetId: input.datasetId });

    if (!operationCheck.valid) {
      throw new HttpInputError(operationCheck.message, 400);
    }

    const operation: ExactOperationV1 = operationCheck.operation;

    if (input.scenario !== "honest") {
      const scenarioResponse = await fetchImpl(new URL("/__demo/scenario", options.serviceAgentUrl), {
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
      audience: options.authorityAudience,
      grantId: permit.grantId,
      permitDigest: digest,
      invocationId: input.invocationId,
      service: quote.service,
      capability: quote.capability,
      network: quote.network,
      mint: quote.mint,
      recipient: quote.recipient,
      amountAtomic: input.amountAtomic ?? quote.amountAtomic,
      issuedAt: now(),
      operation,
    };
    const agentSignature = await signAuthorizationRequest(authorizationRequest, options.agentIdentity);

    const authorizeResponse = await fetchImpl(`${options.authorityUrl}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.authoritySharedSecret}` },
      body: JSON.stringify({ permit, authorizationRequest, agentSignature }),
    });

    if ([401, 403, 409, 502].includes(authorizeResponse.status)) {
      const refusal = (await authorizeResponse.json()) as { reasonCode?: string };

      // The authority only reports reconciliation for a request whose
      // fingerprint (incl. permit) matches the recorded one: it is this
      // session's own invocation, so its (RECONCILIATION_REQUIRED) evidence may be read.
      if (refusal.reasonCode === "RECONCILIATION_REQUIRED") {
        sessions.markDecided(session, input.invocationId);
      }

      return {
        // e.g. ISSUER_NOT_ENTITLED, INVOCATION_CONFLICT, RECONCILIATION_REQUIRED, AGENT_SIGNATURE_INVALID
        status: refusal.reasonCode ?? "REFUSED",
        httpStatus: authorizeResponse.status,
        invocationId: input.invocationId,
        operation,
        quote,
        authority: refusal,
        audit: session.audit.list(),
      };
    }

    if (!authorizeResponse.ok) {
      throw new Error(`Authority request failed with status ${authorizeResponse.status}.`);
    }

    const authorization = (await authorizeResponse.json()) as AuthorizeResponseBody;
    sessions.markDecided(session, input.invocationId);

    session.audit.append({
      type: "authority.decision",
      actor: permit.authorizedAgent,
      mandateId: permit.grantId,
      data: { decision: authorization.decision, reasonCodes: authorization.receipt.reasonCodes, invocationId: input.invocationId, replay: authorization.replay },
    });

    if (authorization.decision !== "ALLOW") {
      return { status: "DENIED", invocationId: input.invocationId, operation, quote, authorization, audit: session.audit.list() };
    }

    // The authority performed the paid HTTP call (402 -> validated payment ->
    // retry with proof) and returns the protected result; the agent never
    // holds a payment key or payment credential.
    session.audit.append({
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
      result: authorization.result,
      audit: session.audit.list(),
    };
  }

  return createServer(async (request, response) => {
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
        sendJson(response, 200, { agent: options.agentAddress });
        return;
      }

      if (request.method === "POST" && request.url === "/session") {
        // The capability is returned once, in the body; never in a URL, never logged.
        const { token, session } = sessions.create();
        sendJson(response, 201, { token, expiresAt: session.expiresAt });
        return;
      }

      if (request.method === "GET" && request.url === "/permit") {
        const session = requireSession(request);
        sendJson(response, session.installed === null ? 404 : 200, { permit: session.installed?.permit ?? null });
        return;
      }

      if (request.method === "POST" && request.url === "/permit") {
        // Receives a permit the human approved elsewhere, into THIS session only.
        // Nothing here can create or widen one: any change breaks the issuer's signature.
        const session = requireSession(request);
        const body = await readJson(request);
        const permit = await installPermit(session, isPlainObject(body) ? body.permit : undefined);
        session.audit.append({
          type: "permit.installed",
          actor: options.agentAddress,
          mandateId: permit.grantId,
          data: { issuer: permit.issuer, operation: permit.operation.operation, datasetId: permit.operation.datasetId },
        });
        sendJson(response, 200, { installed: true, grantId: permit.grantId, issuer: permit.issuer, operation: permit.operation });
        return;
      }

      // UI relay for the portable evidence of one of THIS session's decided
      // invocations. The browser must not hold the authority's bearer secret,
      // so the agent fetches the bundle for it. Unknown or foreign IDs are
      // refused here, before the authority is contacted.
      if (request.method === "GET" && request.url?.startsWith("/evidence/")) {
        const session = requireSession(request);
        let invocationId: string;

        try {
          invocationId = decodeURIComponent(request.url.slice("/evidence/".length));
        } catch {
          throw new HttpInputError("Malformed invocationId.", 400);
        }

        if (!INVOCATION_ID_PATTERN.test(invocationId)) {
          throw new HttpInputError("invocationId must be 1-128 characters of [A-Za-z0-9_.:-].", 400);
        }

        // Same answer for unknown and foreign IDs: nothing about other sessions leaks.
        if (!sessions.canReadEvidence(session, invocationId)) {
          throw new HttpInputError("No evidence for this invocation in this session.", 404, "EVIDENCE_NOT_AVAILABLE");
        }

        const upstream = await fetchImpl(`${options.authorityUrl}/evidence/${encodeURIComponent(invocationId)}`, {
          headers: { authorization: `Bearer ${options.authoritySharedSecret}` },
          signal: AbortSignal.timeout(15_000),
        });
        const text = await upstream.text();

        if (text.length > MAX_EVIDENCE_BYTES) {
          throw new Error("Evidence bundle exceeds the size limit.");
        }

        setCors(response);
        response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(text);
        return;
      }

      if (request.method === "POST" && request.url === "/demo") {
        // Demo entry point for the judge UI and scripts, scoped to the caller's session.
        const session = requireSession(request);
        const input = parseDemoInput(await readJson(request));
        const result = await runDemo(session, input);
        const statusCode = "httpStatus" in result ? result.httpStatus : result.status === "DENIED" ? 403 : 200;

        sendJson(response, statusCode, result);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendJson(response, error.statusCode, { error: error.message, ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}) });
        return;
      }

      // Internal details stay out of responses (they could include upstream text).
      sendJson(response, 500, { error: "Internal agent error." });
    }
  });
}
