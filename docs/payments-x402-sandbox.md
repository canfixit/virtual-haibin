# x402 settlement on the Pay.sh Solana Payment Sandbox

This document describes how Virtual Haibin (Phase 4) pays for an HTTP API with a real x402 payment, and exactly what that does and does not guarantee.

## Division of responsibility

| Layer | Provided by | What it does |
|---|---|---|
| Payment protocol + settlement rail | **Pay.sh / Solana Pay Kit** and the **x402** protocol | HTTP `402 Payment Required` challenge, x402 v2 `exact` scheme, SPL `TransferChecked` payment transaction, facilitator verification, fee payment and on-chain settlement |
| Delegated authority | **Virtual Haibin** | signed PurchasePermit, agent authentication, semantic policy (service, capability, network, asset, recipient, amount), durable budget, replay/conflict protection, reconciliation, decision receipts |

Virtual Haibin did not invent x402 and does not re-implement it. It decides **whether** an autonomous agent may use the rail for a particular payment.

## Exact integration

- **Protocol:** x402 v2 (`x402Version: 2`), scheme `exact` (fixed one-time payment) only. No MPP, sessions, subscriptions, `upto`, channels or custom programs.
- **Service side (`apps/service-agent`):** `@solana/pay-kit@0.12.0` (`createPayKit({ accept: ["x402"], network: "localnet", ... })`, `pay.express(gate)`), with its in-process x402 facilitator settling on the sandbox.
- **Authority side (`packages/payments`):** `@x402/core@2.27.0` (`x402Client`, `x402HTTPClient`: challenge parsing and `PAYMENT-SIGNATURE` encoding) and `@x402/svm@2.27.0` (`ExactSvmScheme`: builds and signs the transfer). These are the same pieces Pay Kit's own client uses. The authority does **not** use `PayKitClient.fetch`, because that re-fetches and auto-pays whatever challenge arrives under its own permission policy.
- **Environment:** Pay.sh **Solana Payment Sandbox**: hosted Surfpool test validator at `https://402.surfnet.dev:8899` (`surfnet-version` 1.4.0 at time of writing). No real funds.
- **Asset:** "sandbox USDC": mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, the mainnet USDC mint address *as cloned into the sandbox*. Sandbox tokens have no value.
- **Pay CLI** (`pay curl`) is not used anywhere in the payment path.

## The sandbox/mainnet ambiguity (read this)

Surfpool clones mainnet state, including its genesis hash. Its x402 challenges therefore advertise:

- `network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`, which is **mainnet's** CAIP-2 id
- `asset: "EPjFWdd5…Dt1v"`, which is the **mainnet USDC** mint address

**The challenge alone cannot cryptographically distinguish the Pay.sh sandbox from production Solana.** Virtual Haibin does not treat the challenge as proof of the settlement environment. The sandbox guarantee comes from the authority's trusted **settlement profile** (`packages/payments/src/settlement-profile.ts`):

1. The PurchasePermit names `network: "solana-payment-sandbox"`, a Virtual Haibin profile name, not a chain id. It is never aliased to mainnet.
2. The profile pins the RPC URL, the accepted challenge network ids, the allowed asset(s), the protocol/version and the scheme. All of these are authority configuration; none come from the agent, the service or the challenge.
3. At startup the authority refuses to run unless the pinned RPC identifies as Surfnet (`surfnet-version`) and issues Surfnet-only blockhashes (`SURFNETxSAFEHASH…`).
4. For every payment, the authority **discards** the service-supplied `extra.recentBlockhash` / `extra.lastValidBlockHeight` and binds the transfer to a blockhash it fetched from the pinned sandbox RPC. A transaction on a Surfnet blockhash cannot execute on any other chain.
5. The payment wallet is ephemeral, generated per authority process, and funded only through sandbox cheatcodes. It never holds mainnet funds.

Sandbox transactions are sandbox transactions. They are never described as mainnet or public-devnet settlements.

## Keys: four separate roles

| Key | Holder | Signs | Never |
|---|---|---|---|
| Permit issuer (human) | issuer (simulated in the agent process at demo startup) | PurchasePermit | payments |
| Agent identity | agent (ephemeral, non-extractable) | AuthorizationRequest | payments |
| Authority receipt key | authority (ephemeral) | Virtual Haibin decision receipts | payments |
| **Payment wallet** | **authority's payment provider only** (ephemeral, non-extractable, sandbox-funded) | the x402 `exact` transfer | leaves the provider, is logged, or is returned |

The agent, web app and paid service never receive the payment wallet key. There is no endpoint that signs caller-supplied transaction bytes.

## Flow

1. The agent signs an AuthorizationRequest (service, capability, network, mint, recipient, amount, invocation, permit digest, audience) with its identity key.
2. The authority verifies the permit and the agent signature. A known invocation is replayed or rejected from durable state **without contacting the service**.
3. If the signed request itself is not permitted, the request is denied without contacting the service.
4. The authority calls the **registry URL** for (service, capability). This is trusted configuration, never agent- or challenge-supplied. Redirects are never followed and response sizes are bounded.
5. The 402 `PAYMENT-REQUIRED` header is parsed with `x402HTTPClient`, then normalized strictly: x402 v2 only, canonical integer amount string, no floats.
6. The challenge is validated against:
   - the profile: scheme `exact`, accepted network id, allowed asset;
   - the configured resource: `resource.url` must match exactly;
   - the fee payer: present, and not the payment wallet;
   - the signed request: asset, payTo and amount must match exactly.

   Then, inside one SQLite transaction, the permit policy is evaluated against both the signed request and the **challenge's own** values, including the per-call cap and `reserved + consumed + amount <= maxTotal`. Any failure means DENY, and the payment signer is never invoked.
