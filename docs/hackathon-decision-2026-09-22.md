# Hackathon Product Decision — 22 September 2026

## Decision

**CHANGE the hackathon positioning and MVP while preserving the longer-term Virtual Haibin thesis.**

The Colosseum Copilot review classified the opportunity as a **PARTIAL GAP**, with a **FALSE GAP inside the broad positioning**.

The broad claim that agents need delegated permissions, spending limits, policy checks, and auditability is not sufficiently differentiated by itself. Existing systems already cover substantial parts of that problem.

For the Crypto World's Fair MVP, Virtual Haibin will therefore focus on a narrower developer-infrastructure problem:

> **Bind a human-approved paid service request to the exact Solana payment an agent is allowed to make, enforce that permission at the signing boundary, and produce evidence that can be independently verified.**

## Hackathon positioning

Primary demo-facing line:

**Verifiable spending permissions for AI agents.**

Longer-term thesis:

**Verifiable authority for autonomous agents.**

The long-term thesis remains useful as product direction, but it should not be presented as an empty or newly invented category.

## What we are no longer claiming

The hackathon submission should not claim that Virtual Haibin uniquely invented:

- agent identity
- signed delegation
- spending limits
- deterministic policy evaluation
- delegated signing
- machine-to-machine payments
- audit logs
- capability-based authorization

These already exist in multiple forms.

The current product hypothesis is that there may still be value in the **integration boundary** between:

```text
human permission
      ->
exact service/API request
      ->
signer enforcement
      ->
exact Solana settlement
      ->
independently checkable evidence
```

That hypothesis still requires external validation.

## Narrow MVP

One user authorizes one agent to purchase one type of service from one configured provider.

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

Required demo cases:

1. **ALLOW** — 0.01 payment to the correct service and recipient.
2. **DENY: overspend** — 0.10 request exceeds the per-call limit.
3. **DENY: semantic mismatch** — 0.01 request attempts to pay the wrong recipient or invoke the wrong service/capability.
4. **REPLAY protection** — the same invocation cannot create a second payment.
5. **Shared budget enforcement** — repeated/parallel requests cannot exceed the total delegated budget.

Case 3 is essential. A simple wallet spending limit can already reject Case 2; the semantic mismatch demonstrates the stronger authorization boundary.

## Required security boundary

The autonomous agent must not hold an unrestricted signing key.

Target flow:

```text
Human
  |
  | signs PurchasePermit
  v
Agent
  |
  | typed PurchaseRequest
  v
Authority / Signer Service
  |
  +-- authenticate caller
  +-- verify permit signature
  +-- verify service/capability
  +-- verify recipient/mint/network
  +-- atomically reserve budget
  +-- prevent replay
  |
  v
Solana settlement
  |
  v
External service
  |
  v
Evidence receipt
```

The signer should construct or fully validate the transaction it signs. It must not blindly sign an arbitrary transaction supplied by the agent.

## Evidence bundle

The successful path should produce an inspectable receipt linking:

- permit/grant ID
- issuer and agent
- service/capability
- request/quote identity or hash
- policy decision and relevant rule
- amount/mint/recipient/network
- invocation/idempotency ID
- Solana transaction signature
- settlement status
- result hash where useful

A separate verifier should be able to inspect the evidence without trusting the web UI.

## Engineering priorities

From this decision forward, implementation order is:

1. signed purchase permit and cryptographic verification
2. protected signer/enforcement boundary
3. durable atomic budget accounting and replay/idempotency handling
4. one real Solana devnet payment path
5. independent evidence receipt/verifier
6. demo UX around ALLOW, semantic DENY, overspend DENY, replay, and shared-budget exhaustion
7. one outside developer integration or design-partner test

## Scope discipline

For the competition, use approximately:

- **95%** one working, validated hackathon workflow
- **5%** reusable architecture required by that workflow

Existing package boundaries may remain, but no new generic abstraction should be added unless the integration requires it.

Explicitly defer:

- generic agent identity registry
- reputation systems
- arbitrary delegation graphs
- multiple payment protocols
- multiple wallet backends
- enterprise IAM connectors
- robotics/physical-AI integration
- multi-agent conflict resolution
- cross-chain support
- marketplaces
- tokenomics

## Validation question

The primary product question is no longer:

> Do people think verifiable authority for agents is important?

It is:

> Does an agent/payment developer have a concrete authorization, retry, overspend, recipient-substitution, or evidence problem that their existing wallet/payment stack does not solve conveniently?

If outside developers cannot identify such a gap after comparison with native wallet controls and existing authorization infrastructure, Virtual Haibin should not expand into a broad authority platform.

## Demo opening

The demo should make the distinction understandable in seconds:

> **This agent has a valid identity, but that does not authorize every purchase.**

Then:

> **It may buy this service, from this recipient, within this budget. Change the recipient, exceed the budget, or replay the request, and the signer refuses.**
