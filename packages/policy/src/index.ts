import type { Mandate } from "@virtual-haibin/mandate";

export type PolicyRequest = {
  capability: string;
  amount: number;
  token: string;
  alreadySpent: number;
  now?: number;
};

export type PolicyDecision = {
  allowed: boolean;
  reasons: string[];
};

export function evaluateMandate(
  mandate: Mandate,
  request: PolicyRequest,
): PolicyDecision {
  const now = request.now ?? Date.now();
  const reasons: string[] = [];

  if (now > mandate.expiresAt) {
    reasons.push("Mandate has expired.");
  }

  if (!mandate.capabilities.includes(request.capability)) {
    reasons.push(`Capability "${request.capability}" is not delegated.`);
  }

  if (request.token !== mandate.spending.token) {
    reasons.push(
      `Token "${request.token}" is not allowed; expected "${mandate.spending.token}".`,
    );
  }

  if (!Number.isFinite(request.amount) || request.amount <= 0) {
    reasons.push("Requested amount must be a positive finite number.");
  }

  if (request.amount > mandate.spending.maxPerTransaction) {
    reasons.push("Requested amount exceeds the per-transaction limit.");
  }

  if (request.alreadySpent + request.amount > mandate.spending.maxTotal) {
    reasons.push("Requested amount exceeds the total delegated budget.");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
