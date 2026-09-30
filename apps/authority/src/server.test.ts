import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PaymentProvider } from "@virtual-haibin/payments";
import { AuthorityService, type AuthorizeRequestInput } from "./authorize.js";
import { createAuthorityServer } from "./server.js";
import { SqliteAuthorityStore } from "./store/sqlite-store.js";
import {
  authorityAddress,
  authoritySigner,
  buildSignedPermit,
  CountingPaymentProvider,
  otherAgentIdentity,
  signedInput,
  TEST_AUDIENCE,
} from "./test-support.js";

const SHARED_SECRET = "test-only-shared-secret";

async function startServer(paymentProvider: PaymentProvider): Promise<{ server: Server; baseUrl: string }> {
  const authorityService = new AuthorityService({
    authoritySigner,
    authorityAddress,
    audience: TEST_AUDIENCE,
    paymentProvider,
    store: new SqliteAuthorityStore(":memory:"),
    log: () => {},
  });

  const server = createAuthorityServer({ authorityService, authorityAddress, sharedSecret: SHARED_SECRET });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
}

const provider = new CountingPaymentProvider();
let server: Server;
let baseUrl: string;

before(async () => {
  ({ server, baseUrl } = await startServer(provider));
});

after(async () => {
  await stopServer(server);
});

function postAuthorize(body: unknown, options: { target?: string; bearer?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = options.bearer === undefined ? SHARED_SECRET : options.bearer;

  if (bearer !== null) {
    headers.authorization = `Bearer ${bearer}`;
  }

  return fetch(`${options.target ?? baseUrl}/authorize`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function reasonCodeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { reasonCode?: string }).reasonCode;
}

test("GET /health returns ok without authentication and exposes only the public address", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.deepEqual(Object.keys(body).sort(), ["authority", "service", "status"]);
});

test("missing or wrong bearer token is rejected with 401 before any processing", async () => {
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-no-bearer-1" });
  const callsBefore = provider.calls.length;

  assert.equal((await postAuthorize(input, { bearer: null })).status, 401);
  assert.equal((await postAuthorize(input, { bearer: "wrong-secret" })).status, 401);
  assert.equal(provider.calls.length, callsBefore);
});

test("invalid JSON is rejected safely with 400", async () => {
  assert.equal((await postAuthorize("{not valid json")).status, 400);
});

test("oversized payload is rejected with 413", async () => {
  assert.equal((await postAuthorize({ permit: "x".repeat(20_000) })).status, 413);
});

test("non-object JSON bodies (null, array, string, number) are rejected with 400", async () => {
  for (const body of ["null", "[]", '"a string"', "42"]) {
    assert.equal((await postAuthorize(body)).status, 400, body);
  }
});

test("missing required fields are rejected with 400", async () => {
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-missing-1" });

  assert.equal((await postAuthorize({ ...input, permit: undefined })).status, 400);
  assert.equal((await postAuthorize({ ...input, authorizationRequest: undefined })).status, 400);
  const { invocationId: _dropped, ...withoutInvocation } = input.authorizationRequest;
  assert.equal((await postAuthorize({ ...input, authorizationRequest: withoutInvocation })).status, 400);
});

test("unexpected field types and extra fields in the signed request are rejected with 400", async () => {
  const permit = await buildSignedPermit();
  const input = await signedInput(permit, { invocationId: "inv-types-1" });
  const callsBefore = provider.calls.length;

  for (const change of [
    { amountAtomic: 10000 },
    { amountAtomic: "0.01" },
    { version: 2 },
    // A caller can never supply its own spend total.
    { alreadySpentAtomic: "0" },
  ]) {
    const response = await postAuthorize({ ...input, authorizationRequest: { ...input.authorizationRequest, ...change } });
    assert.equal(response.status, 400, JSON.stringify(change));
  }

  assert.equal(provider.calls.length, callsBefore);
});

test("a well-formed agent-signed request succeeds end-to-end over HTTP", async () => {
  const permit = await buildSignedPermit();
  const response = await postAuthorize(await signedInput(permit, { invocationId: "inv-http-allow-1" }));

  assert.equal(response.status, 200);
  const body = (await response.json()) as { decision: string; replay: boolean };
  assert.equal(body.decision, "ALLOW");
  assert.equal(body.replay, false);
});

test("the bearer token alone cannot authorize a permit that belongs to another agent", async () => {
  // The attacker holds the transport bearer secret and a copy of the victim
  // agent's signed permit, but not the victim's identity key.
  const victimPermit = await buildSignedPermit();
  const callsBefore = provider.calls.length;

  const selfSigned = await signedInput(victimPermit, { invocationId: "inv-steal-1", agent: otherAgentIdentity });
  const unsigned: Partial<AuthorizeRequestInput> = { ...selfSigned, agentSignature: undefined };

  const withOwnKey = await postAuthorize(selfSigned);
  assert.equal(withOwnKey.status, 401);
  assert.equal(await reasonCodeOf(withOwnKey), "AGENT_SIGNATURE_INVALID");

  const withoutSignature = await postAuthorize(unsigned);
  assert.equal(withoutSignature.status, 401);
  assert.equal(await reasonCodeOf(withoutSignature), "AGENT_SIGNATURE_MISSING");

  assert.equal(provider.calls.length, callsBefore);
});

