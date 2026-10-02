import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { generateKeyPair, getAddressFromPublicKey } from "@solana/kit";
import type { NextFunction, Request, Response } from "express";
import {
  computePaidRequestDigest,
  decodeServiceAcknowledgementHeader,
  encodeServiceHeader,
  SERVICE_ACKNOWLEDGEMENT_HEADER,
  SERVICE_AUTHORIZATION_DOMAIN,
  SERVICE_AUTHORIZATION_HEADER,
  serviceAuthorizationDigest,
  signServiceAuthorization,
  verifyServiceAcknowledgementSignature,
  type UnsignedServiceAuthorizationV1,
} from "@virtual-haibin/evidence";
import { createServiceApp, SCENARIOS, type Scenario } from "./app.js";

// The service-side Virtual Haibin check runs BEFORE the payment gate. A fake
// gate records every request it sees: a refusal must leave it untouched,
// i.e. nothing is ever settled for an unauthorized paid request.

const authority = await generateKeyPair();
const authorityAddress = await getAddressFromPublicKey(authority.publicKey);
const rogue = await generateKeyPair();
const rogueAddress = await getAddressFromPublicKey(rogue.publicKey);
const service = await generateKeyPair();
const serviceAddress = await getAddressFromPublicKey(service.publicKey);

const PRICE = {
  network: "solana-payment-sandbox",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "6hqZufQGmDeGCHtiSNnGT246hdpdBUZTUzgKbonDXSTb",
  amountAtomic: "10000",
};
const TRANSACTION = "5je82fCJYDoNcyEeWzCwb9qeLFyw1WEXwLwuCPBp3LXmzt5wLxX3JewzjXs5HmwWW6aUSp2MYWcvU6j2E7hMpQYg";
const SUMMARIZE_A = '{"datasetId":"dataset-a","operation":"summarize"}';
const EXPORT_A = '{"datasetId":"dataset-a","operation":"export"}';

const settled: string[] = [];
let authorityKey: string | null = authorityAddress;
let server: Server;
let base: string;

function fakeGate(request: Request, response: Response, next: NextFunction): void {
  if (!request.get("payment-signature")) {
    response.status(402).json({ challenge: true });
    return;
  }
  settled.push(request.get("x-vh-invocation-id") ?? "?");
  next();
}

before(async () => {
  const app = createServiceApp({
    gates: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, fakeGate])) as Record<Scenario, typeof fakeGate>,
    paymentOf: () => ({ protocol: "x402", transaction: TRANSACTION }),
    serviceKey: { keyPair: service, address: serviceAddress },
    authorityKey: () => authorityKey,
    price: PRICE,
    feePayer: "fee-payer",
    log: () => {},
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  settled.length = 0;
  authorityKey = authorityAddress;
});

async function authorization(overrides: Partial<UnsignedServiceAuthorizationV1> = {}, signer = authority, body = SUMMARIZE_A) {
  const url = `${base}/api/v1/report`;
  const issuedAt = Date.now();
  return signServiceAuthorization(
    {
      version: 1,
      domain: SERVICE_AUTHORIZATION_DOMAIN,
      authority: await getAddressFromPublicKey(signer.publicKey),
      invocationId: "inv-1",
      grantId: "grant-1",
      request: { method: "POST", url, contentType: "application/json", requestSha256: computePaidRequestDigest({ method: "POST", url, contentType: "application/json", body }) },
      operationDigest: "a".repeat(64),
      payment: { ...PRICE },
      issuedAt,
      expiresAt: issuedAt + 120_000,
      ...overrides,
    },
    signer,
  );
}

