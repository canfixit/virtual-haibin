# Crypto World's Fair MVP Plan

> **Status:** revised 22 September 2026 after the Colosseum Copilot review.  
> The hackathon wedge is now intentionally narrower than the long-term Virtual Haibin thesis.

## Hackathon thesis

For the Crypto World's Fair, Virtual Haibin is not trying to prove that delegated authority, spending limits, wallets, or audit logs are new concepts.

The MVP focuses on one integration problem:

> **Bind a human-approved paid service request to the exact Solana payment an AI agent is allowed to make, enforce that permission at the signing boundary, and produce evidence that can be independently verified.**

Primary demo-facing positioning:

**Verifiable spending permissions for AI agents.**

Longer-term thesis:

**Verifiable authority for autonomous agents.**

See [Hackathon Product Decision — 22 September 2026](hackathon-decision-2026-09-22.md).

## Narrow MVP

A human authorizes Virtual Haibin to purchase one specific class of service under explicit constraints.

Example permission:

```text
Agent: Virtual Haibin
Service: Research Agent
Capability: research.summary
Recipient: <configured Solana recipient>
Mint: <configured devnet token mint>
Maximum per call: 0.02
Total budget: 0.05
Expiry: 30 minutes
```

The autonomous agent does not hold an unrestricted signing key.

Instead, it submits a typed purchase request to a protected authority/signer service.

## Target flow

```text
Human
  |
  | signs PurchasePermit
  v
Virtual Haibin Agent
  |
  | typed PurchaseRequest
  v
Authority / Signer Service
  |
  +-- authenticate caller
  +-- verify permit signature
  +-- verify service/capability
  +-- verify recipient/mint/network
  +-- verify expiry
  +-- atomically reserve budget
  +-- prevent replay
  |
  v
Solana payment
  |
  v
External service
  |
  v
Evidence receipt
```

## Required demo cases

### Case 1 — ALLOW

```text
Service: Research Agent
Capability: research.summary
Recipient: Wallet A
Amount: 0.01

Decision: ALLOW
Payment: submitted and confirmed on Solana devnet
Result: returned
Remaining delegated budget: 0.04
Receipt: generated
```

### Case 2 — DENY overspend

```text
Service: Research Agent
Recipient: Wallet A
Amount: 0.10

Decision: DENY
Reason: per-call spending limit exceeded
Payment: not submitted
```

### Case 3 — DENY semantic mismatch

```text
Service: Research Agent
Capability: research.summary
Recipient: Wallet B
Amount: 0.01

Decision: DENY
Reason: recipient is not authorized by the permit
Payment: not submitted
```

This case is strategically important. A simple wallet spending limit can already reject Case 2. Case 3 demonstrates that the permission is bound to the intended service/payment semantics.

### Case 4 — Replay protection

Replay the invocation from Case 1.

Expected behavior:

- do not make a second payment
- return the existing receipt or an explicit duplicate/replay decision
- preserve a stable invocation/idempotency identity

### Case 5 — Shared budget enforcement

Multiple sequential or parallel 0.01 requests must not consume more than the delegated total budget.

The budget must survive process restart and concurrent requests.

## MVP stages

### MVP-0 — Existing deterministic skeleton

Current repository state:

```text
React UI
 -> Virtual Haibin agent
 -> mandate/policy evaluation
 -> mock external service
 -> simulated payment
 -> in-memory audit
```

Current value:

- verifies runtime boundaries
- provides ALLOW/DENY scaffolding
- confirms monorepo/build/CI structure

Current limitations are intentional but must not be described as completed security functionality:

- mock mandate signature
- no cryptographic issuer verification
- no protected signer
- no persistent total-budget enforcement
- no service/recipient/mint binding
- no real replay protection
- no real Solana settlement
- no independently verifiable receipt

### MVP-1 — Signed purchase permit

Replace the generic demo mandate with a narrow versioned purchase permit.

The signed representation should bind at least:

- format/version/domain
- issuer identity/public key
- authorized agent identity/public key
- service identifier/origin
- capability/operation
- Solana cluster/network
- token mint
- payment recipient
- per-call limit in integer token units
- total budget in integer token units
- issued-at and expiry
- unique grant ID
- explicit delegation/subdelegation rule

Requirements:

- stable canonical encoding
- vetted signature implementation
- strict parsing and bounds validation
- tamper tests
- expired-permit rejection

Natural-language input may help produce these fields, but the user must review the concrete permission before signing.

### MVP-2 — Protected signer / enforcement boundary

Create a separate authority/signer service that owns or can access the development signing key.

The agent runtime must not have direct unrestricted key access.

The signer receives a typed purchase request and independently validates:

- authenticated caller
- permit signature
- agent binding
- service/capability
- recipient
- mint/network
- amount
- expiry
- invocation identity
- remaining/reserved budget

