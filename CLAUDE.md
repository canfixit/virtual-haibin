# CLAUDE.md — Virtual Haibin Engineering Instructions

This file is the primary instruction set for Claude Code working in this repository.

Read this file completely before modifying code.

Then read, in order:

1. `README.md`
2. `docs/hackathon-decision-2026-09-22.md`
3. `docs/mvp-plan.md`
4. `docs/strategy.md`
5. `docs/claude-handoff.md`
6. `docs/docker-development.md`

If any older comment, README sentence, or implementation detail conflicts with the dated hackathon decision or this file, **this file and the dated decision win**.

---

## 1. Project objective

Virtual Haibin is currently a **Crypto World's Fair / Colosseum hackathon project**.

The hackathon-facing product is:

> **Verifiable spending permissions for AI agents.**

The longer-term thesis is:

> **Verifiable authority for autonomous agents.**

Do not broaden the hackathon implementation back into a generic identity, IAM, robotics, agent marketplace, reputation, multi-chain, or multi-agent platform.

The current narrow hypothesis is:

> A developer may need a reliable way to bind a human-approved paid service request to the exact Solana payment an AI agent is allowed to make, enforce that permission at the signing boundary, and export evidence that another party can verify.

The core demo statement is:

> **This agent has a valid identity, but that does not authorize every purchase.**

---

## 2. Scope discipline

For the competition, treat effort as approximately:

- **95%** one working and validated workflow.
- **5%** reusable architecture strictly required by that workflow.

Do not add abstractions “for later” unless they are required by the current implementation.

Explicitly defer:

- generic agent identity registry
- reputation network
- marketplace
- robotics / physical-AI control
- arbitrary delegation graphs
- cross-chain support
- multiple payment protocols
- multiple wallet backends
- enterprise IAM connectors
- tokenomics
- governance
- advanced multi-agent conflict resolution
- general autonomous negotiation
- long-term memory/digital twin work

Do not introduce a custom Solana program unless an existing primitive demonstrably cannot provide an enforcement property required by the MVP.

---

## 3. Current repository state

The repository already has:

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

The current vertical slice is:

```text
React UI
 -> Node/TypeScript agent
 -> mandate/policy evaluation
 -> mock external service
 -> simulated payment
 -> in-memory audit
```

Current intentional weaknesses that must be replaced:

### `apps/agent/src/index.ts`

- creates a hard-coded mandate
- sets `signature: "mock-signature"`
- supplies `alreadySpent: 0` for every request
- has no durable grant state
- has no replay/idempotency state
- directly invokes the payment provider after application-level policy evaluation
- does not bind the payment to a Solana mint/recipient/network
- uses permissive development CORS

### `packages/mandate/src/index.ts`

- only defines a simple type
- no canonical signed representation
- no signature creation/verification
- monetary values are floating-point numbers
- no service, recipient, mint, network, or subdelegation fields

### `packages/policy/src/index.ts`

- checks capability/token/amount/expiry
- trusts caller-supplied `alreadySpent`
- uses floating-point money
- has no service/recipient/mint/network checks
- does not authenticate issuer/agent

### `packages/payments/src/index.ts`

- only has `MockPaymentProvider`
- returns a random simulated transaction ID

### `packages/audit/src/index.ts`

- in-memory only
- no durable evidence receipt
- no independent verification

### `apps/service-agent/src/index.ts`

- quote does not bind an actual Solana recipient/mint/network
- `/execute` trusts an arbitrary `x-payment-reference`
- does not verify settlement or authorization evidence

These are scaffolding issues, not bugs to hide. Replace them incrementally and keep the README honest about what remains mocked.

---

## 4. Required target architecture

The hackathon target is:

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
Evidence receipt
  |
  v
