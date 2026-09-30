import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { SettlementProfile } from "./settlement-profile.js";
import {
  PaidServiceUnavailableError,
  PaymentNotSubmittedError,
  PaymentOutcomeUnknownError,
  type PaidResource,
  type PaymentAttempt,
  type PaymentChallenge,
} from "./types.js";
import { normalizeChallenge, X402ExactPaymentProvider } from "./x402-exact-provider.js";

// Hermetic tests: a fake x402 merchant (headers built with the official
// @x402/core encoders) and a fake Solana JSON-RPC. The real ExactSvmScheme
// builds and signs genuine transactions; only the network/chain is faked.

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SANDBOX_BLOCKHASH = "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace1111";
const EVIL_BLOCKHASH = "11111111111111111111111111111111";

const mint = (await generateKeyPairSigner()).address;
const payTo = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;

async function ata(owner: string, mintAddress: string): Promise<string> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(mintAddress))],
  });
  return pda;
}

// ---------------------------------------------------------------------------
// Fake chain + RPC
// ---------------------------------------------------------------------------

type LedgerTx = {
  id: string;
  payer: string;
  signatures: string[];
  blockhash: string;
  err: unknown;
  transfer: { mint: string; authority: string; destination: string; amount: string };
};

const chain = {
  blockhash: SANDBOX_BLOCKHASH,
  lastValidBlockHeight: 1_000,
  height: 900,
  surfnet: true,
  ledger: [] as LedgerTx[],
};

function mintAccountBase64(decimals: number): string {
  const data = new Uint8Array(82);
  data[44] = decimals; // decimals
  data[45] = 1; // isInitialized
  return Buffer.from(data).toString("base64");
}

