import { createHash } from "node:crypto";
import {
  PaidServiceUnavailableError,
  PaymentNotSubmittedError,
  PaymentOutcomeUnknownError,
  type ChallengeResult,
  type ExecuteInput,
  type PaymentAttempt,
  type PaymentExecution,
  type PaymentProvider,
  type PaymentRequirement,
  type SettlementLookup,
} from "./types.js";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { buildExactPaymentTransactionForTests } from "./exact-transaction.js";
import { paidRequestMatches, type PaidRequest } from "./paid-request.js";
import { validateExactPaymentTransaction } from "./transaction-validator.js";

/**
 * In-memory PaymentProvider for tests and local development without a
 * sandbox. It never touches a network. Every `execute` call is counted so
 * tests can assert that denials never reach the payment signer.
 */
export type MockChallengeTerms = {
  scheme?: string;
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  feePayer?: string | null;
  resourceUrl?: string | null;
  x402Version?: number;
};

export type MockExecuteBehavior =
  | "settle"
  /** Fails before the credential would be transmitted. */
  | "not_submitted"
  /** Transmitted, outcome unknown (e.g. timeout after send). */
  | "unknown"
  /** Transmitted, never returns (simulates a crash mid-payment). */
  | "hang";

export type MockPaymentProviderOptions = {
  settlementProfile?: string;
  payerAddress?: string;
  /** Terms the "service" quotes for a request/reference; may return a rejection or throw. */
  challenge: (request: PaidRequest, reference: string) => MockChallengeTerms | ChallengeResult | "unavailable";
  behavior?: MockExecuteBehavior;
  /**
   * Optional real payment-wallet key. When set, each execution builds and
   * signs a genuine exact-payment transaction (recorded in the attempt), so
   * evidence tests can check it offline. Requires real addresses in the
   * challenge terms (feePayer, asset, payTo).
   */
  payer?: KeyPairSigner;
  /**
   * Optional simulated paid service: called with the paid retry (incl. its
   * `serviceAuthorizationHeader`) after settlement. Return
   * `{ acknowledgementHeader }` to attach one, or throw to simulate a
   * service that refuses before settling (the mock then reports the outcome
   * as unknown, like a real non-200 after transmission).
   */
  service?: (input: ExecuteInput, response: { body: Buffer; sha256: string; transactionId: string }) => Promise<{ acknowledgementHeader?: string }>;
};

/** A valid base58 32-byte "sandbox" blockhash for mock transactions. */
export const MOCK_BLOCKHASH = "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace1111";

export class MockPaymentProvider implements PaymentProvider {
  readonly settlementProfile: string;
  readonly payerAddress: string;
  behavior: MockExecuteBehavior;
  /** Every execute() call (i.e. every time the payment signer would be invoked). */
  readonly executions: ExecuteInput[] = [];
  /** Every unpaid probe, with the exact request the "service" received. */
  readonly challengesFetched: Array<{ request: PaidRequest; reference: string }> = [];
  /** Requests whose payment credential was "transmitted" (the paid retry the service received). */
  readonly paidRequests: PaidRequest[] = [];
  /** Settled attempts, keyed by payer signature, for lookupSettlement. */
  readonly ledger = new Map<string, { transactionId: string; attempt: PaymentAttempt }>();
  /** Force lookupSettlement's answer for attempts not in the ledger. */
  lookupWhenMissing: SettlementLookup = { status: "pending", currentBlockHeight: "0" };
  readonly #challenge: MockPaymentProviderOptions["challenge"];
  readonly #payer: KeyPairSigner | undefined;
  readonly #service: MockPaymentProviderOptions["service"];
  #counter = 0;

  constructor(options: MockPaymentProviderOptions) {
    this.settlementProfile = options.settlementProfile ?? "solana-payment-sandbox";
    this.#payer = options.payer;
    this.#service = options.service;
    this.payerAddress = options.payer?.address ?? options.payerAddress ?? "MockPayer1111111111111111111111111111111111";
    this.behavior = options.behavior ?? "settle";
    this.#challenge = options.challenge;
  }

  async fetchChallenge(request: PaidRequest, context: { reference: string }): Promise<ChallengeResult> {
    this.challengesFetched.push({ request, reference: context.reference });
    const terms = this.#challenge(request, context.reference);

    if (terms === "unavailable") {
      throw new PaidServiceUnavailableError("mock service unavailable");
    }

    if ("kind" in terms) {
      return terms;
    }

    const requirement: PaymentRequirement = {
      protocol: "x402",
      x402Version: terms.x402Version ?? 2,
      acceptsIndex: 0,
      scheme: terms.scheme ?? "exact",
      network: terms.network,
      asset: terms.asset,
      payTo: terms.payTo,
      amountAtomic: terms.amountAtomic,
      feePayer: terms.feePayer === undefined ? "MockFeePayer111111111111111111111111111111" : terms.feePayer,
      maxTimeoutSeconds: 300,
      resourceUrl: terms.resourceUrl === undefined ? request.url : terms.resourceUrl,
    };

    return { kind: "challenge", requirements: [requirement], requestSha256: request.sha256, raw: { mock: true } };
  }

