# Portable evidence and the standalone verifier (Phase 5A/5B)

> The bundle lets an independent verifier check the signatures and consistency connecting a trusted human issuer, authorized agent request, Virtual Haibin decision, selected payment, observed settlement and result digest.

It does not make Virtual Haibin trustless. It does not prove that the authority behaved honestly on other invocations. It does not prove that the human understood the permit, and it does not prove the service's answer is correct. The verifier reports these limits explicitly.

## The demo

```text
human approves summarize(dataset-a) -> agent buys it on the Pay.sh sandbox
        -> GET /evidence/<invocationId>  (EvidenceBundleV1)
        -> docker compose stop authority
        -> standalone verifier: no network, pinned trust roots   -> VALID
        -> tamper operation / amount / recipient / settlement     -> INVALID
        -> verifier --online (sandbox RPC, authority still down)  -> settlement VERIFIED
```

Run it (host needs only bash + Docker; the stack must be up):

```bash
./scripts/evidence-demo.sh
```

Or step by step:

```bash
docker compose run --rm -T --user "$(id -u):$(id -g)" \
  -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" \
  demo-driver node scripts/export-evidence.mjs          # writes .evidence/<id>.json
docker compose stop authority
docker compose run --rm verifier verify .evidence/<id>.json \
  --issuer-trust /trust/issuer/trusted-issuer --authority-trust /trust/authority/authority.pub --offline
docker compose run --rm verifier-online verify .evidence/<id>.json \
  --issuer-trust /trust/issuer/trusted-issuer --authority-trust /trust/authority/authority.pub --online
```

The `verifier` container runs with `network_mode: none`, mounts the repository and dependencies **read-only**, and mounts only the two *public* trust files. It has no authority, database, agent, approver, service, payment key or issuer key. The CLI exits 0 for VALID, 1 for INVALID, 2 for INDETERMINATE and 64 for usage errors.

## Trust roots (from verifier configuration, never from the bundle)

| Root | Private key lives | Public key the verifier pins |
|---|---|---|
| Human issuer | approver-only `approver_keys` volume | `--issuer-trust` (the demo uses the `issuer_trust` volume, read-only) |
| Virtual Haibin authority receipt key | authority-only `authority_data` volume (`authority-receipt-ed25519.seed`, mode 0600, created once, loaded non-extractable, never logged or served) | `--authority-trust` (the demo uses the `authority_trust` volume, read-only) |

The four keys are distinct: issuer, agent identity, authority receipt key and payment wallet.

A bundle names keys: `purchasePermit.issuer`, `manifest.authority` and `authorityDecision.authority`. The verifier uses a named key **only if it equals the pinned key**. A bundle that an attacker signs with their own authority key, even a fully internally consistent one, is INVALID under the real pinned key. It verifies only if the verifier is explicitly configured to trust the attacker's key (tested).

The authority receipt key persists across restarts, so evidence exported before a restart still verifies. Keys are not rotated and there is no PKI. In the demo the public keys reach the verifier through Docker volumes. In practice the operator would provision them out-of-band.

## EvidenceBundleV1

This format is specific to this MVP, not a general receipt standard. Every field holds a public protocol object, never a database row:

```text
version: 1, domain: "virtual-haibin/evidence-bundle"
environment.settlementProfile        "solana-payment-sandbox"
identifiers { grantId, invocationId }
purchasePermit                        human-signed PurchasePermit v2 (exact operation)
authorizationRequest { request, agentSignature }   agent-signed AuthorizationRequest v2
authorityDecision                     authority-signed receipt v2 (DENIED/CONFIRMED), else null
outboundRequest { method, url, contentType, body, sha256 }  the exact HTTP request the authority sent
paymentRequirement                    the selected x402 `exact` requirement
paymentAttempt                        payer, payer signature, blockhash, request digest, and the
                                      signed wire transaction (transactionBase64)
settlement { transactionId, slot, ... }   the authority's settlement report (CONFIRMED only)
result { httpStatus, contentType, bodyBase64, bytes, sha256 }   exact response bytes as observed
manifest                              authority-signed EvidenceManifestV1 (below)
```

There are no secrets, keys, approval codes or bearer tokens (tested).

### Signed manifest (`virtual-haibin/evidence-manifest:v1`)

