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

The repository now contains a deterministic development vertical slice with a real signer boundary:

```text
React UI
  -> Virtual Haibin agent (builds a typed purchase request; holds no signing key)
  -> Authority service (verifies the signed permit, evaluates policy, reserves budget, pays, signs a decision receipt)
  -> mock external service agent
  -> simulated payment
  -> in-memory audit record
```

The current UI exposes:

- an allowed 10000-atomic-unit request (0.01 of a 6-decimal demo token, not USDC)
- a denied 100000-atomic-unit request exceeding the per-call limit
- a denied 10000-atomic-unit request where the service quotes an unauthorized recipient (semantic DENY)

Reusing an `invocationId` with the same request is idempotent (no second payment); reusing it with a different request returns HTTP 409 `INVOCATION_CONFLICT` with no payment and no budget change.

Money on the agent -> authority path is integer atomic units as canonical decimal strings end to end. The mock service's `/quote` returns the authoritative `service`, `capability`, `network`, `mint`, `recipient` and `amountAtomic` (display label/decimals are separate and never used for authorization), and the agent forwards those fields verbatim to the authority.

The full request/response JSON (including the authority's signed receipt) is visible via the UI's raw output panel; a dedicated judge-facing view comes in Phase 7.

Current mocked/incomplete boundaries include:

- durable state is single-node SQLite -- grant budgets (reserved/consumed), invocation ids, fingerprints, states and stored receipts live in `/data/authority.db` on the `authority_data` Docker volume (`apps/authority/src/store/`), behind an `AuthorityStore` interface; they survive process and container restarts, but there is no replication/backup, and startup recovery assumes a single authority process
- the authority's receipt-signing key is still ephemeral per process: receipts stored before a restart remain verifiable against the authority address they name, but the authority's identity changes on every restart
- real Solana settlement -- payment is still `MockPaymentProvider` (`packages/payments`); no devnet transaction exists yet
- service-side payment verification -- `apps/service-agent`'s `/execute` still trusts an arbitrary `x-payment-reference` header
- independently verifiable evidence receipts -- the authority signs a decision receipt (`apps/authority/src/receipt.ts`) proving *it* made the decision, but this is not yet the full Phase 6 evidence bundle (no Solana settlement or service-result linkage yet), and there is no independent verifier tool
- agent identity is ephemeral: the agent generates a fresh, non-extractable Ed25519 *identity* key at startup (it signs authorization requests and can never spend funds), and the demo permit is issued to that identity at startup by a simulated human issuer running in the same process; persistent agent identity storage and out-of-process permit issuance are future work
- agent-to-authority transport authentication is a shared dev-only bearer secret (`AUTHORITY_SHARED_SECRET`, supplied at runtime from the gitignored `.env`); it is **not** treated as proof of agent identity -- every `/authorize` call must carry the agent's signature over a domain-separated request bound to the exact permit (SHA-256 digest), the authority audience, the invocation and all payment fields, verified against the permit's `authorizedAgent`
- a payment attempt whose outcome is unknown -- provider error/timeout, a payment that could not be recorded, or an authority restart mid-payment -- durably blocks that invocation as `RECONCILIATION_REQUIRED` (HTTP 409) with its budget still reserved; there is no reconciliation procedure yet to resolve it (that needs real settlement, Phase 4)

The next implementation work replaces these boundaries incrementally.

## Core architecture

```text
apps/
  web/             # User-facing dashboard
  agent/           # Autonomous agent runtime (no signing key)
  authority/        # Protected signer/enforcement boundary
  service-agent/   # Demo / integration service

packages/
  identity/        # Agent and issuer identity models
  mandate/         # Signed PurchasePermit representation, validation, Ed25519 signing/verification
  policy/          # Deterministic authorization decisions
  payments/        # Solana/payment abstractions
  audit/           # Action/evidence event models
```

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

### Create the local secrets file

Compose requires `AUTHORITY_SHARED_SECRET` (a dev-only agent -> authority bearer token) and will refuse to start without it. Create the gitignored `.env` once:

```bash
cp .env.example .env
sed -i "s|^AUTHORITY_SHARED_SECRET=.*|AUTHORITY_SHARED_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')|" .env
```

Never commit `.env`. The authority refuses to start with the `.env.example` placeholder or a secret shorter than 32 characters.

### Start the complete development stack

```bash
docker compose up --build
```

This starts:

- web UI: `http://localhost:5173`
- Virtual Haibin agent: `http://localhost:4000`
- authority (protected signer): `http://localhost:4002`
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

`down -v` also deletes the `authority_data` volume, i.e. **all durable authority state** (budgets, invocation history, receipts). Use plain `docker compose down` to keep it.

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
