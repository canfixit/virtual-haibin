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
import { paidRequestMatches, type PaidRequest } from "./paid-request.js";

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
};

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
  #counter = 0;

  constructor(options: MockPaymentProviderOptions) {
    this.settlementProfile = options.settlementProfile ?? "solana-payment-sandbox";
    this.payerAddress = options.payerAddress ?? "MockPayer1111111111111111111111111111111111";
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

    const attempt: PaymentAttempt = {
      protocol: "x402",
      scheme: input.requirement.scheme,
      settlementProfile: this.settlementProfile,
      network: input.requirement.network,
      payer: this.payerAddress,
      payerSignature: `mock-payer-sig-${n}`,
      feePayer: input.requirement.feePayer ?? "",
      asset: input.requirement.asset,
      payTo: input.requirement.payTo,
      amountAtomic: input.requirement.amountAtomic,
      blockhash: `mock-blockhash-${n}`,
      lastValidBlockHeight: "1000",
      resourceUrl: input.request.url,
      requestSha256: input.request.sha256,
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

    const transactionId = `mock-tx-${n}`;
    this.ledger.set(attempt.payerSignature, { transactionId, attempt });

    return {
      attempt,
      settlement: { transactionId, slot: String(n), facilitatorReportedTransaction: transactionId, confirmedAt: Date.now() },
      result: { httpStatus: 200, json: { result: `mock paid result ${n}` }, sha256: "0".repeat(64), bytes: 0 },
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
