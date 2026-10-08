# Virtual Haibin — Architecture

Two views of the same system:

1. **Judge view.** What happens, in one picture.
2. **Developer view.** Which process holds which key and checks what, in which order.

Colours follow the CanFixIT demo UI:

- **Blue:** human approval
- **Red:** an attempted violation that is blocked
- **Purple:** Virtual Haibin enforcement and verification

> **Environment.** Settlement runs on the **Pay.sh Solana Payment Sandbox** (a hosted Surfpool test validator). The tokens there have no value. This is **not** Solana mainnet or devnet.

---

## 1. Judge view

```mermaid
flowchart LR
    H["Human<br/>approves summarize(dataset-a)"]:::blue
    A["AI agent<br/>no wallet · no signing key"]:::neutral
    VH{"Virtual Haibin authority<br/>Is this the exact operation<br/>the human approved?"}:::purple
    S["Paid API<br/>checks Virtual Haibin's<br/>authorization first"]:::neutral
    SOL[("Solana Payment Sandbox<br/>x402 settlement · sandbox USDC")]:::neutral
    E["Signed evidence<br/>checked by a separate verifier"]:::purple
    X["BLOCKED<br/>no request · no signature · no payment"]:::red

    H -- "signed permit" --> A
    A -- "summarize(dataset-a)" --> VH
    A -. "export(dataset-a)<br/>same price" .-> VH
    VH -- "yes" --> S
    S -- "settles" --> SOL
    SOL --> E
    VH -. "no" .-> X

    classDef blue fill:#2563eb,stroke:#1e40af,color:#ffffff
    classDef red fill:#dc2626,stroke:#991b1b,color:#ffffff
    classDef purple fill:#9333ea,stroke:#6b21a8,color:#ffffff
    classDef neutral fill:#f9fafb,stroke:#6b7280,color:#111827
```

In one sentence: the agent can ask to buy anything, but only the authority can pay. The authority pays only for the exact operation the human signed for, and the merchant refuses payment unless the authority vouched for that exact request.

---

## 2. Developer view

### Processes, keys and trust

| Process (Compose service) | Holds | Never holds |
|---|---|---|
| `approver` (own `approval` network, `127.0.0.1:4003`) | Issuer Ed25519 key and the human approval code (`approver_keys` volume) | Payment keys |
| `agent` (`:4000`) | A non-spending Ed25519 **identity** key: non-extractable, fresh per process | Any wallet or payment key, the issuer key, the RPC URL |
| `authority` (`:4002`) | x402 payment wallet (ephemeral), persistent receipt key, SQLite state (`authority_data` volume), pinned issuer and service public keys | The issuer private key |
| `service-agent` (`:4001`, mock paid API) | Its own acknowledgement key (`service_keys`), pinned authority public key, Pay Kit facilitator operator | Any Virtual Haibin private key |
| `verifier` / `verifier-online` / `verifier-api` | **Public** trust roots only (read-only) | Any private key. It has no route to the authority. |
| `web` (`:5173`) | Nothing. It holds a per-page session capability in memory only. | Keys, the approval code at rest |

### Sequence: authorized purchase, and the blocked one

