import type { RpcTransaction } from "@virtual-haibin/payments";
import type { OnlineSettlementSource } from "./verify.js";

const MAX_RPC_RESPONSE_BYTES = 256 * 1024;

/**
 * JSON-RPC client for the settlement RPC named in the VERIFIER's own
 * configuration. A bundle can never supply or influence this URL. Read-only
 * (`getVersion`, `getTransaction`), redirects refused, bounded responses.
 */
export function createRpcSettlementSource(rpcUrl: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): OnlineSettlementSource {
  const url = new URL(rpcUrl);

  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Settlement RPC URL must be http(s) without embedded credentials.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`RPC ${method} returned HTTP ${response.status}`);
    }

    const text = await response.text();

    if (text.length > MAX_RPC_RESPONSE_BYTES) {
      throw new Error(`RPC ${method} response too large`);
    }

    const body = JSON.parse(text) as { result?: T; error?: { message?: string } };

    if (body.error) {
      throw new Error(`RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
    }

    return body.result as T;
  }

  return {
    getVersion: () => call<Record<string, unknown>>("getVersion", []),
    getTransaction: (signature) =>
      call<RpcTransaction | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]),
  };
}
