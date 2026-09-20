# Crypto World's Fair MVP Plan

> **Status:** provisional until the Darren / mentor discussion.  
> The use case may change; the reusable Virtual Haibin primitives should remain.

## Candidate MVP

### Delegated autonomous commerce

Demonstrate that an AI agent can act and pay autonomously **without receiving unlimited authority**.

A human gives Virtual Haibin a constrained, verifiable mandate. Virtual Haibin requests a service from another agent/tool, evaluates policy, makes an allowed machine-to-machine payment, receives the result, and produces an auditable record.

## Candidate demo flow

```text
Human
  |
  | signed mandate
  v
Virtual Haibin
  |
  | identity + policy check
  v
External agent / service
  |
  | payment required
  v
Virtual Haibin policy engine
  |
  +--> ALLOW -> payment -> result -> audit
  |
  +--> DENY  -> reason -> audit
```

Example mandate:

```text
Agent: Virtual Haibin
Capability: research
Total budget: 0.05 USDC
Max transaction: 0.02 USDC
Expiry: 30 minutes
```

Example successful request:

```text
"Get a short market analysis. You may spend up to 0.05 USDC."

Requested service: research
Price: 0.01 USDC
Capability: allowed
Budget: allowed
Expiry: valid

Decision: ALLOW
Payment: 0.01 USDC
Result: returned
Audit: recorded
```

Example denied request:

```text
"Spend 0.10 USDC on another service."

Decision: DENY
Reason: exceeds delegated authority
Audit: recorded
```

## MVP stages

### MVP-0 — End-to-end skeleton

Goal: first working vertical slice with no blockchain dependency.

```text
User
 -> Virtual Haibin
 -> Mock Policy
 -> Mock External Service
 -> Mock Payment
 -> Audit Record
```

Success criterion: one request passes through the complete architecture and produces a visible result.

### MVP-1 — Mandate and policy

Introduce a reusable mandate model:

```ts
interface Mandate {
  issuer: string;
  agent: string;
  capabilities: string[];
  spending: {
    token: "USDC";
    maxPerTransaction: number;
    maxTotal: number;
  };
  expiresAt: number;
  nonce: string;
  signature: string;
}
```

Required checks:

- issuer / agent identity
- signature validity
- allowed capability
- per-transaction budget
- total budget
- expiry
- replay protection / nonce

Required outcomes:

- allowed valid request
- denied overspend
- denied unsupported capability
- denied expired mandate

### MVP-2 — Solana

Replace mocks incrementally:

```text
mock wallet      -> development wallet
mock signature   -> wallet-signed mandate
mock transaction -> Solana transaction
mock audit ref   -> transaction signature/hash
```

Do not make a custom Solana program a prerequisite unless mentor feedback or implementation evidence shows that it materially strengthens the submission.

### MVP-3 — Machine-to-machine payment

Target flow:

```text
Virtual Haibin
 -> external service
 -> payment request
 -> policy check
 -> USDC/Solana payment
 -> service response
 -> audit
```

Prefer existing infrastructure such as x402 where it is stable and useful.

### MVP-4 — Audit UI

The UI should make the system understandable immediately:

```text
TASK VH-001

Requested:        Market research
Agent:            Virtual Haibin
Authority:        Mandate VH-001
Capability:       research
Maximum spend:    0.05 USDC
Actual spend:     0.01 USDC
Policy decision:  ALLOW
Provider:         Research Agent
Transaction:      <Solana signature>
Status:           COMPLETED
```

## Reusable package direction

Likely structure:

```text
apps/
  web/
  agent/
  service-agent/

packages/
  identity/
  mandate/
  policy/
  payments/
  audit/
```

The MVP use case may change after mentor feedback, but these packages should remain useful.

## MVP change policy

After the Darren discussion, classify proposed changes:

### Green — change freely
- demo use case
- external service
- UI wording
- workflow specifics
- mock vs real provider

### Yellow — change carefully
- payment mechanism
- identity integration
- mandate representation
- Solana implementation detail

### Red — preserve unless the thesis itself changes
- verifiable identity
- delegated authority
- explicit policy
- bounded autonomy
- auditability

This keeps the project adaptable without turning mentor feedback into a full restart.