The manifest is RFC 8785 canonical JSON with a domain prefix, signed with Ed25519 by the persistent authority key. It binds:

- `authority` (signer key id), `issuedAt`, `settlementProfile`, `grantId`, `invocationId`
- `purchaseState` (`CONFIRMED | DENIED | FAILED | RECONCILIATION_REQUIRED`), `decision`, `reasonCodes`
- `digests` of every artifact:
  - `purchasePermit`: the same permit digest the agent's request binds to
  - `operation`: the exact-operation digest
  - every other artifact: SHA-256 of `virtual-haibin/evidence-artifact:<name>:v1\n` plus its canonical JSON (`null` when absent)

The verifier **recomputes every digest** from the bundled artifacts. It never accepts a manifest digest without recomputing it.

## What the verifier checks

### Offline (no I/O at all)

| Claim | Status when good | What is checked |
|---|---|---|
| `bundle_format` | VERIFIED | strict schema: bounded size, strings and arrays; any unknown field anywhere rejects the bundle |
| `issuer_trusted` | VERIFIED | permit issuer equals the pinned issuer |
| `authority_trusted` | VERIFIED | manifest and receipt authority equal the pinned authority |
| `manifest_signature` | VERIFIED | Ed25519 signature by the pinned authority key |
| `artifact_digests` | VERIFIED | every artifact re-hashes to its manifest digest |
| `state_consistent` | VERIFIED | identifiers and settlement profile agree across artifacts; the artifacts present fit the state |
| `permit_signature` | VERIFIED | PurchasePermit v2 signature and schema |
| `agent_request_signature` | VERIFIED | request signed by the permit's `authorizedAgent` |
| `request_bound_to_permit` | VERIFIED | `request.permitDigest` equals the recomputed permit digest |
| `authority_decision_signature` | VERIFIED | signed receipt by the pinned authority; its fields equal the signed request, operation and settlement reference |
| `permit_time_bounds`, `service_capability_match`, `network_profile_match`, `mint_match`, `recipient_match`, `per_call_limit`, `method_resource_match`, `operation_matches_permit`, `operation_arguments_match` | VERIFIED | static policy re-evaluated with the same policy code. Time bounds are checked against the agent-signed `request.issuedAt` |
| `decision_matches_static_policy` | VERIFIED | ALLOW ⇒ no static violation. DENY ⇒ the recomputed violations are among the authority's reasons |
| `settlement_profile_match` | VERIFIED | x402 v2 `exact`, accepted challenge network, allowed asset, and a blockhash of the profile's environment |
| `x402_asset_matches`, `x402_recipient_matches`, `x402_amount_matches` | VERIFIED | x402 requirement == signed request == permit, and amount ≤ per-call limit |
| `outbound_request_matches_operation` | VERIFIED | POST body and path re-derived from the signed operation; digest recomputed; the payment attempt pays for exactly that request |
| `payment_attempt_matches_requirement` | VERIFIED | attempt facts equal the selected requirement |
| `payment_transaction` | VERIFIED | the signed wire transaction is exactly one `TransferChecked` of that amount and mint from the payer's to payTo's token account, on the recorded blockhash, and the payer's Ed25519 signature verifies over the transaction message |
| `result_digest` | VERIFIED | bundled result bytes hash to the recorded SHA-256 |

### Online (`--online`): settlement observation

Online mode only queries the RPC named by the verifier's own `--rpc` flag (default: the Pay.sh sandbox). It never uses a URL from the bundle and never contacts the authority. It checks:

- the RPC identifies as the sandbox (`surfnet-version`)
- `getTransaction(settlement.transactionId)` succeeded on-chain
- the transaction carries the payer's signature, uses the recorded blockhash, and contains the `TransferChecked` with the expected payer, mint, payTo token account and amount

This is the same check the authority uses for reconciliation (`checkSettledTransaction`).

| Outcome | `settlement` |
|---|---|
| observed and every fact matches | VERIFIED |
| wrong facts, failed transaction, wrong signature | INVALID |
| RPC unreachable, transaction not visible, RPC is not the sandbox | INDETERMINATE |

## Status vocabulary

