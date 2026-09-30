import { createHash } from "node:crypto";
import { generateKeyPairSigner, type TransactionPartialSigner } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { SettlementProfile } from "./settlement-profile.js";
import { associatedTokenAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, validateExactPaymentTransaction } from "./transaction-validator.js";
import {
  PaidServiceUnavailableError,
  PaymentNotSubmittedError,
  PaymentOutcomeUnknownError,
  type ChallengeResult,
  type ConfirmedSettlement,
  type ExecuteInput,
  type PaidResource,
  type PaidResult,
  type PaymentAttempt,
  type PaymentChallenge,
  type PaymentExecution,
  type PaymentProvider,
  type PaymentRequirement,
  type SettlementLookup,
} from "./types.js";

/**
 * x402 `exact` (fixed one-time payment) provider on a trusted Solana
 * settlement profile.
 *
 * Uses the maintained protocol implementation -- `@x402/core` for challenge
 * parsing / credential encoding and `@x402/svm`'s `ExactSvmScheme` for the
 * Solana transfer -- the same pieces `@solana/pay-kit`'s own client uses. It
 * deliberately does not use `PayKitClient.fetch`, which would re-fetch and
 * auto-pay whatever challenge arrives under its own permission policy:
 * here the authority validates one parsed requirement and this provider
 * signs exactly that one.
 *
 * The payment wallet key lives only inside this object (non-extractable
 * WebCrypto key via `generateKeyPairSigner`). Nothing here returns or logs it.
 */

const CANONICAL_AMOUNT = /^(0|[1-9][0-9]{0,19})$/;
const MAX_U64 = 18446744073709551615n;
const MAX_ACCEPTS = 16;
const MAX_CHALLENGE_BODY_BYTES = 64 * 1024;

export type X402ExactPaymentProviderOptions = {
  profile: SettlementProfile;
  /** Payment wallet signer. Defaults to a freshly generated ephemeral key. */
  signer?: TransactionPartialSigner;
  fetchImpl?: typeof fetch;
  httpTimeoutMs?: number;
  rpcTimeoutMs?: number;
  /** Largest paid-response body kept as parsed JSON. */
  maxResultBytes?: number;
  /** How long to wait for the settled transaction to become visible via the pinned RPC. */
  confirmationWaitMs?: number;
  /** Extra blocks past lastValidBlockHeight before a missing transaction counts as expired. */
  expiryMarginBlocks?: number;
};