7. The budget is reserved in that same transaction, and the transaction is committed. No SQLite transaction is ever held open across HTTP or RPC calls.
8. The provider fetches a sandbox blockhash, builds the credential with `ExactSvmScheme`, then decodes the signed transaction and checks it before it leaves. It must contain only compute-budget, a single `TransferChecked` and a memo, and it must use our blockhash, the challenge's fee payer, and the exact amount and mint from the payer's token account to payTo's token account.
9. The payment attempt is written to durable state **before** transmission: payer, payer signature, blockhash, `lastValidBlockHeight`, and the payment facts.
10. The credential is sent on the paid retry. The service's Pay Kit facilitator verifies it, co-signs as fee payer, and submits it.
11. The facilitator's settlement report is treated as untrusted. The authority looks the transaction up on the **pinned RPC** by its own payer signature and checks every fact. Only then does it mark the invocation `CONFIRMED`: reserved becomes consumed, and the evidence and a bounded JSON result (plus its SHA-256) are stored.

## Failure classification

| When | Examples | Result |
|---|---|---|
| Service unreachable for its challenge | connection refused, 5xx, timeout | HTTP 502 `PAID_SERVICE_UNAVAILABLE`; nothing reserved or signed; same request may retry |
| Before the credential leaves | blockhash not from the sandbox, credential check failed, attempt could not be persisted | `PaymentNotSubmittedError` → `FAILED`, reservation released, same request may retry |
| After the credential leaves | timeout, connection reset, non-200, missing/unsuccessful settlement report, settlement not visible on the pinned RPC, crash | `RECONCILIATION_REQUIRED` (HTTP 409), reservation kept, **no automatic retry** |

## Reconciliation

Reconciliation runs at startup, every 15 s, and on `POST /reconcile` (bearer-protected). It is single-flight and **read-only toward the chain**: it never submits or re-submits a payment. For each `RECONCILIATION_REQUIRED` invocation with a recorded attempt, it searches the payer's history on the pinned RPC for the transaction carrying the payer's own signature. That transaction must match the payer, payTo's token account, mint, amount and blockhash.

- matching transaction, succeeded → `CONFIRMED`; reserved becomes consumed, exactly once
- matching transaction, failed on-chain → `FAILED`; reservation released
- no match and block height past `lastValidBlockHeight` + 20 blocks → `FAILED`; reservation released
- otherwise → stays `RECONCILIATION_REQUIRED`

### The pre-attempt crash window

Ordering invariant, enforced by code structure and tests:

```text
durable reservation (COMMIT)
  -> build + sign credential   (only pinned-RPC reads: blockhash, mint; no transaction bytes leave)
  -> validate the transaction  (validateExactPaymentTransaction, pure, fail-closed)
  -> durably record PaymentAttempt (guarded RESERVED -> RESERVED+attempt, COMMIT, synchronous=FULL)
  -> transmit credential       (the only point transaction bytes leave the authority)
```

`PaymentProvider.execute` documents this as a contract. `X402ExactPaymentProvider` transmits only after `beforeSubmit` has resolved, and throws `PaymentNotSubmittedError` without transmitting if it rejects (tested). The `@x402/svm` exact client itself never submits transactions. Startup recovery therefore decides atomically per `RESERVED` row:

- attempt recorded: the credential may have been sent → `RECONCILIATION_REQUIRED`, reservation kept
- no attempt recorded: the credential was provably never sent → `FAILED`, reservation released

`recordPaymentAttempt` only succeeds on a `RESERVED` row. If another process's recovery released the row first, an in-flight payment cannot record its attempt, and so it can never transmit (tested).

`RECONCILIATION_REQUIRED` rows with no recorded attempt cannot be created by Phase 4 code. Any that predate Phase 4 remain blocked for manual review.

## Trust assumptions

- **Pinned RPC honesty:** the sandbox RPC is trusted to report sandbox chain state truthfully. A lying RPC could misreport settlement. It cannot redirect funds, because the transfer is fixed and signed before submission.
- **Facilitator:** the service's Pay Kit facilitator is trusted only to submit the transaction. Its settlement report is re-verified on the pinned RPC. A facilitator that never submits leads to `RECONCILIATION_REQUIRED` and then `FAILED` after expiry.
- **Service output** is untrusted content. Payment settlement proves only that the payment happened, not that the service's result is correct.
- **Hosted sandbox availability** (`402.surfnet.dev`) is a third-party dependency for the demo.

## Dependency / supply-chain notes

- `@x402/*` is pinned to exact version 2.27.0. 2.28.0 was held back by pnpm's minimum-release-age policy, and that policy is not bypassed.
- `@solana/pay-kit` is pinned exactly (0.12.0). Its open-ended `@solana/kit` range is overridden to `^6.10.0`, the line its `@solana-program/*` dependencies and its own playground target.
- The payment packages use `@solana/kit` 6.x. Permit and identity code uses the modular `@solana/*` 8.x packages. The two exchange only address strings.