The signer must construct or fully decode and validate the exact transaction before signing.

It must never blindly sign arbitrary transaction bytes supplied by the autonomous agent.

### MVP-3 — Durable budget and replay state

Replace caller-supplied `alreadySpent` with authoritative durable state.

Required lifecycle:

```text
request
 -> reserve budget atomically
 -> construct/sign
 -> submit
 -> reconcile confirmation
 -> consume reservation
 -> fulfill service
 -> generate receipt
```

Requirements:

- integer token units; no floating-point currency accounting
- atomic reservation
- concurrency-safe total budget
- idempotency/invocation IDs
- replay protection
- restart persistence
- reconciliation after uncertain submission/confirmation
- no automatic duplicate payment after timeout

### MVP-4 — Real Solana devnet settlement

Integrate one payment path only.

Requirements:

- dedicated development wallet
- clearly identified devnet/test token mint
- exact recipient validation
- real Solana transaction signature
- confirmation/reconciliation
- transaction link/reference in the evidence record

Prefer existing Solana/payment infrastructure where it reduces risk.

Do not implement multiple payment protocols for the MVP.

Do not make a custom Solana program a prerequisite unless an existing allowance mechanism cannot provide a required enforcement property and the additional complexity is justified.

### MVP-5 — External service verification

The external service should not merely trust an arbitrary `x-payment-reference` header.

For the selected integration, it should verify the settlement/evidence required to release the service result.

Keep the service deterministic enough that payment/authorization remains the focus of the demo.

### MVP-6 — Evidence receipt and independent verifier

Successful execution should produce an evidence bundle linking:

- permit/grant ID
- issuer
- authorized agent
- service/capability
- request/quote identity or hash
- policy decision and relevant rule
- amount/mint/recipient/network
- invocation/idempotency ID
- Solana transaction signature
- settlement state
- result hash where useful

A separate verifier should be able to validate the bundle without trusting the Virtual Haibin web UI.

Be explicit about what the evidence proves and what it does not prove.

For example:

- it can prove that a particular permit was signed
- it can prove that a particular Solana transaction settled
- it does not prove that an external service's research output is truthful or valuable

### MVP-7 — Judge-facing UI

The primary screen should show:

```text
HUMAN PERMISSION
Agent
Service / capability
Authorized recipient
Mint / network
Per-call cap
Total / remaining / reserved budget
Expiry

PROPOSED PURCHASE
Service
Recipient
Amount
Invocation ID

DECISION
ALLOW / DENY
Exact rule / reason

EFFECT
Payment submitted?
Payment confirmed?
Transaction signature
Result
Receipt
```

Raw JSON belongs behind an inspection control rather than being the main presentation.

## Demo sequence — 60 to 90 seconds

### 0–12 seconds

Explain:

> This agent has a valid identity, but that does not authorize every purchase.

Show and sign the permission once.

### 12–30 seconds

Execute the valid 0.01 purchase.

Show:

- verified permission
- budget reservation
- confirmed Solana devnet transaction
- service result
- remaining budget

### 30–45 seconds

Attempt 0.10 to the correct recipient.

Show:

- DENY
- exact spending-limit rule
- no new payment submitted

### 45–60 seconds

Attempt 0.01 to the wrong recipient or wrong authorized service.

Show:

- DENY despite the affordable amount
- no payment submitted

### 60–75 seconds

Replay the successful invocation.

Show:

- existing receipt or duplicate rejection
- no second transfer

### 75–90 seconds

Run the independent verifier against the receipt.

End with:

> The agent does not hold the unrestricted signing key. These are the exact permissions the signing boundary enforced.

## Validation

The central validation question is:

> Does an agent/payment developer have an authorization, retry, overspend, recipient-substitution, or evidence problem that their existing wallet/payment stack does not solve conveniently?

Strong evidence before submission:

- one external developer integrates or tests the flow
- one real paid-service developer identifies the same missing requirement
- native wallet/provider controls are compared against the same guarantee
- an integration demonstrates a failure case that Virtual Haibin handles more conveniently or clearly
- mentor feedback confirms the wedge is understandable and relevant

## Scope rule

For the competition:

- **95%** one working and validated workflow
- **5%** reusable architecture required by that workflow

Existing package boundaries can remain.

Do not add generic framework layers merely because they might be useful later.

## Explicitly deferred

- generic agent identity registry
- reputation
- marketplaces
- cross-chain
- multiple wallet providers
- multiple payment protocols
- arbitrary delegation chains
- enterprise IAM integrations
- robotics / physical AI control
- governance/tokenomics
- multi-agent precedence/conflict resolution
- general autonomous negotiation

These remain possible long-term Virtual Haibin directions, not hackathon requirements.