Independent verifier
```

The autonomous agent must **not** have access to an unrestricted signing key.

The signing/enforcement boundary is the critical security boundary.

The signer must construct or fully decode and validate the exact transaction it signs. It must never blindly sign transaction bytes supplied by the autonomous agent.

---

## 5. Mandatory demo behavior

The completed MVP must demonstrate all of these.

### Case 1 — ALLOW

Authorized service, capability, recipient, mint, network, valid permit, 0.01 payment below limits.

Expected:

- ALLOW
- budget reserved/consumed correctly
- payment submitted and confirmed
- service result returned
- evidence receipt produced

### Case 2 — DENY overspend

Correct service and recipient but 0.10 request exceeds a 0.02 per-call limit.

Expected:

- DENY
- explicit spending-limit reason
- no payment submitted

### Case 3 — DENY semantic mismatch

Affordable 0.01 request but wrong recipient, service, capability, mint, or network.

Expected:

- DENY
- explicit semantic authorization reason
- no payment submitted

**This case is strategically more important than the overspend case.**

### Case 4 — Replay

Replay a previously successful invocation.

Expected:

- no second payment
- return the existing receipt or a deterministic duplicate/replay result

### Case 5 — Shared budget / concurrency

Repeated or parallel requests must not exceed the total delegated budget.

Expected:

- atomic reservation
- no race-condition overspend
- state survives process restart

---

## 6. Security invariants

Treat these as non-negotiable.

1. **No raw unrestricted signing key in the agent process.**
2. **No private key, seed, API token, or credential committed to Git.**
3. **No floating-point currency accounting.**
4. Represent token values in integer atomic units. If serialized as JSON, prefer decimal strings where necessary to avoid unsafe integer conversion.
5. A permit signature must cover every field whose mutation could widen authority.
6. Permit verification must fail if any signed field is changed.
7. Domain-separate the signed permit format and version it.
8. Explicitly bind:
   - issuer
   - authorized agent
   - service
   - capability/operation
   - network/cluster
   - mint
   - recipient
   - per-call limit
   - total limit
   - issuance/expiry
   - grant ID
   - subdelegation behavior
9. The signer must validate authoritative transaction facts, not trust labels supplied by the agent.
10. Replay/idempotency must be enforced with durable state.
11. Budget reserve/consume transitions must be atomic.
12. A network timeout after submission is not permission to pay again.
13. Reconcile uncertain transaction state before retrying.
14. Evidence must state what it proves and what it does not prove.
15. A signed receipt does not prove external service output is truthful.
16. A Solana transaction proves settlement, not the semantic correctness of an offchain service.
17. Validate all untrusted HTTP input; impose reasonable body-size limits.
18. Keep development CORS explicit and do not silently treat `*` as production configuration.

Do not write custom cryptographic primitives. Use maintained, reviewed libraries and official Solana tooling where practical.

For cryptographic choices, prefer Solana-compatible Ed25519 semantics. Verify the current maintained official Solana JavaScript package before adding dependencies.

---

## 7. Docker-only development rule

The user's WSL environment is intentionally clean.

**Do not install Node.js, pnpm, npm packages, Git, Solana CLI, Rust, Anchor, or other project tooling into WSL.**

Do not run host:

```bash
npm install
pnpm install
node ...
apt install ...
sudo apt ...
cargo install ...
```

Run project tooling inside Docker.

Primary commands:

```bash
docker compose up --build
docker compose up --build -d
docker compose logs -f
docker compose down
docker compose down -v
docker compose run --rm agent pnpm check
```

When adding packages, run pnpm through a project container.

Example:

```bash
docker compose run --rm agent \
  pnpm --filter @virtual-haibin/agent add <package>
```

If a new workspace package/app is added, update the development image and Compose volumes/services as needed.

### Git without host Git

Do not install Git in WSL.

For status/diff/read-only operations use a temporary Git container if needed:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/repo" \
  -w /repo \
  alpine/git status
```

Do not push or publish secrets.

Do not rewrite history.

Do not make commits unless explicitly requested by the user.

Claude Code may edit files directly in the working tree; Git is not required for normal editing.

---

## 8. Dependency policy

Before adding a dependency:

1. Check whether Node 24 or the existing repo already provides the capability.
2. Prefer official Solana libraries for Solana functionality.
3. Prefer small, maintained libraries with clear ownership.
4. Avoid abandoned crypto/security packages.
5. Avoid adding large frameworks for a narrow requirement.
6. Document why each security-sensitive dependency was chosen.
7. Pin versions consistently with the repository's current package policy.
8. Rebuild Docker after dependency changes.
9. Run the full check and relevant tests.

Do not add a second package manager.

Keep pnpm.

---

## 9. Testing policy

Every security or state transition added must have automated tests.

Prefer a minimal TypeScript test approach. If the existing toolchain can use Node's built-in test runner through `tsx`, prefer that over introducing a large test framework.

At minimum, add tests for:

### Permit/signature