type RpcTransaction = {
  slot?: number;
  meta?: { err: unknown } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      recentBlockhash?: string;
      instructions?: Array<{ program?: string; programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } }>;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class X402ExactPaymentProvider implements PaymentProvider {
  readonly settlementProfile: string;
  readonly #profile: SettlementProfile;
  readonly #signer: TransactionPartialSigner;
  readonly #fetch: typeof fetch;
  readonly #http: x402HTTPClient;
  readonly #httpTimeoutMs: number;
  readonly #rpcTimeoutMs: number;
  readonly #maxResultBytes: number;
  readonly #confirmationWaitMs: number;
  readonly #expiryMarginBlocks: bigint;

  private constructor(options: X402ExactPaymentProviderOptions, signer: TransactionPartialSigner) {
    this.#profile = options.profile;
    this.settlementProfile = options.profile.name;
    this.#signer = signer;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#httpTimeoutMs = options.httpTimeoutMs ?? 20_000;
    this.#rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
    this.#maxResultBytes = options.maxResultBytes ?? 16 * 1024;
    this.#confirmationWaitMs = options.confirmationWaitMs ?? 10_000;
    this.#expiryMarginBlocks = BigInt(options.expiryMarginBlocks ?? 20);

    // Spend controls are disabled because the *authority* is the policy
    // engine; the scheme is pinned to the profile RPC so it never derives an
    // RPC from the (untrusted) challenge network.
    const client = new x402Client();
    client.setSpendControls(false);
    client.register("solana:*" as Network, new ExactSvmScheme(signer, { rpcUrl: this.#profile.rpcUrl }));
    this.#http = new x402HTTPClient(client);
  }

  static async create(options: X402ExactPaymentProviderOptions): Promise<X402ExactPaymentProvider> {
    return new X402ExactPaymentProvider(options, options.signer ?? (await generateKeyPairSigner()));
  }

  get payerAddress(): string {
    return this.#signer.address;
  }

  /**
   * Refuses to operate unless the pinned RPC identifies as the Surfnet
   * sandbox and issues sandbox-only blockhashes.
   */
  async assertSandboxEnvironment(): Promise<{ surfnetVersion: string }> {
    const version = await this.#rpc<Record<string, unknown>>("getVersion", []);
    const surfnetVersion = version["surfnet-version"];

    if (typeof surfnetVersion !== "string") {
      throw new Error("Pinned RPC does not identify as the Solana Payment Sandbox (no surfnet-version).");
    }

    await this.#freshBlockhash();
    return { surfnetVersion };
  }

  /** Funds the payment wallet with sandbox tokens via Surfnet cheatcodes (sandbox profile only). */
  async fundSandboxWallet(mint: string, amountAtomic: bigint): Promise<void> {
    if (this.#profile.environment !== "sandbox") {
      throw new Error("Cheatcode funding is only permitted on the sandbox profile.");
    }

    await this.#rpc("surfnet_setTokenAccount", [
      this.#signer.address,
      mint,
      { amount: Number(amountAtomic), state: "initialized" },
      TOKEN_PROGRAM,
    ]);
  }

  async fetchChallenge(resource: PaidResource, context: { reference: string }): Promise<ChallengeResult> {
    let response: Response;

    try {
      response = await this.#fetch(resource.url, {
        method: resource.method,
        redirect: "manual",
        headers: { accept: "application/json", "x-vh-invocation-id": context.reference },
        signal: AbortSignal.timeout(this.#httpTimeoutMs),
      });
    } catch (error) {
      throw new PaidServiceUnavailableError(`Paid service unreachable: ${error instanceof Error ? error.message : "unknown"}`);
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { kind: "rejected", reasonCode: "CHALLENGE_REDIRECT", message: "Paid service answered with a redirect; redirects are never followed." };
    }

    if (response.status >= 500) {
      await response.body?.cancel();
      throw new PaidServiceUnavailableError(`Paid service returned HTTP ${response.status}.`);
    }

    if (response.status !== 402) {
      await response.body?.cancel();
      return {
        kind: "rejected",
        reasonCode: "CHALLENGE_NOT_PAYMENT_REQUIRED",
        message: `Paid service returned HTTP ${response.status} instead of 402.`,
      };
    }

    // Bounded read; v2 challenges travel in the header, but drain the body safely.
    await readBounded(response, MAX_CHALLENGE_BODY_BYTES).catch(() => null);

    let decoded: unknown;

    try {
      decoded = this.#http.getPaymentRequiredResponse((name) => response.headers.get(name));
    } catch {
      return { kind: "rejected", reasonCode: "CHALLENGE_MALFORMED", message: "402 response has no parsable x402 PAYMENT-REQUIRED challenge." };
    }

    return normalizeChallenge(decoded);
  }

  async execute(input: ExecuteInput): Promise<PaymentExecution> {
    const { resource, challenge, requirement, reference } = input;
    let payload: PaymentPayload;
    let attempt: PaymentAttempt;

    // ---- Before transmission: any failure here provably sent nothing. ----
    try {
      const raw = challenge.raw as PaymentRequired;
      const original = raw.accepts[requirement.acceptsIndex];

      if (!original || original.payTo !== requirement.payTo || original.amount !== requirement.amountAtomic || original.asset !== requirement.asset) {
        throw new Error("Selected requirement does not match the parsed challenge.");
      }

      if (requirement.feePayer === null || requirement.feePayer === this.#signer.address) {
        throw new Error("Challenge fee payer is missing or is the payment wallet itself.");
      }

      // Discard any service-supplied blockhash/expiry and bind the transfer to
      // a blockhash from the authority-pinned sandbox RPC.
      const { blockhash, lastValidBlockHeight } = await this.#freshBlockhash();
      const extra = isRecord(original.extra) ? { ...original.extra } : {};
      delete extra.recentBlockhash;
      delete extra.lastValidBlockHeight;
      const signedRequirements: PaymentRequirements = {
        ...original,
        extra: { ...extra, recentBlockhash: blockhash, lastValidBlockHeight: lastValidBlockHeight.toString() },
      };

      payload = await this.#http.createPaymentPayload({ ...raw, accepts: [signedRequirements] });
      const check = await validateExactPaymentTransaction((payload.payload as { transaction?: unknown }).transaction, {
        payer: this.#signer.address,
        feePayer: requirement.feePayer,
        asset: requirement.asset,
        payTo: requirement.payTo,
        amountAtomic: requirement.amountAtomic,
        blockhash,
      });

      if (!check.valid) {
        throw new Error(`payment transaction rejected: ${check.reason}`);
      }

      const { payerSignature } = check;

      attempt = {
        protocol: "x402",
        scheme: requirement.scheme,
        settlementProfile: this.#profile.name,
        network: requirement.network,
        payer: this.#signer.address,
        payerSignature,
        feePayer: requirement.feePayer,
        asset: requirement.asset,
        payTo: requirement.payTo,
        amountAtomic: requirement.amountAtomic,
        blockhash,
        lastValidBlockHeight: lastValidBlockHeight.toString(),
        resourceUrl: resource.url,
        preparedAt: Date.now(),
      };

      await input.beforeSubmit(attempt);
    } catch (error) {
      throw new PaymentNotSubmittedError(
        `Payment credential was not transmitted: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    // ---- Transmission: from here on the outcome may be unknown. ----
    let response: Response;

    try {
      response = await this.#fetch(resource.url, {
        method: resource.method,
        redirect: "manual",
        headers: {
          accept: "application/json",
          "x-vh-invocation-id": reference,
          ...this.#http.encodePaymentSignatureHeader(payload),
        },
        signal: AbortSignal.timeout(this.#httpTimeoutMs),
      });
    } catch (error) {
      throw new PaymentOutcomeUnknownError(`Paid retry failed after transmission: ${describe(error)}`, attempt);
    }

    let bodyBytes: Uint8Array;

    try {
      bodyBytes = await readBounded(response, this.#maxResultBytes * 4);
    } catch (error) {
      throw new PaymentOutcomeUnknownError(`Paid response could not be read: ${describe(error)}`, attempt);
    }

    if (response.status !== 200) {
      throw new PaymentOutcomeUnknownError(`Paid retry returned HTTP ${response.status}.`, attempt);
    }

    let reported: string | null = null;

    try {
      const settle = this.#http.getPaymentSettleResponse((name) => response.headers.get(name)) as { success?: unknown; transaction?: unknown };

      if (settle.success !== true) {
        throw new Error("settlement not successful");
      }

      reported = typeof settle.transaction === "string" ? settle.transaction : null;
    } catch (error) {
      throw new PaymentOutcomeUnknownError(`Settlement response missing or unsuccessful: ${describe(error)}`, attempt);
    }

    // The facilitator's report is untrusted: confirm on the pinned RPC.
    const settlement = await this.#awaitConfirmation(attempt, reported);

    return { attempt, settlement, result: this.#summarizeResult(response.status, bodyBytes) };
  }

  async lookupSettlement(attempt: PaymentAttempt): Promise<SettlementLookup> {
    return this.#lookup(attempt, null);
  }

  // -------------------------------------------------------------------------

  async #awaitConfirmation(attempt: PaymentAttempt, reported: string | null): Promise<ConfirmedSettlement> {
    const deadline = Date.now() + this.#confirmationWaitMs;
    let last: SettlementLookup | null = null;

    while (Date.now() < deadline) {
      try {
        last = await this.#lookup(attempt, reported);
      } catch (error) {
        last = { status: "inconclusive", detail: describe(error) };
      }

      if (last.status === "confirmed") {
        return last.settlement;
      }

      if (last.status === "failed_onchain" || last.status === "expired") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new PaymentOutcomeUnknownError(
      `Settlement not confirmed on the pinned RPC (last lookup: ${last?.status ?? "none"}).`,
      attempt,
    );
  }

  /**
   * Finds the transaction carrying the payer's own signature and checks
   * every payment fact. Payer activity alone is never enough.
   */
  async #lookup(attempt: PaymentAttempt, hint: string | null): Promise<SettlementLookup> {
    const history = await this.#rpc<Array<{ signature?: unknown }>>("getSignaturesForAddress", [
      attempt.payer,
      { limit: 50, commitment: "confirmed" },
    ]);
    const candidates = new Set<string>();

    if (hint) {
      candidates.add(hint);
    }

    for (const entry of Array.isArray(history) ? history : []) {
      if (typeof entry.signature === "string") {
        candidates.add(entry.signature);
      }
    }

    const destination = await associatedTokenAddress(attempt.payTo, attempt.asset, TOKEN_PROGRAM);
    const destination2022 = await associatedTokenAddress(attempt.payTo, attempt.asset, TOKEN_2022_PROGRAM);

    for (const signature of candidates) {
      const tx = await this.#rpc<RpcTransaction | null>("getTransaction", [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);

      if (!tx?.transaction?.signatures?.includes(attempt.payerSignature)) {
        continue;
      }

      const transactionId = tx.transaction.signatures[0] ?? signature;
      const factsMatch =
        tx.transaction.message?.recentBlockhash === attempt.blockhash &&
        (tx.transaction.message.instructions ?? []).some((ix) => {
          const info = ix.parsed?.info;
          const amount = isRecord(info?.tokenAmount) ? info.tokenAmount.amount : undefined;
          return (
            ix.parsed?.type === "transferChecked" &&
            info?.mint === attempt.asset &&
            info?.authority === attempt.payer &&
            (info?.destination === destination || info?.destination === destination2022) &&
            amount === attempt.amountAtomic
          );
        });

      if (!factsMatch) {
        return { status: "inconclusive", detail: `transaction ${transactionId} carries the payer signature but its facts do not match` };
      }

      if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
        return { status: "failed_onchain", transactionId, error: JSON.stringify(tx.meta.err) };
      }

      return {
        status: "confirmed",
        settlement: {
          transactionId,
          slot: typeof tx.slot === "number" ? String(tx.slot) : null,
          facilitatorReportedTransaction: hint,
          confirmedAt: Date.now(),
        },
      };
    }

    const height = BigInt(await this.#rpc<number>("getBlockHeight", [{ commitment: "confirmed" }]));

    if (height > BigInt(attempt.lastValidBlockHeight) + this.#expiryMarginBlocks) {
      return { status: "expired", currentBlockHeight: height.toString() };
    }

    return { status: "pending", currentBlockHeight: height.toString() };
  }

  async #freshBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const result = await this.#rpc<{ value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const blockhash = result.value?.blockhash;
    const lastValid = result.value?.lastValidBlockHeight;

    if (typeof blockhash !== "string" || typeof lastValid !== "number") {
      throw new Error("Pinned RPC returned a malformed blockhash.");
    }

    if (!blockhash.startsWith(this.#profile.requiredBlockhashPrefix)) {
      throw new Error("Pinned RPC blockhash is not a sandbox blockhash; refusing to sign.");
    }

    return { blockhash, lastValidBlockHeight: BigInt(lastValid) };
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.#fetch(this.#profile.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(this.#rpcTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`RPC ${method} returned HTTP ${response.status}.`);
    }

    const body = (await response.json()) as { result?: T; error?: { message?: string } };

    if (body.error) {
      throw new Error(`RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
    }

    return body.result as T;
  }

  #summarizeResult(httpStatus: number, bytes: Uint8Array): PaidResult {
    let json: unknown = null;

    if (bytes.byteLength <= this.#maxResultBytes) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        json = null;
      }
    }

    return { httpStatus, json, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  }
}