function rpcResult(method: string, params: unknown[]): unknown {
  switch (method) {
    case "getVersion":
      return chain.surfnet ? { "solana-core": "4.0.0", "surfnet-version": "1.4.0" } : { "solana-core": "4.0.0" };
    case "getLatestBlockhash":
      return { context: { slot: 1 }, value: { blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight } };
    case "getAccountInfo":
      return {
        context: { slot: 1 },
        value: {
          data: [mintAccountBase64(6), "base64"],
          executable: false,
          lamports: 1_461_600,
          owner: TOKEN_PROGRAM,
          rentEpoch: 0,
          space: 82,
        },
      };
    case "getSignaturesForAddress":
      return chain.ledger.filter((tx) => tx.payer === params[0]).map((tx) => ({ signature: tx.id, slot: 7, err: tx.err }));
    case "getTransaction": {
      const tx = chain.ledger.find((entry) => entry.id === params[0]);
      return tx
        ? {
            slot: 7,
            meta: { err: tx.err },
            transaction: {
              signatures: tx.signatures,
              message: {
                recentBlockhash: tx.blockhash,
                instructions: [
                  {
                    program: "spl-token",
                    programId: TOKEN_PROGRAM,
                    parsed: {
                      type: "transferChecked",
                      info: {
                        mint: tx.transfer.mint,
                        authority: tx.transfer.authority,
                        destination: tx.transfer.destination,
                        tokenAmount: { amount: tx.transfer.amount, decimals: 6 },
                      },
                    },
                  },
                ],
              },
            },
          }
        : null;
    }
    case "getBlockHeight":
      return chain.height;
    default:
      throw new Error(`fake RPC: unsupported ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Fake x402 merchant
// ---------------------------------------------------------------------------

type MerchantMode = "settle" | "http500" | "reset" | "lie" | "redirect" | "free" | "garbage402" | "v1";

const merchant = {
  mode: "settle" as MerchantMode,
  amount: "10000",
  requests: [] as Array<{ paid: boolean; credentialTx: string | null; invocationHeader: string | null }>,
};

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function handle(request: IncomingMessage, response: ServerResponse, baseUrl: string): Promise<void> {
  if (request.url === "/rpc") {
    const { method, params, id } = JSON.parse(await readBody(request)) as { method: string; params: unknown[]; id: number };
    response.setHeader("content-type", "application/json");
    try {
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: rpcResult(method, params) }));
    } catch (error) {
      response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: String(error) } }));
    }
    return;
  }

  const credential = request.headers["payment-signature"];
  const paid = typeof credential === "string";
  const record = { paid, credentialTx: null as string | null, invocationHeader: (request.headers["x-vh-invocation-id"] as string) ?? null };
  merchant.requests.push(record);

  if (!paid) {
    if (merchant.mode === "redirect") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      return;
    }
    if (merchant.mode === "free") {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (merchant.mode === "garbage402") {
      response.writeHead(402, { "payment-required": "not base64 !!" }).end();
      return;
    }
    const challenge = {
      x402Version: merchant.mode === "v1" ? 1 : 2,
      resource: { url: `${baseUrl}/research` },
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          amount: merchant.amount,
          asset: mint,
          payTo,
          maxTimeoutSeconds: 300,
          // A hostile/other-chain blockhash the authority must ignore.
          extra: { feePayer, recentBlockhash: EVIL_BLOCKHASH, lastValidBlockHeight: "999999999" },
        },
      ],
    };
    response.writeHead(402, { "payment-required": encodePaymentRequiredHeader(challenge as never) }).end("{}");
    return;
  }

  const payload = decodePaymentSignatureHeader(credential) as unknown as { payload: { transaction: string } };
  record.credentialTx = payload.payload.transaction;

  if (merchant.mode === "reset") {
    request.socket.destroy();
    return;
  }
  if (merchant.mode === "http500") {
    response.writeHead(500).end("facilitator error");
    return;
  }

  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(payload.payload.transaction));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const payer = Object.keys(tx.signatures).find((key) => key !== feePayer) ?? "";
  const payerSig = getBase58Decoder().decode(tx.signatures[payer as keyof typeof tx.signatures] as Uint8Array);
  const id = getBase58Decoder().decode(randomBytes(64));

  if (merchant.mode === "settle") {
    chain.ledger.push({
      id,
      payer,
      signatures: [id, payerSig],
      blockhash: message.lifetimeToken,
      err: null,
      transfer: { mint, authority: payer, destination: await ata(payTo, mint), amount: merchant.amount },
    });
  }

  // "lie": claims success but nothing reached the chain.
  response.writeHead(200, {
    "content-type": "application/json",
    "payment-response": encodePaymentResponseHeader({ success: true, transaction: id, network: NETWORK, payer } as never),
  });
  response.end(JSON.stringify({ summary: "paid research" }));
}

let server: Server;
let baseUrl: string;
let profile: SettlementProfile;
let resource: PaidResource;

before(async () => {
  server = createServer((request, response) => void handle(request, response, baseUrl));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile = {
    name: "solana-payment-sandbox",
    permitNetwork: "solana-payment-sandbox",
    environment: "sandbox",
    rpcUrl: `${baseUrl}/rpc`,
    acceptedChallengeNetworks: [NETWORK],
    allowedAssets: [{ mint, label: "test" }],
    protocol: "x402",
    x402Version: 2,
    scheme: "exact",
    requiredBlockhashPrefix: "SURFNETxSAFEHASH",
  };
  resource = { serviceId: "svc", capability: "cap", url: `${baseUrl}/research`, method: "GET" };
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  merchant.mode = "settle";
  merchant.amount = "10000";
  merchant.requests.length = 0;
  chain.blockhash = SANDBOX_BLOCKHASH;
  chain.surfnet = true;
  chain.height = 900;
  chain.ledger.length = 0;
});

/** A payment signer that counts how often it is asked to sign. */
async function countingSigner(): Promise<TransactionPartialSigner & { signCount: number }> {
  const inner = await generateKeyPairSigner();
  const signer = {
    address: inner.address,
    signCount: 0,
    async signTransactions(transactions: Parameters<typeof inner.signTransactions>[0]) {
      signer.signCount += 1;
      return inner.signTransactions(transactions);
    },
  };
  return signer;
}

async function provider(signer?: TransactionPartialSigner) {
  return X402ExactPaymentProvider.create({ profile, confirmationWaitMs: 300, ...(signer ? { signer } : {}) });
}

async function challenge(p: X402ExactPaymentProvider): Promise<PaymentChallenge> {
  const result = await p.fetchChallenge(resource, { reference: "inv-1" });
  assert.equal(result.kind, "challenge");
  return result as PaymentChallenge;
}

// ---------------------------------------------------------------------------
// Challenge parsing
// ---------------------------------------------------------------------------

test("a real x402 v2 challenge is parsed into a normalized requirement", async () => {
  const p = await provider();
  const parsed = await challenge(p);

  assert.equal(parsed.requirements.length, 1);
  assert.deepEqual(
    { ...parsed.requirements[0] },
    {
      protocol: "x402",
      x402Version: 2,
      acceptsIndex: 0,
      scheme: "exact",
      network: NETWORK,
      asset: mint,
      payTo,
      amountAtomic: "10000",
      feePayer,
      maxTimeoutSeconds: 300,
      resourceUrl: `${baseUrl}/research`,
    },
  );
  assert.equal(merchant.requests[0]?.paid, false);
  assert.equal(merchant.requests[0]?.invocationHeader, "inv-1");
});

test("malformed, non-402, redirecting and unsupported-version responses are rejected, never followed", async () => {
  const p = await provider();
  const cases: Array<[MerchantMode, string]> = [
    ["garbage402", "CHALLENGE_MALFORMED"],
    ["free", "CHALLENGE_NOT_PAYMENT_REQUIRED"],
    ["redirect", "CHALLENGE_REDIRECT"],
    ["v1", "UNSUPPORTED_PAYMENT_PROTOCOL"],
  ];

  for (const [mode, reasonCode] of cases) {
    merchant.mode = mode;
    merchant.requests.length = 0;
    const result = await p.fetchChallenge(resource, { reference: "inv-x" });
    assert.equal(result.kind, "rejected", mode);
    assert.equal(result.kind === "rejected" && result.reasonCode, reasonCode, mode);
    // Exactly one request: a redirect is never followed.
    assert.equal(merchant.requests.length, 1, mode);
  }
});

test("an unreachable service is reported as unavailable, not as a challenge", async () => {
  const p = await X402ExactPaymentProvider.create({ profile, httpTimeoutMs: 1_000 });
  await assert.rejects(
    p.fetchChallenge({ ...resource, url: "http://127.0.0.1:9/unreachable" }, { reference: "inv-1" }),
    PaidServiceUnavailableError,
  );
});

test("challenge normalization rejects non-canonical and non-string amounts (no floating point)", () => {
  const base = { scheme: "exact", network: NETWORK, asset: mint, payTo, extra: { feePayer } };

  for (const amount of ["1.5", "01", "1e4", "-1", "", " 10", "18446744073709551616", 10000, 1.5]) {
    const result = normalizeChallenge({ x402Version: 2, accepts: [{ ...base, amount }] });
    assert.equal(result.kind, "rejected", String(amount));
  }

  for (const decoded of [null, "x", { x402Version: 2 }, { x402Version: 2, accepts: [] }, { x402Version: 2, accepts: [42] }]) {
    assert.equal(normalizeChallenge(decoded).kind, "rejected");
  }

  const ok = normalizeChallenge({ x402Version: 2, accepts: [{ ...base, amount: "18446744073709551615" }] });
  assert.equal(ok.kind === "challenge" && ok.requirements[0]?.amountAtomic, "18446744073709551615");
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test("payment is bound to the authority-fetched sandbox blockhash, not the service's, and settles", async () => {
  const signer = await countingSigner();
  const p = await provider(signer);
  const parsed = await challenge(p);
  const attempts: PaymentAttempt[] = [];

  const execution = await p.execute({
    resource,
    challenge: parsed,
    requirement: parsed.requirements[0]!,
    reference: "inv-1",
    beforeSubmit: async (attempt) => {
      // The credential has not been transmitted yet when the attempt is persisted.
      assert.equal(merchant.requests.filter((r) => r.paid).length, 0);
      attempts.push(attempt);
    },
  });

  assert.equal(signer.signCount, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.blockhash, SANDBOX_BLOCKHASH);
  assert.notEqual(attempts[0]?.blockhash, EVIL_BLOCKHASH);
  assert.equal(attempts[0]?.lastValidBlockHeight, "1000");

  // The transmitted transaction itself carries the sandbox blockhash.
  const sent = merchant.requests.find((r) => r.paid)?.credentialTx ?? "";
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(sent)).messageBytes);
  assert.equal(message.lifetimeToken, SANDBOX_BLOCKHASH);

  // Settlement identity comes from the (fake) chain, found via the payer's own signature.
  assert.equal(execution.settlement.transactionId, chain.ledger[0]?.id);
  assert.equal(chain.ledger[0]?.signatures.includes(execution.attempt.payerSignature), true);
  assert.equal(execution.result.httpStatus, 200);
  assert.deepEqual(execution.result.json, { summary: "paid research" });
  assert.match(execution.result.sha256, /^[0-9a-f]{64}$/);
  // Only one paid retry, after the unpaid probe.
  assert.deepEqual(merchant.requests.map((r) => r.paid), [false, true]);
});

test("a non-sandbox RPC blockhash is refused before signing or transmitting", async () => {
  const signer = await countingSigner();
  const p = await provider(signer);
  const parsed = await challenge(p);
  chain.blockhash = "7Xk1SomeRealLookingBlockhash1111111111111111";

  await assert.rejects(
    p.execute({ resource, challenge: parsed, requirement: parsed.requirements[0]!, reference: "inv-1", beforeSubmit: async () => {} }),
    PaymentNotSubmittedError,
  );
  assert.equal(signer.signCount, 0);
  assert.equal(merchant.requests.filter((r) => r.paid).length, 0);
});

test("the sandbox identity check requires a Surfnet RPC", async () => {
  const p = await provider();
  assert.deepEqual(await p.assertSandboxEnvironment(), { surfnetVersion: "1.4.0" });
  chain.surfnet = false;
  await assert.rejects(p.assertSandboxEnvironment(), /does not identify as the Solana Payment Sandbox/);
});

test("if the attempt cannot be persisted, the credential is never transmitted", async () => {
  const p = await provider();
  const parsed = await challenge(p);

  await assert.rejects(
    p.execute({
      resource,
      challenge: parsed,
      requirement: parsed.requirements[0]!,
      reference: "inv-1",
      beforeSubmit: async () => {
        throw new Error("disk full");
      },
    }),
    PaymentNotSubmittedError,
  );
  assert.equal(merchant.requests.filter((r) => r.paid).length, 0);
});

test("a tampered requirement (differs from the parsed challenge) is refused before signing", async () => {
  const signer = await countingSigner();
  const p = await provider(signer);
  const parsed = await challenge(p);

  for (const tampered of [{ payTo: feePayer }, { amountAtomic: "1" }, { asset: payTo }, { feePayer: signer.address }]) {
    await assert.rejects(
      p.execute({ resource, challenge: parsed, requirement: { ...parsed.requirements[0]!, ...tampered }, reference: "inv-1", beforeSubmit: async () => {} }),
      PaymentNotSubmittedError,
    );
  }

  assert.equal(signer.signCount, 0);
  assert.equal(merchant.requests.filter((r) => r.paid).length, 0);
});

test("any failure after transmission is an unknown outcome carrying the recorded attempt", async () => {
  for (const mode of ["http500", "reset", "lie"] as const) {
    merchant.mode = mode;
    const p = await provider();
    const parsed = await challenge(p);
    let persisted: PaymentAttempt | null = null;

    await assert.rejects(
      p.execute({
        resource,
        challenge: parsed,
        requirement: parsed.requirements[0]!,
        reference: "inv-1",
        beforeSubmit: async (attempt) => {
          persisted = attempt;
        },
      }),
      (error: unknown) => error instanceof PaymentOutcomeUnknownError && error.attempt === persisted,
      mode,
    );
  }
});

// ---------------------------------------------------------------------------
// Reconciliation lookups (read-only)
// ---------------------------------------------------------------------------

test("lookupSettlement finds a landed payment by the payer signature and checks every fact", async () => {
  const p = await provider();
  const parsed = await challenge(p);
  let attempt: PaymentAttempt | null = null;
  merchant.mode = "settle";
  await p.execute({ resource, challenge: parsed, requirement: parsed.requirements[0]!, reference: "inv-1", beforeSubmit: async (a) => void (attempt = a) });

  const found = await p.lookupSettlement(attempt!);
  assert.equal(found.status, "confirmed");

  // Same payer signature but different facts (e.g. amount) -> not accepted as settlement.
  chain.ledger[0]!.transfer.amount = "99999";
  assert.equal((await p.lookupSettlement(attempt!)).status, "inconclusive");

  // Failed on-chain.
  chain.ledger[0]!.transfer.amount = "10000";
  chain.ledger[0]!.err = { InstructionError: [0, "Custom"] };
  assert.equal((await p.lookupSettlement(attempt!)).status, "failed_onchain");
});

test("lookupSettlement reports pending while the blockhash may be valid, expired afterwards", async () => {
  const p = await provider();
  const attempt: PaymentAttempt = {
    protocol: "x402",
    scheme: "exact",
    settlementProfile: "solana-payment-sandbox",
    network: NETWORK,
    payer: (await generateKeyPairSigner()).address,
    payerSignature: "never-landed",
    feePayer,
    asset: mint,
    payTo,
    amountAtomic: "10000",
    blockhash: SANDBOX_BLOCKHASH,
    lastValidBlockHeight: "1000",
    resourceUrl: resource.url,
    preparedAt: 0,
  };

  chain.height = 1_010; // past lastValid but within the safety margin
  assert.equal((await p.lookupSettlement(attempt)).status, "pending");
  chain.height = 1_021;
  assert.equal((await p.lookupSettlement(attempt)).status, "expired");
});

test("the payment key is never exposed by the provider or its results", async () => {
  const p = await provider();
  const parsed = await challenge(p);
  const execution = await p.execute({ resource, challenge: parsed, requirement: parsed.requirements[0]!, reference: "inv-1", beforeSubmit: async () => {} });

  const serialized = JSON.stringify([p, execution, parsed.requirements]);
  assert.ok(!/privateKey|secretKey|keyPair/i.test(serialized));
  assert.deepEqual(Object.keys(p), ["settlementProfile"]);
});
