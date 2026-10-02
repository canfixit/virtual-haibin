import { createHash, randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  checkServiceAuthorization,
  encodeServiceHeader,
  SERVICE_ACKNOWLEDGEMENT_DOMAIN,
  SERVICE_ACKNOWLEDGEMENT_HEADER,
  SERVICE_AUTHORIZATION_HEADER,
  signServiceAcknowledgement,
} from "@virtual-haibin/evidence";
import { CAPABILITY, DATASETS, OPERATIONS, parseReportRequest, REPORT_RESOURCE, runReport, SERVICE_ID, type ReportRequest } from "./report.js";

export const SCENARIOS = ["honest", "overcharge", "wrong-recipient", "wrong-asset", "lost-response", "drop-credential"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type ServiceAppOptions = {
  /** Pay Kit (or test) payment gate per demo scenario. Settles a paid request, 402s an unpaid one. */
  gates: Record<Scenario, RequestHandler>;
  /** The settled payment for a request that passed its gate. */
  paymentOf: (request: Request) => { protocol: string | null; transaction: string | null } | null;
  /** This service's signing identity (persistent; its PUBLIC key is pinned by verifiers and the authority). */
  serviceKey: { keyPair: CryptoKeyPair; address: string };
  /**
   * The pinned Virtual Haibin authority public key. Read lazily (the
   * authority starts after this service); null means not yet available.
   */
  authorityKey: () => string | null;
  /** The honest price for the report: what any accepted authorization must name. */
  price: { network: string; asset: string; payTo: string; amountAtomic: string };
  feePayer: string;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
};

type RawRequest = Request & { rawBody?: Buffer };

/**
 * The paid dataset-report service. On a PAID request (one carrying a payment
 * credential), the Virtual Haibin service authorization is verified FIRST --
 * against the pinned authority key, for exactly the received request bytes,
 * invocation and this service's price -- and anything else is refused before
 * the payment gate can settle. After fulfillment the service signs an
 * acknowledgement of exactly what it received, was paid and returned.
 */
export function createServiceApp(options: ServiceAppOptions) {
  const log = options.log ?? ((entry) => console.log(JSON.stringify({ component: "service-agent", ...entry })));
  const now = options.now ?? Date.now;
  const scenarios = new Map<string, Scenario>();
  const MAX_SCENARIOS = 1000;
  const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
  const scenarioFor = (request: Request): Scenario => {
    const invocationId = request.get("x-vh-invocation-id");
    return (invocationId && scenarios.get(invocationId)) || "honest";
  };

  const app = express();
  app.disable("x-powered-by");
  // Keep the exact body bytes: the authorization binds their digest.
  app.use(express.json({ limit: "4kb", verify: (request, _response, buffer) => void ((request as RawRequest).rawBody = Buffer.from(buffer)) }));

  app.get("/health", (_request, response) => {
    response.json({ service: SERVICE_ID, status: "ok", feePayer: options.feePayer, recipient: options.price.payTo, serviceKey: options.serviceKey.address });
  });

  // Advertised (honest) terms the agent signs. Identical for every operation.
  app.get("/quote", (_request, response) => {
    response.json({
      quoteId: randomBytes(8).toString("hex"),
      service: SERVICE_ID,
      capability: CAPABILITY,
      method: "POST",
      resource: REPORT_RESOURCE,
      operations: OPERATIONS,
      network: options.price.network,
      mint: options.price.asset,
      recipient: options.price.payTo,
      amountAtomic: options.price.amountAtomic,
      display: { tokenLabel: "sandbox USDC (no real value)", decimals: 6, note: "same price for every operation" },
    });
  });

  app.post("/__demo/scenario", (request, response) => {
    const { invocationId, scenario } = (request.body ?? {}) as { invocationId?: unknown; scenario?: unknown };

    if (typeof invocationId !== "string" || !INVOCATION_ID_PATTERN.test(invocationId) || typeof scenario !== "string" || !(SCENARIOS as readonly string[]).includes(scenario)) {
      response.status(400).json({ error: "invocationId and a known scenario are required." });
      return;
    }

    if (scenarios.size >= MAX_SCENARIOS) {
      const oldest = scenarios.keys().next().value;
      if (oldest !== undefined) scenarios.delete(oldest);
    }

    scenarios.set(invocationId, scenario as Scenario);
    response.json({ ok: true, invocationId, scenario });
  });

  app.post(
    REPORT_RESOURCE,
    // 1. Strict body: a malformed request is a 400, never a priced 402.
    (request: Request, response: Response, next: NextFunction) => {
      const report = parseReportRequest(request.body);

      if (report === null) {
        response.status(400).json({ error: `Body must be exactly {operation: ${OPERATIONS.join("|")}, datasetId: ${Object.keys(DATASETS).join("|")}}.` });
        return;
      }

      response.locals.report = report;
      next();
    },
    // 2. PAID request: Virtual Haibin authorization BEFORE the payment gate.
    async (request: Request, response: Response, next: NextFunction) => {
      if (!request.get("payment-signature")) {
        next(); // Unpaid probe: the gate answers 402 with the public challenge.
        return;
      }

      const authorityKey = options.authorityKey();

      if (authorityKey === null) {
        log({ event: "service.authorization_rejected", reasonCode: "SERVICE_AUTHORIZATION_UNAVAILABLE" });
        response.status(503).json({ error: "Authority trust root not available.", reasonCode: "SERVICE_AUTHORIZATION_UNAVAILABLE" });
        return;
      }

      const check = await checkServiceAuthorization({
        header: request.get(SERVICE_AUTHORIZATION_HEADER),
        pinnedAuthority: authorityKey,
        method: request.method,
        path: request.path,
        rawBody: (request as RawRequest).rawBody ?? new Uint8Array(),
        invocationIdHeader: request.get("x-vh-invocation-id"),
        expectedPayment: { asset: options.price.asset, payTo: options.price.payTo, amountAtomic: options.price.amountAtomic },
        now: now(),
      });

      if (!check.ok) {
        // Refused BEFORE the gate: the credential is never settled.
        log({ event: "service.authorization_rejected", reasonCode: check.reasonCode, invocationId: request.get("x-vh-invocation-id") ?? null });
        response.status(403).json({ error: check.message, reasonCode: check.reasonCode });
        return;
      }

      response.locals.authorization = check;
      next();
    },
    // 3. Payment gate (Pay Kit x402 exact): settles only now.
    (request: Request, response: Response, next: NextFunction) => {
      const scenario = scenarioFor(request);

      if (scenario === "drop-credential" && request.get("payment-signature")) {
        request.socket.destroy();
        return;
      }

      options.gates[scenario](request, response, next);
    },
    // 4. Fulfil and acknowledge.
    async (request: Request, response: Response) => {
      if (scenarioFor(request) === "lost-response") {
        // Payment already settled by the gate; the result never reaches the caller.
        request.socket.destroy();
        return;
      }

      const payment = options.paymentOf(request);
      const report = response.locals.report as ReportRequest;
      const authorization = response.locals.authorization as { requestSha256: string; authorizationDigest: string; authorization: { invocationId: string } } | undefined;
      const body = JSON.stringify({
        service: SERVICE_ID,
        capability: CAPABILITY,
        // Echo of exactly what this service received and performed.
        received: { method: request.method, resource: REPORT_RESOURCE, operation: report.operation, datasetId: report.datasetId },
        result: runReport(report),
        paidWith: { protocol: payment?.protocol ?? null, transaction: payment?.transaction ?? null },
      });
      const bytes = Buffer.from(body, "utf8");

      if (authorization !== undefined) {
        const acknowledgement = await signServiceAcknowledgement(
          {
            version: 1,
            domain: SERVICE_ACKNOWLEDGEMENT_DOMAIN,
            service: options.serviceKey.address,
            invocationId: authorization.authorization.invocationId,
            authorizationDigest: authorization.authorizationDigest,
            requestSha256: authorization.requestSha256,
            received: { method: request.method, resource: REPORT_RESOURCE, operation: report.operation, datasetId: report.datasetId },
            payment: { transaction: payment?.transaction ?? null, asset: options.price.asset, payTo: options.price.payTo, amountAtomic: options.price.amountAtomic },
            result: { httpStatus: 200, contentType: "application/json", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength },
            fulfilledAt: now(),
          },
          options.serviceKey.keyPair,
        );
        response.setHeader(SERVICE_ACKNOWLEDGEMENT_HEADER, encodeServiceHeader(acknowledgement));
      }

      log({
        event: "service.fulfilled",
        invocationId: request.get("x-vh-invocation-id") ?? null,
        operation: report.operation,
        datasetId: report.datasetId,
        transaction: payment?.transaction ?? null,
        acknowledged: authorization !== undefined,
      });
      // Exact bytes (the acknowledgement signs their SHA-256).
      response.status(200).type("application/json").send(bytes);
    },
  );

  return app;
}
