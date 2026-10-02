// Phase 5C live check: the real paid service refuses a PAID request that
// carries no Virtual Haibin authorization -- before its payment gate can
// settle anything. Runs in the demo-driver container (default network).
//
//   docker compose run --rm -T --no-deps demo-driver node scripts/service-refusal-check.mjs
//
// Exit 0 when refused with 403 SERVICE_AUTHORIZATION_REQUIRED, 1 otherwise.

const SERVICE_URL = process.env.SERVICE_URL ?? "http://service-agent:4001";

const response = await fetch(`${SERVICE_URL}/api/v1/report`, {
  method: "POST",
  headers: { "content-type": "application/json", "payment-signature": "not-a-real-credential", "x-vh-invocation-id": `refusal-${Date.now()}` },
  body: JSON.stringify({ operation: "export", datasetId: "dataset-a" }),
  signal: AbortSignal.timeout(15_000),
});
const body = await response.json();
console.log(JSON.stringify({ status: response.status, reasonCode: body.reasonCode ?? null }));
process.exit(response.status === 403 && body.reasonCode === "SERVICE_AUTHORIZATION_REQUIRED" ? 0 : 1);
