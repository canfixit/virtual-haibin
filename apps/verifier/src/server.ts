import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { isAddress } from "@solana/addresses";
import {
  createRpcSettlementSource,
  MAX_BUNDLE_BYTES,
  verifyEvidenceBundle,
  type OnlineSettlementSource,
  type VerifierTrust,
} from "@virtual-haibin/evidence";
import { solanaPaymentSandboxProfile, SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL } from "@virtual-haibin/payments";

/**
 * HTTP front for the SAME standalone verifier library the CLI uses, so the
 * demo UI can show real verifier output. It holds no keys, has no database,
 * never contacts the authority (in Compose it is on its own network and
 * cannot even resolve it), and takes trust ONLY from its own pinned trust
 * files -- never from the bundle or the caller. Online mode queries only the
 * RPC in its own configuration.
 */
export type VerifierServerOptions = {
  issuerTrustFile: string;
  authorityTrustFile: string;
  serviceTrustFile?: string;
  rpcUrl?: string;
  allowedOrigin: string;
  rpcFactory?: (url: string) => OnlineSettlementSource;
};

function readKey(path: string): string | null {
  try {
    const key = readFileSync(path, "utf8").trim();
    return isAddress(key) ? key : null;
  } catch {
    return null;
  }
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  let total = 0;
  const chunks: Buffer[] = [];

  // Read to the end but keep at most MAX_BUNDLE_BYTES: an oversized body is
  // drained and discarded (bounded memory) so the connection stays sane.
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;

    if (total <= MAX_BUNDLE_BYTES) {
      chunks.push(buffer);
    }
  }

  return total > MAX_BUNDLE_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

export function createVerifierServer(options: VerifierServerOptions): Server {
  const profile = solanaPaymentSandboxProfile(options.rpcUrl ?? SOLANA_PAYMENT_SANDBOX_DEFAULT_RPC_URL);
  const rpcFactory = options.rpcFactory ?? ((url: string) => createRpcSettlementSource(url));

  return createServer(async (request, response) => {
    const send = (status: number, payload: unknown) => {
      if (request.headers.origin === options.allowedOrigin) {
        response.setHeader("access-control-allow-origin", options.allowedOrigin);
        response.setHeader("vary", "origin");
      }
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };

    try {
      const url = new URL(request.url ?? "/", "http://verifier");

      if (request.method === "OPTIONS") {
        if (request.headers.origin === options.allowedOrigin) {
          response.setHeader("access-control-allow-origin", options.allowedOrigin);
          response.setHeader("access-control-allow-headers", "content-type");
          response.setHeader("access-control-allow-methods", "POST");
        }
        response.writeHead(204).end();
        return;
      }

      // Pinned trust, re-read per request (files are published by their owners).
      const issuer = readKey(options.issuerTrustFile);
      const authority = readKey(options.authorityTrustFile);
      const service = options.serviceTrustFile === undefined ? null : readKey(options.serviceTrustFile);

      if (request.method === "GET" && url.pathname === "/health") {
        send(200, { service: "virtual-haibin-verifier", status: "ok", trust: { issuer, authority, service }, settlementRpc: profile.rpcUrl });
        return;
      }

      if (request.method === "POST" && url.pathname === "/verify") {
        if (issuer === null || authority === null) {
          send(503, { error: "Verifier trust roots are not configured." });
          return;
        }

        const body = await readBody(request);

        if (body === null) {
          response.setHeader("connection", "close");
          send(413, { error: `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes.` });
          return;
        }

        const trust: VerifierTrust = { issuer, authority, settlementProfiles: new Map([[profile.permitNetwork, profile]]), ...(service === null ? {} : { service }) };
        const online = url.searchParams.get("mode") === "online";
        const report = await verifyEvidenceBundle(body, trust, online ? { mode: "online", rpc: rpcFactory(profile.rpcUrl) } : { mode: "offline" });
        send(200, { report, trust: { issuer, authority, service } });
        return;
      }

      send(404, { error: "Not found" });
    } catch {
      send(500, { error: "Internal verifier error." });
    }
  });
}
