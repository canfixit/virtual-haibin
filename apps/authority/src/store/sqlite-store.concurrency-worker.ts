// Worker for sqlite-store.test.ts: one thread = one independent SQLite
// connection, contending with the others for the same grant's budget.
import { parentPort, workerData } from "node:worker_threads";
import { AUTHORIZATION_REQUEST_PROTOCOL, AUTHORIZATION_REQUEST_VERSION } from "@virtual-haibin/mandate";
import { SqliteAuthorityStore } from "./sqlite-store.js";

type WorkerInput = {
  path: string;
  workerIndex: number;
  perWorker: number;
  amountAtomic: string;
  maxTotalAtomic: string;
  startSignal: Int32Array;
};

const input = workerData as WorkerInput;
const store = new SqliteAuthorityStore(input.path, { busyTimeoutMs: 10_000 });
const issuer = "Issuer1111111111111111111111111111111111111";
const outcomes: string[] = [];

Atomics.wait(input.startSignal, 0, 0);

for (let index = 0; index < input.perWorker; index += 1) {
  const invocationId = `w${input.workerIndex}-${index}`;
  const result = await store.reserve(
    {
      invocationId,
      fingerprint: `fp-${invocationId}`,
      grant: { issuer, grantId: "grant-1", permitDigest: "a".repeat(64), maxTotalAtomic: input.maxTotalAtomic },
      agent: "Agent1111111111111111111111111111111111111",
      request: {
        protocol: AUTHORIZATION_REQUEST_PROTOCOL,
        version: AUTHORIZATION_REQUEST_VERSION,
        audience: "test-authority",
        grantId: "grant-1",
        permitDigest: "a".repeat(64),
        invocationId,
        service: "mock-research-agent",
        capability: "research.summary",
        network: "devnet",
        mint: "Mint111111111111111111111111111111111111111",
        recipient: "Recipient11111111111111111111111111111111111",
        amountAtomic: input.amountAtomic,
        issuedAt: 1,
      },
      amountAtomic: input.amountAtomic,
      decidedAt: 1,
      paymentRequirement: null,
    },
    (committedAtomic) =>
      BigInt(committedAtomic) + BigInt(input.amountAtomic) <= BigInt(input.maxTotalAtomic)
        ? { allowed: true }
        : { allowed: false, reasonCodes: ["TOTAL_BUDGET_EXCEEDED"] },
  );
  outcomes.push(result.kind);
}

await store.close();
parentPort?.postMessage(outcomes);
