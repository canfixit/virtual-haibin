# Human approval boundary and semantic operation authorization (Phase 4.5)

This document describes what Phase 4.5 adds on top of the x402 sandbox settlement path ([payments-x402-sandbox.md](payments-x402-sandbox.md)), how it is enforced, and what it does not prove.

## The claim

> A valid payment does not necessarily mean the agent was authorized to buy that operation.

Two agent requests can have **exactly the same payment terms**: same agent, merchant, `payTo`, asset, price and network. They can still mean different things. In the demo, the paid service exposes one endpoint, `POST /api/v1/report`, with a typed body:

| Request | Price | payTo / asset / network | Human approved? | Result |
|---|---|---|---|---|
| `{"operation":"summarize","datasetId":"dataset-a"}` | 10000 base units | identical | yes | **ALLOW**, sandbox settlement, result returned |
| `{"operation":"export","datasetId":"dataset-a"}` | 10000 base units | identical | no | **DENY `OPERATION_NOT_AUTHORIZED`**, no reservation, no service contact, no signing |
| `{"operation":"summarize","datasetId":"dataset-b"}` | 10000 base units | identical | no | **DENY `OPERATION_ARGUMENT_NOT_AUTHORIZED`**, no payment |

None of these denials depends on amount, recipient, asset, budget, replay or an invocation-ID conflict. Each uses a fresh invocation ID, and the receipt's reason codes contain only the semantic code.

## What a wallet spending policy already handles

A capable wallet or transaction policy can already restrict:

- the spending amount (per call / total)
- the recipient
- the asset / mint
- the transaction structure (programs, instructions)
- sometimes the endpoint being paid

Virtual Haibin enforces all of these too (Phases 1–4). It does not claim that wallets *cannot* implement semantic policy, or that human mandates are new. Protocols such as AP2 also model human authorization.

## What this phase adds

- **A human-approved application operation.** The human's signed PurchasePermit v2 names the exact business operation (`method`, `resource`, `operation`) and its business-relevant argument (`datasetId`).
- **An authenticated agent request for an operation.** The agent's signed AuthorizationRequest v2 names the operation it wants to buy. The authority compares it field by field with the human-signed one.
- **Exact operation → HTTP request → payment binding.** The authority builds the outbound HTTP request from the verified operation. It pays only for the exact request bytes that produced the x402 challenge.
- **A human approval boundary outside the agent runtime.** The issuer key lives in a separate process. The authority accepts permits only from that pinned issuer.

## Architecture

```text
Human (browser / terminal, holds the approval code)
   |
   |  POST /approvals {agent, operation, datasetId}   Authorization: Bearer <approval code>
   v
apps/approver  -- holds the issuer private key (approver_keys volume, mode 0600)
   |  signs PurchasePermit v2 (fixed terms + the human's chosen operation)
   v
browser relays the SIGNED PERMIT ONLY  ->  agent POST /permit
   |
   v
apps/agent  -- holds only its non-spending identity key
   |  signs AuthorizationRequest v2 (operation + payment terms + permit digest)
   v
apps/authority
   +-- verify PurchasePermit v2 signature
   +-- ISSUER ENTITLEMENT: issuer == pinned trusted issuer, network in its profiles
   +-- verify agent signature, audience, grant, permit digest, timestamp
   +-- exact operation check (method, resource, operation, datasetId)
   +-- payment checks (service, capability, network, mint, recipient, amount, expiry)
   +-- build outbound request from the verified operation
   +-- real x402 challenge for exactly that request; validate it
   +-- atomic budget reservation (SQLite)
   +-- re-derive outbound request from the durable record; must match
   +-- pay (provider refuses unless request digest == challenged request digest)
   v
paid service (Pay Kit x402 gate) -- receives exactly the verified operation
```

## Where the issuer private key lives

| Component | Issuer private key? | What it has instead |
|---|---|---|
| `apps/approver` | **yes**: `/keys/issuer-ed25519.seed` in the `approver_keys` volume (32-byte seed, mode 0600, created exclusively, loaded as a non-extractable WebCrypto key, seed buffer zeroed) | also `/keys/approval-code` |
| `apps/agent` | no | its own identity key; installed signed permits |
| web browser | no | the signed permit in transit, and the approval code the human typed (page memory only) |
| `apps/service-agent` | no | – |
| `apps/authority` / payment provider | no | the issuer **public** key, read-only from `issuer_trust:/trust/trusted-issuer` |
| Git / source tree | no | `approver_keys` is a Docker volume outside the `/workspace` bind mount |

The approver never logs or returns key material. It has no endpoint that signs caller-supplied bytes. The permit is assembled from the approver's fixed terms (service, capability, network, mint, recipient, limits, TTL, method, resource) plus the three fields the human chooses: agent, operation and dataset.

### Why there is an approval code

The approver sits on its own Docker network (`approval`). Its port is published only on host loopback (`127.0.0.1:4003`). On a Linux Docker Engine host that keeps other containers away from it. **On Docker Desktop it does not:** we verified that the agent container reaches the approver via `host.docker.internal:4003`. Network placement is therefore defense in depth only.

