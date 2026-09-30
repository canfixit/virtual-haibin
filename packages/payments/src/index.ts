export type PaymentRequest = {
  from: string;
  /** Authoritative recipient address, never a display name. */
  to: string;
  /** Authoritative token mint address, never a display symbol. */
  mint: string;
  network: string;
  /** Integer atomic units, canonical decimal string (no floating point). */
  amountAtomic: string;
  reference: string;
};

export type PaymentReceipt = PaymentRequest & {
  transactionId: string;
  status: "simulated";
  settledAt: number;
};

export interface PaymentProvider {
  pay(request: PaymentRequest): Promise<PaymentReceipt>;
}

export class MockPaymentProvider implements PaymentProvider {
  async pay(request: PaymentRequest): Promise<PaymentReceipt> {
    return {
      ...request,
      transactionId: `mock-${crypto.randomUUID()}`,
      status: "simulated",
      settledAt: Date.now(),
    };
  }
}