- valid permit verifies
- mutation of each security-relevant signed field fails verification
- wrong issuer key fails
- malformed signature fails
- wrong domain/version fails
- expired permit is rejected at authorization time
- malformed/zero/negative monetary limits are rejected
- invalid network/mint/recipient inputs are rejected

### Policy/enforcement

- valid authorized request allowed
- per-call overspend denied
- total-budget overspend denied
- wrong capability denied
- wrong service denied
- wrong recipient denied
- wrong mint denied
- wrong network denied
- expired permit denied

### Replay/state

- duplicate invocation does not create a second payment
- concurrent reservations cannot exceed total budget
- state survives service restart
- failed/rejected request does not consume final budget incorrectly
- uncertain payment state is reconciled, not blindly retried

### HTTP boundaries

- invalid JSON rejected safely
- oversized payload rejected
- missing required fields rejected
- unexpected enum/string values rejected

### End-to-end

- ALLOW
- overspend DENY
- semantic DENY
- replay
- shared budget exhaustion

Tests should assert **side effects**, not only response strings. For a denied payment, prove the payment path was not invoked.

---

## 10. Observability

Use structured application logs for important transitions.

Log identifiers, not secrets.

Useful fields:

- grantId
- invocationId
- agentId/public key
- serviceId
- decision
- reason code
- reserved amount
- remaining budget
- transaction signature
- settlement state

Do not log:

- private keys
- seed phrases
- bearer tokens
- full sensitive prompts/results by default

Prefer stable machine-readable reason codes plus human-readable messages.

---

## 11. Error handling and state model

Do not collapse all failures into generic 500 responses.

Model meaningful states such as:

```text
REQUESTED
AUTHORIZED
DENIED
RESERVED
SIGNING
SUBMITTED
CONFIRMED
SERVICE_FULFILLED
RECEIPT_CREATED
RECONCILIATION_REQUIRED
FAILED
```

Not every state needs to be publicly exposed, but payment retries and reconciliation must distinguish:

- never submitted
- submitted but confirmation unknown
- confirmed
- failed onchain
- payment confirmed but service fulfillment failed

Do not pay twice merely because an HTTP request timed out.

---

## 12. Data model guidance

The exact final schema may evolve, but the first signed permit should be intentionally narrow.

A v1 permit should conceptually contain:

```text
version/domain
grantId
issuer
authorizedAgent
serviceId/origin
capability
network/cluster
mint
recipient
maxPerCallAtomic
maxTotalAtomic
issuedAt
expiresAt
subdelegation = false
signature metadata/value
```

Use precise types and validation.

Do not call a field `token: "USDC"` when security depends on an actual mint address.

Do not use a provider display name as the payment recipient identity.

Use separate user-facing labels and authoritative identifiers.

---

## 13. Persistence guidance

The current `alreadySpent: 0` must not survive past the scaffold.

For the hackathon, a single-node durable transactional store is acceptable.

Prefer the smallest solution that gives:

- transactions
- atomic compare/reserve/consume behavior
- restart persistence
- unique invocation constraints

Node 24's built-in SQLite support may be considered if it is stable in the pinned runtime and adequate for the required transactions. Otherwise choose a maintained SQLite solution.

Do not introduce PostgreSQL/Kubernetes/distributed state unless a concrete requirement justifies it.

Persist state in a Docker-managed volume, not in source control.

---

## 14. Solana integration guidance

The MVP needs **one real devnet settlement path**, not a general payment framework.

Requirements:

- dedicated development key material isolated from the agent
- exact cluster validation
- exact mint validation
- exact recipient validation
- integer atomic units
- actual transaction signature
- confirmation/reconciliation
- explorer/reference link where useful
- no mainnet funds for the hackathon demo

If using test USDC, verify the official current devnet/test mint from an authoritative source at implementation time.

If using a project-created demo token, label it clearly as a demo token.

Do not call a demo token USDC.

Reuse x402 or another payment protocol only if it materially helps the chosen external-service integration. Do not integrate multiple protocols.

---

## 15. Evidence receipt guidance

The evidence artifact should connect:

```text
permit/grant
request/quote
policy decision
invocation
payment facts
Solana transaction
settlement status
service fulfillment
result hash (if useful)
```

The independent verifier should be able to validate as much as possible without calling the Virtual Haibin web UI.

The verifier should clearly separate:

### Cryptographically/onchain verifiable

- permit signature
- integrity of signed fields
- transaction signature / settlement
- hashes included in the evidence

### Trusted/offchain assertions

