# Virtual Haibin Strategy — Crypto World's Fair 2026

## Product thesis

Long-term thesis:

**Virtual Haibin — an autonomous AI agent architecture with verifiable identity, delegated authority, bounded permissions, auditable actions, and machine-to-machine payments.**

Long-term working line:

**Verifiable authority for autonomous agents.**

For the Crypto World's Fair, the product is intentionally narrower:

**Verifiable spending permissions for AI agents.**

The hackathon submission is not claiming that agent identity, delegation, spending limits, policy engines, or audit logs are new categories. Existing infrastructure already covers substantial parts of those problems.

The current product hypothesis is that developers may still need a reliable integration that carries a human-approved paid-service permission through:

```text
human approval
   ->
exact service/API request
   ->
signer enforcement
   ->
exact Solana settlement
   ->
independently checkable evidence
```

That hypothesis must be validated with real developers.

## Product decision — 22 September 2026

The Colosseum Copilot review classified the opportunity as a **PARTIAL GAP**, with a **FALSE GAP inside the broad positioning**.

Decision:

**CHANGE the hackathon positioning and MVP, but preserve the broader long-term thesis.**

See [Hackathon Product Decision — 22 September 2026](hackathon-decision-2026-09-22.md).

## Competition focus

Until submission, allocate effort approximately:

- **95%**: one working, validated hackathon workflow
- **5%**: reusable architecture strictly required by that workflow

The previous 70/30 split is retired for the competition phase.

Reusable package boundaries may remain, but speculative platform work should stop until the core integration is validated.

## Strategic rule

A new feature should satisfy at least one of these:

1. Makes the paid-agent permission workflow demonstrably safer or clearer.
2. Produces evidence required for the judge-facing demo.
3. Solves a concrete problem identified by an external developer.
4. Is strictly required to integrate the chosen Solana/payment primitive.

If it satisfies none, defer it.

## Hackathon architecture

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
  +-- enforce expiry
  +-- reserve budget atomically
  +-- prevent replay
  |
  v
Solana settlement
  |
  v
External service
  |
  v
Evidence receipt / independent verifier
```

The autonomous agent must not own an unrestricted signing key.

The signer/enforcement boundary is the critical security boundary for the MVP.

## Long-term architecture

The broader Virtual Haibin direction remains:

```text
Human / Organization
        |
        v
Delegation / Mandate
        |
        v
Virtual Haibin Agent
        |
        +--> Identity
        +--> Policy / Authority
        +--> Wallet / Payments
        +--> Audit
        |
        v
External Agent / Service / Tool / Robot
```

Longer-term questions can include delegation chains, IAM integration, machine-to-machine trust, robotics, and decision precedence between autonomous actors.

These must not expand the current hackathon scope.

## Competition execution plan

### Phase 0 — Foundation: completed

Completed foundation work includes:

- public repository
- React web app
- agent runtime
- mock external service
- deterministic ALLOW/DENY flow
- reusable packages for identity, mandate, policy, payments, and audit
- Docker-first local development
- CI/build/Docker smoke tests
- README and architecture documentation

This foundation proves runtime structure, not completed security enforcement.

### Product Gate #1 — ecosystem review: completed

Inputs:

- Superteam AU office-hour feedback
- Colosseum Copilot review
- historical project/competitor analysis

Main conclusion:

The broad delegated-agent-authority thesis overlaps too heavily with existing systems to serve as the hackathon differentiator.

The narrow integration remains worth testing.

### Phase 1 — Signed purchase permit

Target: immediate.

Implement a versioned, cryptographically verified purchase permit binding:

- issuer
- authorized agent
- service
- capability/operation
- Solana network
- mint
- recipient
- per-call spending limit
- total spending limit
- issued-at / expiry
- unique grant ID
- explicit subdelegation behavior

Requirements:

- canonical representation
- vetted signature library
- tamper rejection
- expiry rejection
- integer token accounting

### Phase 2 — Protected signer and durable authority state

Create a signer/enforcement service separate from the autonomous agent runtime.

Requirements:

- agent cannot directly use the unrestricted key
- typed purchase requests only
- exact service/recipient/mint validation
- atomic budget reservation
- persistent total-budget state
- replay/idempotency protection
- concurrency safety
- restart persistence
- timeout/uncertain-settlement reconciliation

Critical test:

An affordable transaction to the wrong recipient must be denied.

### Phase 3 — Solana devnet settlement

Integrate one real payment path.

Requirements:

- dedicated development wallet
- one clearly identified devnet/test mint
- exact recipient validation
- real transaction signature
- confirmation/reconciliation
- transaction reference in the receipt

Reuse existing Solana/payment infrastructure wherever practical.

Do not implement multiple payment protocols.

Do not create a custom Solana program unless a required enforcement property cannot be achieved safely with an existing primitive.

### Phase 4 — External service and evidence verifier

The external service should verify whatever settlement/evidence is required before returning the paid result.

Create an independently usable verifier for the evidence bundle.

Receipt should connect:

- grant/permit
- request/quote
- policy decision
- invocation ID
- amount/mint/recipient/network
- transaction signature
- settlement status
- result hash where useful

Be explicit about what the receipt proves and does not prove.

### Phase 5 — Judge-facing UX

The primary UI should present:

- human permission
- attempted purchase
- ALLOW/DENY decision
- exact reason
- actual payment effect
- remaining/reserved budget
- transaction reference
- evidence receipt

Raw JSON is secondary.

### Product Gate #2

Question:

**Can an unfamiliar developer understand in 10–20 seconds that a valid agent identity does not imply authority for every purchase?**

If not, simplify the UI and language.

Do not add more architecture.

### External validation

Highest-priority interviews/integrations:

1. Developer responsible for customer-funded agent purchases.
2. Paid MCP/x402/MPP/API provider or facilitator.
3. Wallet/platform security engineer or specialist familiar with native policy controls.

Primary question:

> Does your existing wallet/payment stack conveniently bind the exact user permission, service request, payment execution, retry semantics, and evidence you need?

Negative answers are valuable.

### Feature freeze

Once the real signed-permit + signer + devnet flow works, prioritize:

- replay/concurrency tests
- failure recovery
- external integration
- demo reliability
- security documentation
- evidence verifier
- README clarity
- pitch

Do not respond to every mentor suggestion with a new platform feature.

## Demo requirements

The demo should show at minimum:

1. Valid permission + valid 0.01 purchase → **ALLOW**.
2. Valid permission + 0.10 quote → **DENY: spending limit**.
3. Valid permission + affordable wrong recipient/service → **DENY: semantic mismatch**.
4. Replay of successful invocation → no second payment.
5. Shared-budget exhaustion/concurrency protection.
6. Independent verification of the resulting evidence receipt.

The strongest opening line is:

> **This agent has a valid identity, but that does not authorize every purchase.**

## Explicitly deferred

Do not let these block the hackathon MVP:

- generic identity registry
- reputation network
- multi-agent marketplace
- cross-chain support
- multiple payment protocols
- multiple wallet backends
- enterprise IAM connectors
- robotics / physical AI control
- governance/tokenomics
- arbitrary delegation graphs
- advanced multi-agent conflict resolution
- full autonomous negotiation

These remain possible parts of the broader Virtual Haibin roadmap.