```mermaid
sequenceDiagram
    autonumber
    actor Human
    participant Approver as Approver<br/>(issuer key)
    participant Agent as Agent<br/>(identity key only)
    participant Authority as Authority<br/>(payment wallet, SQLite)
    participant Service as Paid API<br/>(Pay Kit x402 gate)
    participant Sandbox as Solana Payment Sandbox<br/>(RPC + facilitator)
    participant Verifier as Standalone verifier<br/>(pinned public keys)

    rect rgba(37, 99, 235, 0.12)
    Note over Human,Approver: Blue — human approval
    Human->>Approver: approval code + "summarize(dataset-a)" for agent X
    Approver-->>Human: PurchasePermit v2 (Ed25519, RFC 8785 canonical JSON)<br/>binds agent, service, method, resource, operation, datasetId,<br/>network, mint, recipient, per-call and total limits, expiry
    Human->>Agent: install signed permit (agent cannot create or widen one)
    end

    rect rgba(147, 51, 234, 0.12)
    Note over Agent,Sandbox: Purple — enforcement for summarize(dataset-a)
    Agent->>Authority: AuthorizationRequest v2, signed by agent identity key
    Authority->>Authority: verify permit signature + pinned issuer<br/>verify agent signature = permit.authorizedAgent<br/>exact operation + argument match, expiry
    Authority->>Service: unpaid probe of the request built from the verified operation
    Service-->>Authority: HTTP 402 x402 challenge (exact: asset, payTo, amount)
    Authority->>Authority: challenge ⊆ permit (network profile, mint, recipient, amount ≤ per-call)<br/>atomic budget reservation + invocation uniqueness (SQLite)
    Authority->>Authority: build + sign the x402 "exact" SPL transfer itself<br/>(blockhash from pinned sandbox RPC)
    Authority->>Service: paid retry: payment-signature + x-vh-authorization<br/>(authority-signed, bound to method, path, body hash, price)
    Service->>Service: verify x-vh-authorization against pinned authority key<br/>BEFORE the payment gate (else 403, never settled)
    Service->>Sandbox: Pay Kit facilitator verifies + settles
    Sandbox-->>Service: transaction signature
    Service-->>Authority: result + ServiceAcknowledgementV1 (signed: operation, tx, result hash)
    Authority->>Sandbox: confirm settlement on pinned RPC
    Authority->>Authority: CONFIRMED · signed receipt · EvidenceBundleV2
    Authority-->>Agent: ALLOW + result
    end

    rect rgba(220, 38, 38, 0.12)
    Note over Agent,Authority: Red — export(dataset-a), same price, fresh invocation
    Agent->>Authority: AuthorizationRequest v2 (operation = export)
    Authority-->>Agent: DENY OPERATION_NOT_AUTHORIZED<br/>no reservation · no service contact · no signature · no payment
    end

    rect rgba(147, 51, 234, 0.12)
    Note over Verifier: Authority may be stopped
    Agent->>Verifier: exported EvidenceBundleV2 (file)
    Verifier->>Verifier: offline: all signatures, digests, permit ⊇ request ⊇ payment
    opt online
        Verifier->>Sandbox: observe the transaction on the sandbox RPC
    end
    Verifier-->>Human: VALID / INVALID + per-claim status<br/>(VERIFIED, AUTHORITY_ATTESTED, SERVICE_ATTESTED, NOT_PROVABLE_FROM_BUNDLE …)
    end
```

### Where each check lives

```mermaid
flowchart TB
    subgraph approval["approval network"]
        AP["approver<br/>issuer key · approval code"]:::blue
    end
    subgraph appnet["default network"]
        AG["agent<br/>identity key"]:::neutral
        AU["authority<br/>policy · budget · replay · x402 signer · evidence"]:::purple
        SV["service-agent<br/>VH authorization check → Pay Kit gate → acknowledgement"]:::neutral
        DB[("SQLite<br/>authority_data")]:::purple
    end
    subgraph verification["verification network"]
        VA["verifier-api<br/>public trust roots only"]:::purple
    end
    WEB["web UI (browser)"]:::neutral
    SB[("Pay.sh Solana Payment Sandbox<br/>402.surfnet.dev")]:::neutral

    WEB -- "approval code (header only)" --> AP
    WEB -- "session bearer" --> AG
    WEB -- "evidence bundle" --> VA
    AG -- "signed request + dev shared secret" --> AU
    AU --- DB
    AU -- "probe / paid retry" --> SV
    AU -- "blockhash, confirmation" --> SB
    SV -- "facilitator settle" --> SB
    VA -. "online mode only" .-> SB
    AP -. "issuer PUBLIC key<br/>(issuer_trust volume)" .-> AU

    classDef blue fill:#2563eb,stroke:#1e40af,color:#ffffff
    classDef red fill:#dc2626,stroke:#991b1b,color:#ffffff
    classDef purple fill:#9333ea,stroke:#6b21a8,color:#ffffff
    classDef neutral fill:#f9fafb,stroke:#6b7280,color:#111827
```

### Responsibilities

| Area | Provided by | Notes |
|---|---|---|
| Payment protocol (402 challenge, `exact` scheme) | x402 v2 (`@x402/core`, `@x402/svm` 2.27.0) | Not re-implemented |
| Paid-API gate and facilitator settlement | Solana Pay Kit (`@solana/pay-kit` 0.12.0) on the Pay.sh sandbox | Not re-implemented |
| Ed25519 keys and addresses | `@solana/keys`, `@solana/addresses` (WebCrypto) | No custom crypto |
| Human permit, issuer entitlement, agent authentication | Virtual Haibin (`packages/mandate`, `apps/approver`, `apps/authority`) | |
| Semantic policy (exact operation and argument) and payment-term checks | Virtual Haibin (`packages/policy`, `apps/authority`) | Exact match only, no policy language |
| Durable budget, replay, conflict and reconciliation | Virtual Haibin (`apps/authority/src/store`, SQLite) | Single node |
| Merchant-side authorization check | Virtual Haibin (`ServiceAuthorizationV1`) + mock service | Runs before settlement |
| Evidence bundle and standalone verifier | Virtual Haibin (`packages/evidence`, `apps/verifier`) | |

More detail:

- [x402 on the sandbox](../payments-x402-sandbox.md)
- [Human approval and semantic authorization](../human-approval-and-semantic-authorization.md)
- [Evidence and verification](../evidence-and-verification.md)
- [Security and limitations](security-and-limitations.md)
