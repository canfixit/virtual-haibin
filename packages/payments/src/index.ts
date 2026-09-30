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

/**
 * Thrown by a provider only when it is certain the payment was never
 * submitted (e.g. rejected during local validation, before any network
 * send). The authority may then release the reservation and allow a retry.
 * Any other error -- including timeouts after send -- must be treated as an
 * unknown outcome that requires reconciliation, never as permission to pay
 * again.
 */
export class PaymentNotSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentNotSubmittedError";
  }
}
