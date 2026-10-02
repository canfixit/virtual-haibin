import type { ExactOperationV1 } from "@virtual-haibin/mandate";

/**
 * Stable reason codes for a requested operation that is outside the
 * human-approved one. Each one is independent of payment terms: a request
 * can quote exactly the same amount, mint and recipient and still be denied.
 */
export type OperationReasonCode =
  | "OPERATION_METHOD_MISMATCH"
  | "OPERATION_RESOURCE_MISMATCH"
  | "OPERATION_NOT_AUTHORIZED"
  | "OPERATION_ARGUMENT_NOT_AUTHORIZED";

export type OperationDecision = {
  allowed: boolean;
  reasons: string[];
  reasonCodes: OperationReasonCode[];
};

/**
 * Exact-match comparison of the operation an agent requests against the
 * operation the human signed in a PurchasePermit v2. Deliberately not a
 * policy language: every field must be equal. Both inputs must already be
 * validated (validateExactOperation), so neither carries unknown fields.
 */
export function evaluateExactOperation(permitted: ExactOperationV1, requested: ExactOperationV1): OperationDecision {
  const reasons: string[] = [];
  const reasonCodes: OperationReasonCode[] = [];

  function deny(reasonCode: OperationReasonCode, message: string): void {
    reasons.push(message);
    reasonCodes.push(reasonCode);
  }

  if (requested.method !== permitted.method) {
    deny("OPERATION_METHOD_MISMATCH", `Method "${requested.method}" is not the human-approved method.`);
  }

  if (requested.resource !== permitted.resource) {
    deny("OPERATION_RESOURCE_MISMATCH", `Resource "${requested.resource}" is not the human-approved resource.`);
  }

  if (requested.operation !== permitted.operation) {
    deny("OPERATION_NOT_AUTHORIZED", `Operation "${requested.operation}" was not approved by the human.`);
  }

  if (requested.datasetId !== permitted.datasetId) {
    deny("OPERATION_ARGUMENT_NOT_AUTHORIZED", `datasetId "${requested.datasetId}" was not approved by the human.`);
  }

  return { allowed: reasonCodes.length === 0, reasons, reasonCodes };
}