| Status | Meaning |
|---|---|
| `VERIFIED` | checked by the verifier from the bundle and pinned trust (plus the RPC, online) |
| `INVALID` | checked and wrong: the evidence is not acceptable |
| `NOT_SATISFIED` | a policy condition does not hold, consistently with an authority DENY (e.g. `operation_matches_permit` in a denied-export bundle) |
| `AUTHORITY_ATTESTED` | supported only by the pinned authority's signed statement |
| `SERVICE_ATTESTED` | supported by the paid service's own signed statement, verified against the pinned service key (see Phase 5C below) |
| `NOT_CHECKED` | not applicable to this bundle or mode |
| `NOT_PROVABLE_FROM_BUNDLE` | cannot be established from one bundle, by design |
| `INDETERMINATE` | could not be decided (RPC unavailable, outcome not final) |

`overall: VALID` means every **required** claim is VERIFIED and no claim is INVALID. It does not mean that every business or security property is proven.

## Independently verified, attested, and not provable

**Independently verified (offline):**
- the human issuer's signature over the exact operation
- the agent's signature over the request
- the binding between the request and that permit
- the authority's signature over the decision and manifest
- that the decision is consistent with every static policy constraint
- that the x402 requirement, payment attempt, signed transfer and outbound request all match the signed request
- that the result bytes match their digest

**Independently verified (online):** that the transfer actually settled on the sandbox with the expected payer, mint, recipient and amount.

**Authority-attested:**
- the settlement report, when offline
- that the result is the one the service returned to the authority
- the total-budget decision: `reserved + consumed + amount ≤ maxTotal` was evaluated against the authority's durable state, which is not in the bundle
- the reasons for a DENY that are not static (budget, challenge problems)
- that the payer wallet belongs to the authority

**Service-attested (Phase 5C, with `--service-trust`):** the pinned service signed that it:
- accepted this authority authorization
- received exactly this request and operation
- was paid by this transaction
- returned exactly these result bytes

The signature is cryptographically VERIFIED. What the service *asserts* about producing the result is SERVICE_ATTESTED, and whether the result is correct remains NOT_PROVABLE.

**Not provable from one bundle** (printed with every report):
- that the human understood the permit
- that the authority never bypassed policy on some other invocation
- the grant's complete global budget history
- that no other payment was made for the same intent outside this invocation
- that the service's returned information is factually correct
- that the recipient consumed the result
- that the configured RPC is honest (it is trusted, not trustless)

## States

| State | Bundle contains | Verifier |
|---|---|---|
| CONFIRMED | everything | payment, result and settlement claims required; settlement AUTHORITY_ATTESTED offline, VERIFIED online |
| DENIED | permit, request, signed DENY receipt (+ requirement if the challenge was fetched) | static violations NOT_SATISFIED; `decision_matches_static_policy` VERIFIED (or AUTHORITY_ATTESTED for non-static reasons); payment NOT_CHECKED |
| RECONCILIATION_REQUIRED | permit, request, requirement, attempt (with transaction) | settlement **INDETERMINATE** (never reported as confirmed); a settlement smuggled into such a bundle is INVALID |
| FAILED | permit, request, requirement, attempt if any | settlement NOT_CHECKED |

## Export

`GET /evidence/<invocationId>` on the authority:

- requires the existing transport bearer token
- validates the invocation ID (`[A-Za-z0-9_.:-]{1,128}`) and reads exactly one invocation; there is no query surface
- returns RFC 8785 canonical JSON, at most 512 KiB
- refuses with 404 `INVOCATION_NOT_FOUND`, 409 `EVIDENCE_NOT_FINAL` (still RESERVED) or 409 `EVIDENCE_UNAVAILABLE`

`EVIDENCE_UNAVAILABLE` covers invocations recorded before evidence capture: SQLite schema v3 now stores the signed permit and the agent signature with each invocation, and payment attempts and results now keep the signed transaction and the exact response bytes.

## Hostile-input controls (verifier)

- 512 KiB bundle limit
- exact key sets at every level (unknown fields fail closed)
- bounded strings and arrays
- base58, hex and base64 format checks
- explicit copies; no dynamic evaluation
- no URL or file reference in the bundle is ever followed
- the RPC URL comes only from the verifier's flags; the RPC client refuses redirects and responses over 256 KiB
- malformed JSON becomes `bundle_format: INVALID`, never an uncaught exception

