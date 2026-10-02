import assert from "node:assert/strict";
import { test } from "node:test";
import { computeOperationDigest, operationRequestBody, operationsEqual, validateExactOperation } from "./operation.js";
import { buildOperation } from "./test-fixtures.js";

test("a well-formed operation validates and is returned as an explicit copy", () => {
  const result = validateExactOperation(buildOperation());
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.operation, buildOperation());
  }
});

test("unknown fields inside an operation fail closed (no unsigned business argument can ride along)", () => {
  for (const extra of [{ format: "csv" }, { limit: 1000 }, { body: { operation: "export" } }, { query: "?all=1" }]) {
    const result = validateExactOperation({ ...buildOperation(), ...extra });
    assert.equal(result.valid, false, JSON.stringify(extra));
  }
});

test("unexpected enum and string values are rejected", () => {
  const cases: Array<Record<string, unknown>> = [
    { method: "GET" },
    { method: "post" },
    { method: "DELETE" },
    { operation: "delete" },
    { operation: "Summarize" },
    { operation: "" },
    { resource: "api/v1/report" },
    { resource: "/api/v1/report?operation=export" },
    { resource: "/api/../report" },
    { resource: "/api//report" },
    { resource: "/api/v1/report#x" },
    { datasetId: "Dataset-A" },
    { datasetId: "dataset_a" },
    { datasetId: "-dataset" },
    { datasetId: "" },
    { datasetId: "a".repeat(65) },
    { datasetId: 1 },
  ];

  for (const change of cases) {
    assert.equal(validateExactOperation({ ...buildOperation(), ...change }).valid, false, JSON.stringify(change));
  }

  for (const missing of ["method", "resource", "operation", "datasetId"]) {
    const { [missing]: _dropped, ...rest } = buildOperation() as Record<string, unknown>;
    assert.equal(validateExactOperation(rest).valid, false, missing);
  }

  for (const candidate of [null, [], "summarize", 1]) {
    assert.equal(validateExactOperation(candidate).valid, false);
  }
});

test("the operation digest is deterministic, ignores construction order and changes with every field", async () => {
  const base = await computeOperationDigest(buildOperation());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await computeOperationDigest({ datasetId: "dataset-a", operation: "summarize", resource: "/api/v1/report", method: "POST" }), base);

  for (const change of [{ operation: "export" as const }, { datasetId: "dataset-b" }, { resource: "/api/v1/other" }]) {
    assert.notEqual(await computeOperationDigest(buildOperation(change)), base, JSON.stringify(change));
  }
});

test("the outbound body is canonical JSON of exactly {datasetId, operation}", () => {
  assert.equal(operationRequestBody(buildOperation()), '{"datasetId":"dataset-a","operation":"summarize"}');
  assert.equal(operationRequestBody(buildOperation({ operation: "export" })), '{"datasetId":"dataset-a","operation":"export"}');
  // Extra properties smuggled onto the object never reach the body.
  const smuggled = { ...buildOperation(), format: "csv" } as ReturnType<typeof buildOperation>;
  assert.equal(operationRequestBody(smuggled), '{"datasetId":"dataset-a","operation":"summarize"}');
});

test("operationsEqual compares every field exactly", () => {
  assert.equal(operationsEqual(buildOperation(), buildOperation()), true);
  assert.equal(operationsEqual(buildOperation(), buildOperation({ operation: "export" })), false);
  assert.equal(operationsEqual(buildOperation(), buildOperation({ datasetId: "dataset-b" })), false);
  assert.equal(operationsEqual(buildOperation(), buildOperation({ resource: "/api/v1/other" })), false);
});
