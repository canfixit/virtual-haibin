import { canonicalBytes, sha256Hex } from "./canonical.js";

/**
 * The exact paid-API operation a human approves (PurchasePermit v2) and an
 * agent asks for (AuthorizationRequest v2).
 *
 * This is deliberately ONE concrete, typed operation shape -- an HTTP POST to
 * a report resource with a two-field JSON body -- not a policy language or a
 * capability framework. Payment terms (amount, mint, recipient) cannot tell
 * "summarize dataset-a" from "export dataset-a" when both cost the same; this
 * object can, and the human's signature covers it.
 *
 * Security-relevant fields. Every one is covered by the human's permit
 * signature, the agent's request signature and the operation digest, and the
 * authority compares each one exactly:
 *
 *   method     HTTP method of the paid call ("POST")
 *   resource   path of the paid resource on the configured service
 *   operation  business action: "summarize" | "export"
 *   datasetId  the dataset the action applies to
 *
 * Unknown keys are rejected rather than ignored, so no unsigned argument can
 * ride along and change what the paid service does. The outbound HTTP body is
 * derived from this object only (see operationRequestBody); the agent never
 * supplies request bytes.
 */
export const EXACT_OPERATION_DOMAIN = "virtual-haibin/exact-operation";
export const EXACT_OPERATION_VERSION = 1;

export const OPERATION_METHODS = ["POST"] as const;
export const REPORT_OPERATIONS = ["summarize", "export"] as const;

export type OperationMethod = (typeof OPERATION_METHODS)[number];
export type ReportOperation = (typeof REPORT_OPERATIONS)[number];

export type ExactOperationV1 = {
  method: OperationMethod;
  /** Absolute path on the paid service, e.g. "/api/v1/report". No query, no dot segments. */
  resource: string;
  operation: ReportOperation;
  /** Lowercase dataset identifier, e.g. "dataset-a". */
  datasetId: string;
};

export type OperationValidationResult =
  | { valid: true; operation: ExactOperationV1 }
  | { valid: false; message: string };

const OPERATION_FIELDS = ["method", "resource", "operation", "datasetId"] as const;

/** 1-8 path segments of [A-Za-z0-9_-]: no query, fragment, encoding tricks or dot segments. */
const RESOURCE_PATTERN = /^(\/[A-Za-z0-9_-]{1,32}){1,8}$/;
const DATASET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Strict structural validation of an untrusted operation. Returns an
 * explicitly copied object, so nothing beyond the four known fields can
 * reach signing, comparison or the outbound request.
 */
export function validateExactOperation(candidate: unknown): OperationValidationResult {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { valid: false, message: "operation must be a JSON object." };
  }

  const record = candidate as Record<string, unknown>;
  const unknownField = Object.keys(record).find((key) => !(OPERATION_FIELDS as readonly string[]).includes(key));

  if (unknownField !== undefined) {
    return { valid: false, message: `operation has unexpected field ${JSON.stringify(unknownField)}.` };
  }

  if (typeof record.method !== "string" || !(OPERATION_METHODS as readonly string[]).includes(record.method)) {
    return { valid: false, message: `operation.method must be one of: ${OPERATION_METHODS.join(", ")}.` };
  }

  if (typeof record.resource !== "string" || !RESOURCE_PATTERN.test(record.resource)) {
    return { valid: false, message: "operation.resource must be an absolute path of [A-Za-z0-9_-] segments." };
  }

  if (typeof record.operation !== "string" || !(REPORT_OPERATIONS as readonly string[]).includes(record.operation)) {
    return { valid: false, message: `operation.operation must be one of: ${REPORT_OPERATIONS.join(", ")}.` };
  }

  if (typeof record.datasetId !== "string" || !DATASET_ID_PATTERN.test(record.datasetId)) {
    return { valid: false, message: "operation.datasetId must be a lowercase identifier of [a-z0-9-]." };
  }

  return {
    valid: true,
    operation: {
      method: record.method as OperationMethod,
      resource: record.resource,
      operation: record.operation as ReportOperation,
      datasetId: record.datasetId,
    },
  };
}

/** Explicit copy of the four security-relevant fields (drops anything else on the object). */
function normalized(operation: ExactOperationV1): ExactOperationV1 {
  return {
    method: operation.method,
    resource: operation.resource,
    operation: operation.operation,
    datasetId: operation.datasetId,
  };
}

/**
 * Lowercase hex SHA-256 over the domain-separated RFC 8785 canonical JSON of
 * the normalized operation `{method, resource, operation, datasetId}`.
 * Identifies "what business operation" in fingerprints and receipts.
 */
export async function computeOperationDigest(operation: ExactOperationV1): Promise<string> {
  return sha256Hex(canonicalBytes(`${EXACT_OPERATION_DOMAIN}:v${EXACT_OPERATION_VERSION}\n`, normalized(operation)));
}

/**
 * The exact JSON body sent to the paid service for this operation:
 * RFC 8785 canonical JSON of `{datasetId, operation}`. method and resource
 * become the HTTP method and URL path. Only the authority calls this, on an
 * operation it has already verified against the human's permit.
 */
export function operationRequestBody(operation: ExactOperationV1): string {
  return new TextDecoder().decode(canonicalBytes("", { operation: operation.operation, datasetId: operation.datasetId }));
}

/** Exact field-by-field equality of two validated operations. */
export function operationsEqual(a: ExactOperationV1, b: ExactOperationV1): boolean {
  return a.method === b.method && a.resource === b.resource && a.operation === b.operation && a.datasetId === b.datasetId;
}
