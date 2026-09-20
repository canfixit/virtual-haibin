export type PaymentRequest = {
  from: string;
  to: string;
  token: string;
  amount: number;
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