The actual gate is the **approval code**: 128 random bits, created on first start in the approver's private volume and never logged. Every `POST /approvals` must present it as a bearer token, compared in constant time. The agent cannot read the volume and has no Docker access, so it cannot get a permit even when it can reach the port (verified live: HTTP 401 `APPROVAL_CODE_REQUIRED`).

The human reads the code with:

```bash
docker compose exec approver cat /keys/approval-code
```

and pastes it into the web UI. This is a hackathon-grade human-presence check, not production IAM. A real issuer would approve on their own device, wallet or HSM.

## Issuer entitlement (trust root)

A cryptographically valid permit is not sufficient: anyone can generate a key and sign a well-formed permit. The authority therefore has an explicit trust relationship:

```text
trusted issuer public key  (/trust/trusted-issuer, read-only)
        -> may authorize spending from this authority's payment wallet
        -> only on settlement profile "solana-payment-sandbox"
```

`AuthorityService` checks this immediately after permit signature verification and before agent authentication or any state access. A permit signed by any other key fails with **403 `ISSUER_NOT_ENTITLED`**. So does a trusted issuer's permit for a profile outside its entitlement. In that case there is:

- no invocation row and no grant row
- no budget reservation
- no service contact (no 402 probe)
- no payment construction or signing

This holds even if the rogue permit reuses a legitimate `grantId`, names the same operation, or grants itself huge limits. A permit the agent signs with its own key is exactly this case. All of it is tested, and it was verified live (zero rows written).

Where the public key comes from: the approver publishes its public key (write + atomic rename) to the `issuer_trust` volume, which the authority mounts **read-only**. In a real deployment an operator provisions this file. The trust decision is authority configuration. It is never taken from a permit, a request or the agent. This is deliberately a single trusted issuer, not an issuer registry.

## Versioning: PurchasePermit v2, AuthorizationRequest v2, receipt v2

PurchasePermit v1 semantics are unchanged; v1 still validates, signs and verifies exactly as before. Phase 4.5 adds new versions rather than mutating v1:

| Object | v1 | v2 adds | Signed-bytes domain |
|---|---|---|---|
| PurchasePermit | Phase 1 fields | `operation: ExactOperationV1` | `virtual-haibin/purchase-permit:v2\n` + RFC 8785 JSON |
| AuthorizationRequest | Phase 2 fields | `operation: ExactOperationV1` | `virtual-haibin/authorization-request:v2\n` + RFC 8785 JSON |
| Authorization receipt | Phase 2 fields | `operation`, `operationDigest` | `virtual-haibin/authorization-receipt:v2\n` + RFC 8785 JSON |

The version is in the domain prefix, so a v1 signature never verifies as v2 and vice versa (tested both ways). The permit digest that requests bind to is also version-prefixed.

The authority now accepts **only v2** on the wire. A v1 permit binds no operation, so it fails closed: `PERMIT_INVALID` / `UNSUPPORTED_VERSION`. Durable rows written before Phase 4.5 keep their v1 request and get v1 receipts, so replay and reconciliation of old invocations still work.

## The exact operation (`ExactOperationV1`)

```ts
type ExactOperationV1 = {
  method: "POST";                        // only POST is valid
  resource: string;                      // absolute path, 1-8 segments of [A-Za-z0-9_-]; no query/fragment/dot segments
  operation: "summarize" | "export";     // business action
  datasetId: string;                     // lowercase [a-z0-9-], 1-64 chars
};
```

This is one concrete, typed operation, not a policy language. There are no wildcards, hierarchies or boolean expressions. Permit and request must match on every field.

**Security-relevant fields covered by the human signature:** `method`, `resource`, `operation` and `datasetId`, plus every v1 field (issuer, agent, service, capability, network, mint, recipient, per-call and total limits, issuance/expiry, grant ID, subdelegation=false).

**Unknown fields fail closed.** Inside `operation`, any key other than the four above is rejected at every boundary: permit validation (`INVALID_OPERATION`), request validation (HTTP 400), the approver (400) and the paid service (400). No unsigned argument can ride along. Unknown *top-level* permit fields are dropped and never signed or read, as in v1. Unknown top-level request fields are rejected, as in v1.

**Operation digest:** lowercase hex SHA-256 of `virtual-haibin/exact-operation:v1\n` + RFC 8785 canonical JSON of the normalized `{method, resource, operation, datasetId}`. It appears in the invocation fingerprint (so one invocation ID cannot be reused to switch operation) and in v2 receipts.

### Reason codes

| Code | Meaning |
|---|---|
| `ISSUER_NOT_ENTITLED` (HTTP 403, no receipt) | valid permit signature, but not from the pinned issuer or not for an entitled settlement profile |
| `OPERATION_NOT_AUTHORIZED` | requested `operation` ≠ human-approved `operation` |
| `OPERATION_ARGUMENT_NOT_AUTHORIZED` | requested `datasetId` ≠ human-approved `datasetId` |
| `OPERATION_RESOURCE_MISMATCH` | requested `resource` ≠ human-approved `resource` |
| `OPERATION_METHOD_MISMATCH` | requested `method` ≠ approved `method` (not reachable while the schema allows only POST; kept so a widened schema cannot silently allow it) |
| `OUTBOUND_REQUEST_MISMATCH` (HTTP 500) | the request about to be paid does not match the durably authorized operation; reservation released, nothing transmitted |
| `APPROVAL_CODE_REQUIRED` (approver, HTTP 401) | approval attempted without the human's approval code |