## Limitations

- **One pinned key per role.** There is no key rotation or revocation. If the authority receipt key is lost (`docker compose down -v`), older bundles still verify against the old public key, but only if the verifier kept it.
- **Payer identity is attested.** The payment wallet is ephemeral per authority process. The bundle proves that *this* payer signed *this* transfer, but that the payer is Virtual Haibin's wallet is authority-attested.
- **Mainnet-looking identifiers.** Sandbox challenges carry mainnet's CAIP-2 id and the USDC mint address. The environment claim rests on the sandbox blockhash prefix and, online, on the RPC identifying as Surfnet.
- **Result integrity, not result truth.** The authority's manifest binds the result bytes. With a pinned service key, the service's own signature binds them too (Phase 5C). Neither proves the content is correct.
- **Service trust is pinned, not discovered.** The service's acknowledgement counts only against a service key the verifier pinned. Without `--service-trust`, the service claims are NOT_CHECKED.

## Phase 5C: service-side verification and the service acknowledgement

Before Phase 5C the paid service accepted any valid x402 payment. A Virtual Haibin-integrated service now also checks that **this paid request was authorized by the Virtual Haibin authority it pins**, and it signs what it did.

```text
authority ── paid retry + x-vh-authorization: ServiceAuthorizationV1 ──▶ service
                (authority-signed: invocation, exact request digest,
                 operation digest, payment terms, 120 s validity)
                                                     │ BEFORE its x402 gate settles:
                                                     │  - signed by the pinned authority key?
                                                     │  - unexpired?
                                                     │  - exactly the received method/path/body bytes?
                                                     │  - same invocation id?
                                                     │  - exactly this service's price/payTo/asset?
                                                     │  any failure -> 403, nothing settled
authority ◀── 200 + x-vh-service-acknowledgement: ServiceAcknowledgementV1 ──
                (service-signed: accepted authorization digest, received request digest,
                 performed operation, payment transaction, result SHA-256 and size)
```

- **Authorization, authority side.** `ServiceAuthorizationV1` is signed by the authority's persistent key. It is sent only on the paid retry, never on the public 402 probe, and it is stored with the payment attempt *before* the credential is transmitted.
- **Rejection, service side.** If the service rejects the authorization, the authority sees a failure after transmission. The invocation becomes `RECONCILIATION_REQUIRED` and is never retried. Reconciliation then finds nothing settled and releases it. Payment and reconciliation semantics are unchanged.
- **Acknowledgement.** `ServiceAcknowledgementV1` is signed with the service's own persistent key, held in the service-only `service_keys` volume; its public key is published to `service_trust`. The authority pins that key and keeps an acknowledgement only if every field matches what it sent and received. A missing or invalid acknowledgement is logged and dropped. It never changes the payment outcome, because the payment has already settled.
- **Evidence.** EvidenceBundleV2 / manifest v2 add `serviceAuthorization` and `serviceAcknowledgement`, both covered by the manifest digests. EvidenceBundleV1 bundles still verify.

### Verifier claims (SERVICE)

| Claim | Requires | Meaning |
|---|---|---|
| `service_authorization` | pinned authority | the authority's authorization covers exactly the bundled outbound request, operation and x402 terms |
| `service_trusted` | `--service-trust` | the acknowledgement names the pinned service key |
| `service_acknowledgement` | `--service-trust` | signature by the pinned service key, and every field (authorization digest, request digest, operation, payment terms, settlement transaction, result SHA-256 and size) matches the bundle. This is checked even when the authority vouched for the acknowledgement |
| `service_result_attestation` | `--service-trust` | **SERVICE_ATTESTED**: the service asserts it produced exactly this result for this paid request |
| `result_correctness` | — | always **NOT_PROVABLE_FROM_BUNDLE** |

With `--service-trust`, a CONFIRMED v2 bundle without a valid acknowledgement is INVALID. Without it, the service claims are NOT_CHECKED and the overall result is unaffected.

### Not proven, even with the service signature

- that the service's answer is correct
- that the service did not also serve the same result elsewhere
- that a service which does not verify `x-vh-authorization` would refuse unauthorized payers: this is a property of *integrated* services, not of x402