function paid(body: string, headers: Record<string, string>) {
  return fetch(`${base}/api/v1/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": "credential", "x-vh-invocation-id": "inv-1", ...headers },
    body,
  });
}

test("an unpaid probe needs no authorization: the gate answers 402 with the public challenge", async () => {
  const response = await fetch(`${base}/api/v1/report`, { method: "POST", headers: { "content-type": "application/json" }, body: SUMMARIZE_A });
  assert.equal(response.status, 402);
  assert.deepEqual(settled, []);
});

test("a correctly authorized paid request is settled, fulfilled and acknowledged with the service key", async () => {
  const auth = await authorization();
  const response = await paid(SUMMARIZE_A, { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(auth) });
  assert.equal(response.status, 200);
  assert.deepEqual(settled, ["inv-1"]);

  const bytes = Buffer.from(await response.arrayBuffer());
  const ack = decodeServiceAcknowledgementHeader(response.headers.get(SERVICE_ACKNOWLEDGEMENT_HEADER) ?? "");
  assert.equal(await verifyServiceAcknowledgementSignature(ack, serviceAddress), true);
  assert.equal(await verifyServiceAcknowledgementSignature(ack, rogueAddress), false);
  assert.equal(ack.invocationId, "inv-1");
  assert.equal(ack.authorizationDigest, await serviceAuthorizationDigest(auth));
  assert.equal(ack.requestSha256, auth.request.requestSha256);
  assert.deepEqual(ack.received, { method: "POST", resource: "/api/v1/report", operation: "summarize", datasetId: "dataset-a" });
  assert.deepEqual(ack.payment, { transaction: TRANSACTION, asset: PRICE.asset, payTo: PRICE.payTo, amountAtomic: PRICE.amountAtomic });
  assert.equal(ack.result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(ack.result.bytes, bytes.byteLength);
});

const refusals: Array<{ name: string; reasonCode: string; status?: number; make: () => Promise<{ body: string; headers: Record<string, string> }> }> = [
  { name: "no authorization", reasonCode: "SERVICE_AUTHORIZATION_REQUIRED", make: async () => ({ body: SUMMARIZE_A, headers: {} }) },
  { name: "garbage authorization", reasonCode: "SERVICE_AUTHORIZATION_INVALID", make: async () => ({ body: SUMMARIZE_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: "not-base64url!" } }) },
  {
    name: "authorization signed by another (unpinned) authority",
    reasonCode: "SERVICE_AUTHORIZATION_INVALID",
    make: async () => ({ body: SUMMARIZE_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(await authorization({}, rogue)) } }),
  },
  {
    name: "authorized summarize, body substituted with export",
    reasonCode: "SERVICE_AUTHORIZATION_REQUEST_MISMATCH",
    make: async () => ({ body: EXPORT_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(await authorization()) } }),
  },
  {
    name: "authorization for another invocation",
    reasonCode: "SERVICE_AUTHORIZATION_REQUEST_MISMATCH",
    make: async () => ({ body: SUMMARIZE_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(await authorization({ invocationId: "inv-other" })) } }),
  },
  {
    name: "expired authorization",
    reasonCode: "SERVICE_AUTHORIZATION_EXPIRED",
    make: async () => ({ body: SUMMARIZE_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(await authorization({ issuedAt: 1_000, expiresAt: 2_000 })) } }),
  },
  {
    name: "authorized payment terms differ from the service's price",
    reasonCode: "SERVICE_AUTHORIZATION_PAYMENT_MISMATCH",
    make: async () => ({ body: SUMMARIZE_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(await authorization({ payment: { ...PRICE, amountAtomic: "5000" } })) } }),
  },
  {
    name: "tampered authorization (field changed after signing)",
    reasonCode: "SERVICE_AUTHORIZATION_INVALID",
    make: async () => {
      const auth = await authorization();
      return { body: SUMMARIZE_A, headers: { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader({ ...auth, payment: { ...auth.payment, payTo: "DS2xXiLQwn48Laj3XYvCMETqUGXsjBUcXRFTP6G3NYVr" } }) } };
    },
  },
];

for (const { name, reasonCode, make } of refusals) {
  test(`refused BEFORE settlement: ${name} -> 403 ${reasonCode}`, async () => {
    const { body, headers } = await make();
    const response = await paid(body, headers);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { reasonCode: string }).reasonCode, reasonCode);
    assert.deepEqual(settled, [], "the payment gate must not be reached");
    assert.equal(response.headers.get(SERVICE_ACKNOWLEDGEMENT_HEADER), null);
  });
}

test("without the authority trust root the service refuses paid requests (503) and settles nothing", async () => {
  authorityKey = null;
  const response = await paid(SUMMARIZE_A, { [SERVICE_AUTHORIZATION_HEADER]: encodeServiceHeader(await authorization()) });
  assert.equal(response.status, 503);
  assert.deepEqual(settled, []);
});

test("a malformed body is a 400 before any challenge or authorization", async () => {
  const response = await paid('{"operation":"delete","datasetId":"dataset-a"}', {});
  assert.equal(response.status, 400);
  assert.deepEqual(settled, []);
});
