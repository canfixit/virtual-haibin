import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExactOperationV1 } from "@virtual-haibin/mandate";
import { evaluateExactOperation } from "./operation.js";

const approved: ExactOperationV1 = { method: "POST", resource: "/api/v1/report", operation: "summarize", datasetId: "dataset-a" };

test("the exact human-approved operation is allowed", () => {
  assert.deepEqual(evaluateExactOperation(approved, { ...approved }), { allowed: true, reasons: [], reasonCodes: [] });
});

test("each mismatching field is denied with its own stable reason code", () => {
  const cases = [
    { change: { operation: "export" }, code: "OPERATION_NOT_AUTHORIZED" },
    { change: { datasetId: "dataset-b" }, code: "OPERATION_ARGUMENT_NOT_AUTHORIZED" },
    { change: { resource: "/api/v1/export" }, code: "OPERATION_RESOURCE_MISMATCH" },
    // Not reachable through validateExactOperation today (POST only); the
    // comparison still exists so a widened schema cannot silently allow it.
    { change: { method: "GET" }, code: "OPERATION_METHOD_MISMATCH" },
  ] as const;

  for (const { change, code } of cases) {
    const decision = evaluateExactOperation(approved, { ...approved, ...change } as ExactOperationV1);
    assert.equal(decision.allowed, false, code);
    assert.deepEqual(decision.reasonCodes, [code]);
  }
});

test("multiple mismatches are all reported", () => {
  const decision = evaluateExactOperation(approved, { ...approved, operation: "export", datasetId: "dataset-b" });
  assert.deepEqual(decision.reasonCodes, ["OPERATION_NOT_AUTHORIZED", "OPERATION_ARGUMENT_NOT_AUTHORIZED"]);
});