  async execute(input: ExecuteInput): Promise<PaymentExecution> {
    this.executions.push(input);
    this.#counter += 1;
    const n = this.#counter;

    if (this.behavior === "not_submitted") {
      throw new PaymentNotSubmittedError("mock: rejected before transmission");
    }

    // Same request-binding contract as the real provider.
    if (!paidRequestMatches(input.request, input.challenge.requestSha256)) {
      throw new PaymentNotSubmittedError("mock: paid request does not match the challenged request");
    }

    let payerSignature = `mock-payer-sig-${n}`;
    let blockhash = `mock-blockhash-${n}`;
    let transactionBase64: string | undefined;

    if (this.#payer !== undefined) {
      const { requirement } = input;
      blockhash = MOCK_BLOCKHASH;
      transactionBase64 = await buildExactPaymentTransactionForTests({
        payer: this.#payer,
        feePayer: requirement.feePayer ?? "",
        asset: requirement.asset,
        payTo: requirement.payTo,
        amountAtomic: requirement.amountAtomic,
        blockhash,
        memo: `${input.reference}-${n}`,
      });
      const check = await validateExactPaymentTransaction(transactionBase64, {
        payer: this.#payer.address,
        feePayer: requirement.feePayer ?? "",
        asset: requirement.asset,
        payTo: requirement.payTo,
        amountAtomic: requirement.amountAtomic,
        blockhash,
      });

      if (!check.valid) {
        throw new PaymentNotSubmittedError(`mock: built an invalid transaction: ${check.reason}`);
      }

      payerSignature = check.payerSignature;
    }

    const attempt: PaymentAttempt = {
      protocol: "x402",
      scheme: input.requirement.scheme,
      settlementProfile: this.settlementProfile,
      network: input.requirement.network,
      payer: this.payerAddress,
      payerSignature,
      feePayer: input.requirement.feePayer ?? "",
      asset: input.requirement.asset,
      payTo: input.requirement.payTo,
      amountAtomic: input.requirement.amountAtomic,
      blockhash,
      lastValidBlockHeight: "1000",
      resourceUrl: input.request.url,
      requestSha256: input.request.sha256,
      ...(transactionBase64 === undefined ? {} : { transactionBase64 }),
      preparedAt: Date.now(),
    };

    try {
      await input.beforeSubmit(attempt);
    } catch (error) {
      throw new PaymentNotSubmittedError(`mock: attempt not persisted: ${error instanceof Error ? error.message : "unknown"}`);
    }

    this.paidRequests.push(input.request);

    if (this.behavior === "hang") {
      return new Promise<PaymentExecution>(() => {});
    }

    if (this.behavior === "unknown") {
      throw new PaymentOutcomeUnknownError("mock: timeout after transmission", attempt);
    }

    // With a real payer key the payer's (base58) signature doubles as the
    // transaction id, so evidence built from it is well-formed.
    const transactionId = this.#payer === undefined ? `mock-tx-${n}` : payerSignature;
    const body = Buffer.from(JSON.stringify({ result: `mock paid result ${n}`, request: JSON.parse(input.request.body) as unknown }));
    const sha256 = createHash("sha256").update(body).digest("hex");
    let acknowledgementHeader: string | undefined;

    if (this.#service !== undefined) {
      try {
        ({ acknowledgementHeader } = await this.#service(input, { body, sha256, transactionId }));
      } catch (error) {
        // A service that refuses after transmission: outcome unknown to the payer.
        throw new PaymentOutcomeUnknownError(`mock service refused: ${error instanceof Error ? error.message : "unknown"}`, attempt);
      }
    }

    this.ledger.set(attempt.payerSignature, { transactionId, attempt });

    return {
      attempt,
      settlement: { transactionId, slot: String(n), facilitatorReportedTransaction: transactionId, confirmedAt: Date.now() },
      result: {
        httpStatus: 200,
        json: JSON.parse(body.toString("utf8")) as unknown,
        sha256,
        bytes: body.byteLength,
        bodyBase64: body.toString("base64"),
        ...(acknowledgementHeader === undefined ? {} : { serviceAcknowledgementHeader: acknowledgementHeader }),
      },
    };
  }

  /** Records that an attempt landed on-chain (e.g. after a simulated timeout), for reconciliation tests. */
  settleLater(attempt: PaymentAttempt, transactionId: string): void {
    this.ledger.set(attempt.payerSignature, { transactionId, attempt });
  }

  async lookupSettlement(attempt: PaymentAttempt): Promise<SettlementLookup> {
    const entry = this.ledger.get(attempt.payerSignature);

    if (entry) {
      return {
        status: "confirmed",
        settlement: { transactionId: entry.transactionId, slot: "1", facilitatorReportedTransaction: null, confirmedAt: Date.now() },
      };
    }

    return this.lookupWhenMissing;
  }
}

/** TEST ONLY: a fresh in-memory payment wallet key for MockPaymentProvider's `payer` option. */
export function generateMockPaymentWallet(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}