- whether the service output was correct
- business interpretation of the capability
- completeness of operator logs
- facts not represented in the signed/onchain data

Do not use “trustless” unless the property is actually trustless.

---

## 16. UI priorities

Do not spend early time on visual polish.

The final judge-facing screen should make these immediately visible:

### Human permission

- agent
- service/capability
- authorized recipient
- mint/network
- per-call cap
- total / reserved / remaining budget
- expiry

### Proposed purchase

- service
- recipient
- amount
- invocation ID

### Decision

- ALLOW or DENY
- stable reason code
- human-readable reason

### Effect

- was a payment submitted?
- was it confirmed?
- transaction signature
- result/fulfillment status
- receipt/verifier status

Keep raw JSON behind an inspect/debug view.

---

## 17. Implementation order

Follow this order unless a blocking technical dependency requires a small reordering.

### Phase 1 — Signed PurchasePermit

Implement:

- versioned permit type
- strict validation
- canonical signing representation
- Ed25519 signing helper for tests/dev tooling
- signature verification
- tamper tests
- expiry and field-validation tests

Do not start real Solana payment work until this phase is green.

### Phase 2 — Protected authority/signer service

Add an app/service such as `apps/authority`.

It should:

- own/access signer key material
- authenticate agent requests
- verify permit
- validate request against permit
- expose typed purchase authorization/signing operations
- never expose the raw private key to the agent

Add it to Docker Compose with only the mounts/volumes it requires.

### Phase 3 — Durable budget + replay state

Implement:

- persistent grants
- reservations
- invocation uniqueness
- atomic budget operations
- replay/idempotency behavior
- restart persistence
- concurrency tests

### Phase 4 — Real Solana devnet payment

Implement one settlement path.

### Phase 5 — Service-side verification

Make the mock/external service verify the required payment/evidence instead of accepting arbitrary headers.

### Phase 6 — Receipt + independent verifier

Generate and verify the evidence bundle.

### Phase 7 — Judge-facing UI

Replace raw JSON-first UX with permission / attempt / decision / effect views.

### Phase 8 — External integration hardening

Only after the core path works:

- integrate one external developer/service if available
- improve setup docs
- document threat model
- document known limitations

---

## 18. Phase completion protocol

At the end of each phase:

1. Run targeted tests.
2. Run:
   ```bash
   docker compose run --rm agent pnpm check
   ```
3. If Compose topology changed, run:
   ```bash
   docker compose up -d --build --wait
   ```
4. Smoke test relevant endpoints.
5. Inspect logs for unexpected warnings/errors.
6. Update docs only for behavior that now actually exists.
7. Summarize:
   - files changed
   - tests added
   - tests run
   - security assumptions
   - remaining mocks
   - next phase

Do not claim planned functionality is implemented.

---

## 19. When to stop and ask the user

Proceed autonomously for ordinary implementation decisions.

Stop and ask before:

- using mainnet funds
- creating a production/mainnet wallet
- publishing or exposing credentials
- introducing a custom Solana program solely to meet the hackathon
- making an irreversible external deployment/account change
- choosing between materially different custody/trust models when the choice changes the product promise
- deleting major existing functionality
- changing the hackathon thesis/category again

Do not stop for trivial naming, formatting, test, or internal refactoring decisions.

---

## 20. Coding standards

- TypeScript strictness should remain enabled.
- Prefer explicit domain types.
- Keep functions small and testable.
- Avoid hidden mutable global state for authorization.
- Separate pure validation/policy from I/O.
- Keep security-sensitive comparisons explicit.
- Use stable reason codes.
- Validate at trust boundaries.
- Comment why a security control exists, not what obvious code does.
- No `any` unless unavoidable and documented.
- Do not swallow errors.
- Avoid premature microservices beyond the required signer isolation.
- Keep Git-friendly focused changes.
- Preserve Apache-2.0 licensing.

---

## 21. First task

**Start with Phase 1 only: Signed PurchasePermit.**

Before coding:

1. Inspect the current mandate, policy, identity, agent, and package configuration.
2. Decide on the maintained Solana-compatible Ed25519/signature dependency and canonical representation.
3. Briefly record that choice in the code/docs if security-relevant.
4. Implement the smallest coherent Phase 1.
5. Add comprehensive tests.
6. Run all checks inside Docker.
7. Report results before proceeding to Phase 2.

The Phase 1 definition of done is detailed in `docs/claude-handoff.md`.
