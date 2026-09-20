export type SpendingLimit = {
  token: string;
  maxPerTransaction: number;
  maxTotal: number;
};

export type Mandate = {
  id: string;
  issuer: string;
  agent: string;
  capabilities: string[];
  spending: SpendingLimit;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
};