The semantic codes join the existing payment and policy codes in a single decision: a request with several problems lists all of them. A request whose only problem is the operation lists only the operation code.

## Agent request binding

The agent signs AuthorizationRequest v2 with its identity key. The signature covers the operation, the payment terms, the invocation ID, the permit digest, the audience and a timestamp. Changing the operation or `datasetId` in transit fails with `AGENT_SIGNATURE_INVALID` (tested). Changing it in the permit breaks the human's signature: `PERMIT_INVALID` / `INVALID_SIGNATURE` (tested).

## Outbound HTTP request binding

The agent never supplies request bytes. The authority uses design option **A**, with **B** as a cross-check:

1. **Construct.** `buildPaidRequest(resource, operation)` derives the request from the verified operation only: the URL from the trusted registry (`(service, capability)` → URL, whose method and path must equal the operation's), `method = operation.method`, and body = canonical JSON `{"datasetId":…,"operation":…}`. The resulting `PaidRequest` is frozen and carries `sha256` = SHA-256 of `virtual-haibin/paid-request:v1\n` + JSON `[method, url, contentType, body]`.
2. **Bind the challenge.** The unpaid 402 probe sends exactly this request. The parsed challenge records the request digest, and challenge validation requires it to equal the request's digest.
3. **Re-derive before paying.** Right before payment, the authority rebuilds the expected request from the **durably stored, authenticated** request and requires identical bytes. Otherwise the result is `OUTBOUND_REQUEST_MISMATCH`, the reservation is released and nothing is sent.
4. **Provider refusal.** `PaymentProvider.execute` recomputes the digest of the request it is about to send and refuses (`PaymentNotSubmittedError`, nothing signed or transmitted) unless it equals the challenged request's digest. The paid retry is therefore byte-identical to the probe.
5. **Evidence.** `PaymentAttempt.requestSha256` is persisted before transmission and returned as `payment.requestSha256`. The service echoes what it received (`result.received`).

So the authority cannot authorize operation A and transmit operation B. Mutation tests confirm that each layer is load-bearing (see the Phase 4.5 report).

## The x402 boundary

An x402 `exact` challenge describes payment terms and the resource URL. In this flow it does not tell the authority *which business operation in the request body* the payment is for, and Virtual Haibin does not expect it to. That is not a claim that x402 can never carry request semantics. Virtual Haibin itself binds:

```text
human-signed operation (PurchasePermit v2)
  + agent-signed operation (AuthorizationRequest v2)
  + the exact outbound HTTP request (built from the verified operation)
  + the x402 challenge for exactly that request (digest-bound)
```

The blockchain does not enforce the semantic operation. A sandbox transaction proves only that a payment of the stated amount to the stated recipient settled.

## Trust roots and remaining assumptions

- **Issuer trust root (implemented):** the pinned issuer public key file, provisioned out-of-band (here: by the approver, through a read-only volume).
- **Authority receipt key:** since Phase 5 this key is persistent: created once in the authority-only volume and published as a public key for verifiers to pin. **A receipt cannot establish trust by embedding its own public key**, because anyone can sign a well-formed receipt with a key they chose. The standalone verifier compares `receipt.authority` and `manifest.authority` against the independently pinned key. See [evidence-and-verification.md](evidence-and-verification.md).
- **Approver host trust:** whoever can run `docker compose exec approver …` (the human/operator) can read the approval code and, with effort, the seed. That is the intended holder.
- **Bearer transport secret:** `AUTHORITY_SHARED_SECRET` sits in `.env`, which is inside the bind-mounted source tree, so every repo-mounting container can read it. It only authenticates transport. The agent's signature and the issuer entitlement carry the authority.
- **Service truthfulness:** the service echoes the operation it received. That echo is the service's own claim, not proof that the output is correct.
- **Agent permit installation:** `POST /permit` on the agent is unauthenticated. Installing a permit cannot widen authority (signature, issuer entitlement and agent binding are all enforced by the authority), but a local caller could replace the agent's installed permit (denial of service).

## Running the demo

UI: open `http://localhost:5173`, paste the approval code, click **Approve “Summarize dataset-a”**, then **Run approved operation**, **Try unauthorized export** and **Try summarize dataset-b**.

Scripted (structured JSON transcript for the judge demo):

```bash
docker compose run --rm \
  -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" \
  demo-driver node scripts/semantic-demo.mjs
```

`demo-driver` is a tools-profile container on both networks. It stands in for the human's browser, which is why it can reach the approver while the agent cannot.

## Deliberately not generalized

There is one operation schema (report: summarize/export by dataset), one trusted issuer, one paid service, one settlement profile and exact-match comparison only. There is no policy DSL, capability language, issuer registry, key rotation, AP2 layer, MPP, mainnet, devnet migration or custom Solana program.