/** Strictly normalizes a decoded x402 PaymentRequired. Fails closed on anything unexpected. */
export function normalizeChallenge(decoded: unknown): ChallengeResult {
  if (!isRecord(decoded)) {
    return { kind: "rejected", reasonCode: "CHALLENGE_MALFORMED", message: "Challenge is not an object." };
  }

  if (decoded.x402Version !== 2) {
    return {
      kind: "rejected",
      reasonCode: "UNSUPPORTED_PAYMENT_PROTOCOL",
      message: `Unsupported x402 version ${JSON.stringify(decoded.x402Version)}.`,
    };
  }

  const accepts = decoded.accepts;

  if (!Array.isArray(accepts) || accepts.length === 0 || accepts.length > MAX_ACCEPTS) {
    return { kind: "rejected", reasonCode: "CHALLENGE_MALFORMED", message: "Challenge accepts[] is missing, empty or too long." };
  }

  const resourceUrl = isRecord(decoded.resource) && typeof decoded.resource.url === "string" ? decoded.resource.url : null;
  const requirements: PaymentRequirement[] = [];

  accepts.forEach((entry, acceptsIndex) => {
    if (!isRecord(entry)) {
      return;
    }

    const { scheme, network, asset, payTo, amount } = entry;

    if (
      typeof scheme !== "string" ||
      typeof network !== "string" ||
      typeof asset !== "string" ||
      typeof payTo !== "string" ||
      typeof amount !== "string" ||
      !CANONICAL_AMOUNT.test(amount) ||
      BigInt(amount) > MAX_U64
    ) {
      return;
    }

    const extra = isRecord(entry.extra) ? entry.extra : {};
    requirements.push({
      protocol: "x402",
      x402Version: 2,
      acceptsIndex,
      scheme,
      network,
      asset,
      payTo,
      amountAtomic: amount,
      feePayer: typeof extra.feePayer === "string" ? extra.feePayer : null,
      maxTimeoutSeconds: typeof entry.maxTimeoutSeconds === "number" ? entry.maxTimeoutSeconds : null,
      resourceUrl,
    });
  });

  if (requirements.length === 0) {
    return { kind: "rejected", reasonCode: "CHALLENGE_MALFORMED", message: "Challenge has no well-formed payment requirement." };
  }

  const challenge: PaymentChallenge = { kind: "challenge", requirements, raw: decoded };
  return challenge;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }

    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