test("same invocationId with a different request returns 409 INVOCATION_CONFLICT and pays nothing", async () => {
  const permit = await buildSignedPermit();
  const first = await postAuthorize(await signedInput(permit, { invocationId: "inv-http-conflict-1", amountAtomic: "10000" }));
  assert.equal(first.status, 200);
  const callsBefore = provider.calls.length;

  const conflict = await postAuthorize(await signedInput(permit, { invocationId: "inv-http-conflict-1", amountAtomic: "15000" }));
  assert.equal(conflict.status, 409);
  assert.equal(await reasonCodeOf(conflict), "INVOCATION_CONFLICT");

  const replay = await postAuthorize(await signedInput(permit, { invocationId: "inv-http-conflict-1", amountAtomic: "10000" }));
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replay: boolean }).replay, true);

  assert.equal(provider.calls.length, callsBefore);
});

test("an uncertain payment returns 409 RECONCILIATION_REQUIRED and a retry does not pay again", async () => {
  let attempts = 0;
  const timingOut: PaymentProvider = {
    async pay() {
      attempts += 1;
      throw new Error("simulated RPC timeout after submission");
    },
  };
  const isolated = await startServer(timingOut);

  try {
    const permit = await buildSignedPermit();
    const input = await signedInput(permit, { invocationId: "inv-409-1" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await postAuthorize(input, { target: isolated.baseUrl });
      assert.equal(response.status, 409);
      assert.equal(await reasonCodeOf(response), "RECONCILIATION_REQUIRED");
    }

    assert.equal(attempts, 1);
  } finally {
    await stopServer(isolated.server);
  }
});

test("internal errors return a generic 500 without leaking error details", async () => {
  const failing = {
    authorize: async () => {
      throw new Error("sensitive internal detail");
    },
  } as unknown as AuthorityService;
  const internal = createAuthorityServer({ authorityService: failing, authorityAddress: "x", sharedSecret: SHARED_SECRET });
  await new Promise<void>((resolve) => internal.listen(0, resolve));
  const { port } = internal.address() as AddressInfo;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const permit = await buildSignedPermit();
    const response = await postAuthorize(await signedInput(permit, { invocationId: "inv-500-1" }), {
      target: `http://127.0.0.1:${port}`,
    });
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.ok(!text.includes("sensitive internal detail"));
    assert.ok(text.includes("INTERNAL_ERROR"));
  } finally {
    console.error = originalConsoleError;
    await stopServer(internal);
  }
});

test("injected accounting fields cannot influence authorization anywhere in the request", async () => {
  // Exhaust the grant: 20000 + 20000 of a 40000 total.
  const permit = await buildSignedPermit({ maxPerCallAtomic: "20000", maxTotalAtomic: "40000" });
  for (const invocationId of ["inv-inject-1", "inv-inject-2"]) {
    const response = await postAuthorize(await signedInput(permit, { invocationId, amountAtomic: "20000" }));
    assert.equal(((await response.json()) as { decision: string }).decision, "ALLOW");
  }

  const injected = { alreadySpentAtomic: "0", consumedAtomic: "0", reservedAtomic: "0", remainingAtomic: "40000" };
  const callsBefore = provider.calls.length;

  // 1. Inside the signed request: rejected by the strict protocol schema.
  for (const [field, value] of Object.entries(injected)) {
    const input = await signedInput(permit, { invocationId: `inv-inject-req-${field}`, amountAtomic: "20000" });
    const response = await postAuthorize({ ...input, authorizationRequest: { ...input.authorizationRequest, [field]: value } });
    assert.equal(response.status, 400, field);
  }

  // 2. At the top level of the body, and 3. inside the permit object: ignored
  //    (never read, and not part of the verified permit or its digest), so
  //    the authority's own durable total still denies the request.
  const input = await signedInput(permit, { invocationId: "inv-inject-body", amountAtomic: "20000" });
  const response = await postAuthorize({ ...input, ...injected, permit: { ...permit, ...injected } });
  const body = (await response.json()) as { decision: string; receipt: { reasonCodes: string[] } };

  assert.equal(response.status, 200);
  assert.equal(body.decision, "DENY");
  assert.deepEqual(body.receipt.reasonCodes, ["TOTAL_BUDGET_EXCEEDED"]);
  assert.equal(provider.calls.length, callsBefore);
});
