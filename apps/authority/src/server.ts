import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { validateAuthorizationRequest } from "@virtual-haibin/mandate";
import { AuthorityRequestError, type AuthorityService } from "./authorize.js";

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

class HttpInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
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
    throw new HttpInputError("Request body must be valid JSON.", 400);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpInputError("Request body must be valid JSON.", 400);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wire format of POST /authorize. `bearer` authenticates the transport
 * (dev-only shared secret); `agentSignature` over `authorizationRequest`
 * is what authenticates the caller as the permit's authorizedAgent.
 */
type AuthorizeRequestBody = {
  permit?: unknown;
  authorizationRequest?: unknown;
  agentSignature?: unknown;
};

export type AuthorityServerOptions = {
  authorityService: AuthorityService;
  authorityAddress: string;
  sharedSecret: string;
};

export function createAuthorityServer(options: AuthorityServerOptions): Server {
  const { authorityService, authorityAddress, sharedSecret } = options;

  function isAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;

    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return false;
    }

    const presented = Buffer.from(header.slice("Bearer ".length));
    const expected = Buffer.from(sharedSecret);

    return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
  }

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { service: "virtual-haibin-authority", status: "ok", authority: authorityAddress });
        return;
      }

      if (request.method === "POST" && request.url === "/authorize") {
        if (!isAuthorized(request)) {
          sendJson(response, 401, { error: "Unauthorized" });
          return;
        }

        const rawBody = await readJsonBody<unknown>(request);

        if (!isPlainObject(rawBody)) {
          throw new HttpInputError("Request body must be a JSON object.", 400);
        }

        const body = rawBody as AuthorizeRequestBody;

        if (body.permit === undefined) {
          throw new HttpInputError("permit is required.", 400);
        }

        const validation = validateAuthorizationRequest(body.authorizationRequest);

        if (!validation.valid) {
          throw new HttpInputError(validation.message, 400);
        }

        const result = await authorityService.authorize({
          permit: body.permit,
          authorizationRequest: validation.request,
          agentSignature: body.agentSignature,
        });

        sendJson(response, 200, {
          decision: result.receipt.decision,
          replay: result.replay,
          receipt: result.receipt,
        });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }

      if (error instanceof AuthorityRequestError) {
        sendJson(response, error.statusCode, { error: error.message, reasonCode: error.reasonCode, ...error.details });
        return;
      }

      // Internal error details stay in the server log, not the response.
      console.error(
        JSON.stringify({
          component: "authority",
          event: "authority.internal_error",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      sendJson(response, 500, { error: "Internal authority error.", reasonCode: "INTERNAL_ERROR" });
    }
  });
}
