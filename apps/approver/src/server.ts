import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { issuePermit, parseApprovalRequest, type ApprovalTerms } from "./approve.js";
import type { IssuerKey } from "./issuer-key.js";

const MAX_BODY_BYTES = 4 * 1024;

export type ApproverLogEntry = { event: string } & Record<string, unknown>;

export type ApproverServerOptions = {
  issuer: IssuerKey;
  /** Human-held approval code; every approval must present it as a bearer token. */
  approvalCode: string;
  terms: ApprovalTerms;
  /** The one browser origin (the demo web UI) allowed to call this service cross-origin. */
  allowedOrigin: string;
  log?: (entry: ApproverLogEntry) => void;
  now?: () => number;
  newGrantId?: () => string;
};

class HttpInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpInputError("Request body must be valid JSON.", 400);
  }
}

/**
 * The human-approval boundary's HTTP surface (demo-grade):
 *
 *   GET  /health     -> status + the issuer PUBLIC key
 *   POST /approvals  -> {agent, operation, datasetId} -> signed PurchasePermit v2
 *                       (requires `Authorization: Bearer <approval code>`)
 *
 * It never returns, logs or accepts key material, and it has no endpoint
 * that signs caller-supplied bytes: the permit is built here from the fixed
 * approval terms plus the three fields the human chooses.
 *
 * Who may approve: the holder of the approval code, which lives only in the
 * approver's private volume and is read by the human. Network placement is
 * defense in depth only -- the approver is on its own Docker network and
 * published on host loopback, but on Docker Desktop other containers can
 * still route to that port via host.docker.internal. CORS below only stops
 * *other web origins* in a browser; it is not authentication.
 */
export function createApproverServer(options: ApproverServerOptions): Server {
  const { issuer, terms, allowedOrigin } = options;
  const expectedCode = Buffer.from(options.approvalCode, "utf8");

  function presentsApprovalCode(request: IncomingMessage): boolean {
    const header = request.headers.authorization;

    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return false;
    }

    const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
    return presented.byteLength === expectedCode.byteLength && timingSafeEqual(presented, expectedCode);
  }
  const log = options.log ?? ((entry: ApproverLogEntry) => console.log(JSON.stringify({ component: "approver", ...entry })));
  const now = options.now ?? Date.now;
  const newGrantId = options.newGrantId ?? (() => `VH-GRANT-${crypto.randomUUID()}`);

  function sendJson(request: IncomingMessage, response: ServerResponse, statusCode: number, payload: unknown): void {
    if (request.headers.origin === allowedOrigin) {
      response.setHeader("access-control-allow-origin", allowedOrigin);
      response.setHeader("vary", "origin");
    }

    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  return createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        if (request.headers.origin === allowedOrigin) {
          response.setHeader("access-control-allow-origin", allowedOrigin);
          response.setHeader("access-control-allow-headers", "content-type, authorization");
          response.setHeader("access-control-allow-methods", "POST");
          response.setHeader("vary", "origin");
        }

        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        sendJson(request, response, 200, { service: "virtual-haibin-approver", status: "ok", issuer: issuer.address, terms });
        return;
      }

      if (request.method === "POST" && request.url === "/approvals") {
        if (!presentsApprovalCode(request)) {
          // Never log the presented value.
          log({ event: "approver.approval_rejected", reasonCode: "APPROVAL_CODE_REQUIRED" });
          sendJson(request, response, 401, { error: "A valid human approval code is required.", reasonCode: "APPROVAL_CODE_REQUIRED" });
          return;
        }

        const parsed = parseApprovalRequest(await readJsonBody(request), terms);

        if (!parsed.valid) {
          throw new HttpInputError(parsed.message, 400);
        }

        const permit = await issuePermit(parsed.approval, terms, issuer, { now: now(), grantId: newGrantId() });

        // The human action, recorded by identifier only.
        log({
          event: "approver.permit_issued",
          grantId: permit.grantId,
          issuer: permit.issuer,
          authorizedAgent: permit.authorizedAgent,
          operation: permit.operation.operation,
          datasetId: permit.operation.datasetId,
          maxPerCallAtomic: permit.maxPerCallAtomic,
          maxTotalAtomic: permit.maxTotalAtomic,
          expiresAt: permit.expiresAt,
        });

        sendJson(request, response, 201, { permit });
        return;
      }

      sendJson(request, response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendJson(request, response, error.statusCode, { error: error.message });
        return;
      }

      log({ event: "approver.internal_error", error: error instanceof Error ? error.message : "unknown" });
      sendJson(request, response, 500, { error: "Internal approver error." });
    }
  });
}
