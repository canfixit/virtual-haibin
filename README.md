# Virtual Haibin

**Verifiable spending permissions for AI agents.**

Virtual Haibin is a developer-infrastructure project exploring how a human-approved paid service request can be bound to the exact Solana payment an autonomous agent is allowed to make, enforced at the signing boundary, and recorded as independently checkable evidence.

The longer-term thesis remains broader: **verifiable authority for autonomous agents**.

The immediate goal is a focused MVP for the **Colosseum / Superteam Crypto World's Fair 2026**.

## Hackathon thesis

AI agents can increasingly call tools, interact with external services, and control wallets. But a valid agent identity or wallet does not prove that every payment the agent attempts is authorized.

For the hackathon, Virtual Haibin focuses on one concrete question:

> Can a developer give an agent a narrow paid-service permission — this service, this capability, this recipient, this mint, this budget, this expiry — and enforce it at the signer so that the agent cannot silently widen it?

The target integration is:

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

The project is deliberately **not** claiming that agent identity, delegation, spending limits, policy engines, delegated signing, or audit logs are new concepts.

## Crypto World's Fair 2026

The current competition strategy is approximately:

- **95%** focused on one working, validated hackathon workflow
- **5%** reusable architecture strictly required by that workflow

The previous broader platform-first allocation has been retired for the competition phase.

See:

- [Hackathon Product Decision — 22 September 2026](docs/hackathon-decision-2026-09-22.md)
- [Current MVP plan](docs/mvp-plan.md)
- [World's Fair strategy](docs/strategy.md)

## Target MVP

A human signs a bounded purchase permit.

Example:

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

The autonomous agent does **not** hold an unrestricted signing key.

Instead:

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
  +-- verify permit signature
  +-- authenticate agent
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
Evidence receipt
```

## Required demo cases

The hackathon demo should prove more than a simple wallet spending cap.

### ALLOW

```text
0.01 -> authorized service -> authorized recipient
ALLOW
```

### DENY — overspend

```text
0.10 -> authorized recipient
DENY: exceeds per-call limit
```

### DENY — semantic mismatch

```text
0.01 -> wrong recipient or unauthorized service
DENY: not authorized by the permit
```

This is strategically important: the payment is affordable, but still unauthorized.

### REPLAY

Replaying the successful invocation must not create a second payment.

### SHARED BUDGET

Sequential or concurrent requests must not exceed the total delegated budget.

## Current implementation status

The repository already contains a deterministic development vertical slice:

```text
React UI
  -> Virtual Haibin agent API
  -> mandate/policy evaluation
  -> mock external service agent
  -> simulated payment
  -> in-memory audit record
```

The current UI exposes:

- an allowed 0.01 USDC-equivalent request
- a denied 0.10 request exceeding the current per-transaction limit

This is scaffolding, not yet completed verifiable authorization.

Current mocked/incomplete boundaries include:

- mandate signature verification
- signer isolation
- persistent total-budget enforcement
- service/recipient/mint binding
- replay/idempotency state
- real Solana settlement
- independently verifiable evidence receipts

The next implementation work replaces these boundaries incrementally.

## Core architecture

```text
apps/
  web/             # User-facing dashboard
  agent/           # Autonomous agent runtime
  service-agent/   # Demo / integration service

packages/
  identity/        # Agent and issuer identity models
  mandate/         # Delegation / purchase permit representation
  policy/          # Deterministic authorization decisions
  payments/        # Solana/payment abstractions
  audit/           # Action/evidence event models
```

A protected signer/enforcement service will be introduced as part of the narrowed MVP.

## Engineering priorities

Current order:

```text
signed purchase permit
        ->
protected signer / enforcement boundary
        ->
durable budget + replay/idempotency
        ->
real Solana devnet payment
        ->
service-side verification
        ->
evidence receipt + independent verifier
        ->
judge-facing UX
        ->
external developer validation
```

A custom Solana program is not a prerequisite. Existing Solana/payment primitives should be reused where they safely meet the required enforcement properties.

## Docker-first development

The default development workflow keeps WSL clean. **Node.js, pnpm, JavaScript dependencies, TypeScript tooling, Vite, and all application processes run inside Docker.**

Host requirement:

- Docker / Docker Desktop with WSL integration

You do **not** need to install Node.js, pnpm, npm packages, or Git into WSL.

### Clone without host Git

Because this repository is public, use a temporary Git container:

```bash
mkdir -p ~/Projects
cd ~/Projects

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" \
  -w /work \
  alpine/git \
  clone https://github.com/canfixit/virtual-haibin.git

cd virtual-haibin
```

### Start the complete development stack

```bash
docker compose up --build
```

This starts:

- web UI: `http://localhost:5173`
- Virtual Haibin agent: `http://localhost:4000`
- mock service agent: `http://localhost:4001`

Open:

```text
http://localhost:5173
```

All `node_modules` directories are Docker-managed named volumes, so project dependencies are not written into the WSL project tree.

### Stop

```bash
docker compose down
```

To remove dependency volumes as well:

```bash
docker compose down -v
```

### Validate inside Docker

```bash
docker compose run --rm agent pnpm check
```

See [Docker-first development](docs/docker-development.md) for cloning, Git operations, dependency updates, logs, and isolation details.

## Design principles

1. **Permission is not identity** — a valid agent identity does not imply authority for a particular purchase.
2. **Enforce at execution** — policy must be enforced at the signing/payment boundary, not merely checked earlier in the agent workflow.
3. **Bind semantics to settlement** — service, capability, recipient, mint, amount, network, and invocation identity must not drift between authorization and signing.
4. **Bounded autonomy** — agents receive explicit, constrained authority rather than unrestricted keys.
5. **Replay and concurrency matter** — total budgets require durable, atomic state and idempotency.
6. **Evidence has limits** — receipts should state what they prove and what remains trusted offchain.
7. **Reuse existing infrastructure** — do not rebuild wallet, identity, or payment primitives without a demonstrated reason.
8. **One workflow first** — validate a real developer problem before expanding the platform.

## Longer-term direction

Virtual Haibin's broader research direction still includes:

- agent-to-agent interaction
- identity and delegated authority
- autonomous payments
- secure tool execution
- machine-to-machine trust
- IAM integration
- robotics / physical AI
- policy and precedence between autonomous actors

Those areas are deliberately outside the current hackathon critical path.

## Project documents

- [Hackathon Product Decision — 22 September 2026](docs/hackathon-decision-2026-09-22.md)
- [Current MVP plan](docs/mvp-plan.md)
- [World's Fair strategy](docs/strategy.md)
- [Claude Code engineering instructions](CLAUDE.md)
- [Claude Code Phase 1 handoff](docs/claude-handoff.md)
- [Docker-first development](docs/docker-development.md)

## Security

This is a public repository. Never commit:

- wallet private keys or seed phrases
- Solana keypair files
- API keys or tokens
- production credentials
- private user or agent data
- environment files containing secrets

Use dedicated development wallets and local environment variables for sensitive configuration.

## License

Licensed under the [Apache License 2.0](LICENSE).
