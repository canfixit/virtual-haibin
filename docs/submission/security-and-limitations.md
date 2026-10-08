# Security model and limitations

Virtual Haibin is a **hackathon prototype**. It is **not audited**, not production-ready, and has not run on Solana mainnet. All settlement in this repository happens on the **Pay.sh Solana Payment Sandbox**, a hosted Surfpool test validator whose tokens have no value.

This page summarizes the security properties and their limits for judges and reviewers. The detailed trust models are in:

- [payments-x402-sandbox.md](../payments-x402-sandbox.md) (settlement, keys, reconciliation)
- [human-approval-and-semantic-authorization.md](../human-approval-and-semantic-authorization.md) (permits, issuer entitlement, operation matching)
- [evidence-and-verification.md](../evidence-and-verification.md) (what the evidence proves)
- [judge-demo-ui.md](../judge-demo-ui.md) (demo session scoping)

## What is enforced, and where

| Property | Enforced by | Notes |
|---|---|---|
| The agent cannot pay | Process separation | The agent holds only a non-spending identity key. The payment wallet lives in the authority. |
| The agent cannot create or widen a permit | Ed25519 signature over RFC 8785 canonical JSON, domain-separated and versioned | Any change to a signed field fails verification (one tamper test per field). |
| Only the trusted human issuer can grant spending | Pinned issuer public key | Otherwise `ISSUER_NOT_ENTITLED`. |
| The caller is the agent named in the permit | Agent-signed `AuthorizationRequest v2` | The transport bearer secret is never treated as identity. |
| Exact operation and argument | Authority, exact match | `OPERATION_NOT_AUTHORIZED`, `OPERATION_ARGUMENT_NOT_AUTHORIZED`. |
| Merchant payment terms match the permit | Authority validates the real x402 402 challenge | Covers recipient, asset/mint, amount (per-call), settlement profile. |
| The authority signs only a transaction it built | Authority constructs the x402 `exact` transfer | Uses its own sandbox blockhash. It never signs agent-supplied bytes. |
| Total budget, no double spend | SQLite transaction: atomic reserve/consume, unique invocation | Survives restarts. Concurrency is tested. |
| Replay | Durable invocation records | Same request returns the stored result. A different request with the same ID gets `INVOCATION_CONFLICT`. |
| No double payment after a timeout | `RECONCILIATION_REQUIRED` with **no automatic retry** | Resolved read-only against the sandbox (`CONFIRMED` or `FAILED`). |
| The merchant does not settle unvouched requests | Service checks the authority-signed `x-vh-authorization` **before** its Pay Kit gate settles | Otherwise `403 SERVICE_AUTHORIZATION_REQUIRED`, and nothing is settled. |
| Evidence integrity | Authority-signed manifest plus service acknowledgement | Verified offline against pinned public keys. |
| Demo visitors cannot use each other's permit or evidence | Per-page 256-bit session capability (stored as SHA-256) | Applies to the demo API only. It is not user authentication. |

## Current limitations

- **Sandbox only.** The single settlement profile is `solana-payment-sandbox`. Sandbox x402 challenges carry mainnet's CAIP-2 id and the mainnet USDC mint address, because Surfpool clones mainnet. The environment guarantee comes from the authority's pinned RPC and its Surfnet-only blockhash, not from the challenge. There is no devnet or mainnet path.
- **One issuer, one authority, one merchant.** Trust roots are single pinned public keys distributed through Docker volumes. There is no discovery, no key rotation and no revocation.
- **Demo-grade custody.**
  - The issuer key is a seed file in the approver's private volume, and approval is gated by a 128-bit approval code. This is not a wallet, HSM or IAM integration.
  - The authority's receipt key and the service key are persistent seed files on their own volumes.
- **Ephemeral payment wallet.** A new wallet is created per authority process and funded with sandbox cheatcodes. That a given payer belongs to Virtual Haibin is authority-attested.
- **Ephemeral agent identity.** After an agent restart, the human must approve a new permit for the new identity.
- **SQLite, single node.** No replication or backup. Startup recovery assumes one authority process.
- **RPC trust.** The pinned sandbox RPC is trusted to report chain state honestly. A lying RPC could misreport settlement, but it cannot redirect funds, because the transfer is fixed and signed before submission.
- **Third-party availability.** The hosted sandbox (`402.surfnet.dev`) and its facilitator occasionally time out. The result is `RECONCILIATION_REQUIRED`: correctly blocked, never auto-retried. CI separates these external failures from product regressions.
- **Semantic enforcement is off-chain.** The authority and the merchant check the operation. The Solana transaction itself does not encode `summarize` or `export`. There is no custom on-chain program.
- **Narrow policy.** There is one operation schema (`summarize` or `export` by `datasetId`) with exact matching. There is no policy language.
- **Dev transport secret.** Agent-to-authority transport uses a shared bearer secret from the gitignored `.env`. Every container that mounts the repository can read it. It authenticates transport only.
- **Local networking.** On Docker Desktop, other containers can reach host-published ports through `host.docker.internal`. Localhost binding is defense in depth, not isolation. This is why approval requires the approval code.

## What the evidence does not prove

The verifier labels each claim as `VERIFIED`, `AUTHORITY_ATTESTED`, `SERVICE_ATTESTED`, `NOT_PROVABLE_FROM_BUNDLE`, and so on. In particular:

- It does **not** prove that the human understood the permit they approved.
- One bundle does **not** establish the grant's global budget history, or that the authority never bypassed policy on another invocation.
- A service attestation is **not** factual correctness. The service signs what it returned, not that the result is true.
- Offline verification does **not** prove live settlement. Offline, settlement is authority-attested. `--online` observes it on the sandbox RPC, which is trusted rather than trustless.
- Sandbox settlement is **not** mainnet settlement.

## Security review status

No independent security audit has been performed. Virtual Haibin is a hackathon MVP operating on the Pay.sh Solana Payment Sandbox with no real funds.

## Never commit

`.env`, approval codes, issuer, authority or service seeds, payment-wallet keys, `*.db` files, `.evidence/` bundles. The `.gitignore` covers `*.seed`, `.env*`, `*.db*`, `approval-code` and `.evidence/`.
