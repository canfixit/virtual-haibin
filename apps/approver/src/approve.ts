import { isAddress } from "@solana/addresses";
import {
  PURCHASE_PERMIT_DOMAIN,
  PURCHASE_PERMIT_VERSION_2,
  signPurchasePermitV2,
  validateExactOperation,
  type ExactOperationV1,
  type SignedPurchasePermitV2,
  type SupportedNetwork,
} from "@virtual-haibin/mandate";
import type { IssuerKey } from "./issuer-key.js";

/**
 * The human's approval template: the paid service and payment terms the
 * human is willing to authorize. Fixed configuration of the approval
 * boundary -- the requester chooses only *which agent* and *which operation
 * and dataset* to approve, never the payee, asset or limits.
 */
export type ApprovalTerms = {
  service: string;
  capability: string;
  network: SupportedNetwork;
  mint: string;
  recipient: string;
  maxPerCallAtomic: string;
  maxTotalAtomic: string;
  /** Permit lifetime. */
  ttlMs: number;
  /** HTTP method and resource path of the paid operation. */
  method: ExactOperationV1["method"];
  resource: string;
};

/** What the human approves: one agent, one exact operation on one dataset. */
export type ApprovalRequest = {
  agent: string;
  operation: ExactOperationV1["operation"];
  datasetId: string;
};

export type ApprovalParseResult = { valid: true; approval: ApprovalRequest } | { valid: false; message: string };

const APPROVAL_FIELDS = ["agent", "operation", "datasetId"];

/** Strict validation of an untrusted approval request body. */
export function parseApprovalRequest(candidate: unknown, terms: ApprovalTerms): ApprovalParseResult {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { valid: false, message: "Approval request must be a JSON object." };
  }

  const record = candidate as Record<string, unknown>;
  const unknownField = Object.keys(record).find((key) => !APPROVAL_FIELDS.includes(key));

  if (unknownField !== undefined) {
    return { valid: false, message: `Unexpected field ${JSON.stringify(unknownField)}; only agent, operation and datasetId can be chosen.` };
  }

  if (typeof record.agent !== "string" || !isAddress(record.agent)) {
    return { valid: false, message: "agent must be the agent's base58 Ed25519 public key." };
  }

  const operation = validateExactOperation({
    method: terms.method,
    resource: terms.resource,
    operation: record.operation,
    datasetId: record.datasetId,
  });

  if (!operation.valid) {
    return { valid: false, message: operation.message };
  }

  return { valid: true, approval: { agent: record.agent, operation: operation.operation.operation, datasetId: operation.operation.datasetId } };
}

/**
 * Issues a PurchasePermit v2 for exactly the approved operation, signed with
 * the issuer key held only by this process.
 */
export async function issuePermit(
  approval: ApprovalRequest,
  terms: ApprovalTerms,
  issuer: IssuerKey,
  context: { now: number; grantId: string },
): Promise<SignedPurchasePermitV2> {
  return signPurchasePermitV2(
    {
      version: PURCHASE_PERMIT_VERSION_2,
      domain: PURCHASE_PERMIT_DOMAIN,
      grantId: context.grantId,
      issuer: issuer.address,
      authorizedAgent: approval.agent,
      service: terms.service,
      capability: terms.capability,
      network: terms.network,
      mint: terms.mint,
      recipient: terms.recipient,
      maxPerCallAtomic: terms.maxPerCallAtomic,
      maxTotalAtomic: terms.maxTotalAtomic,
      issuedAt: context.now,
      expiresAt: context.now + terms.ttlMs,
      subdelegation: false,
      operation: {
        method: terms.method,
        resource: terms.resource,
        operation: approval.operation,
        datasetId: approval.datasetId,
      },
    },
    issuer.keyPair,
  );
}
