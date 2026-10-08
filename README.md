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
Network: solana-payment-sandbox (Pay.sh Solana Payment Sandbox)
Mint: <configured sandbox token mint>
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

The repository contains an end-to-end vertical slice in which an agent's purchase is authorized by Virtual Haibin and settled with a real x402 payment on the **Pay.sh Solana Payment Sandbox** (a hosted Surfpool test validator; no real funds):

```text
Human (web UI + approval code)
  -> Approver (separate process; the only holder of the issuer key)
       signs a PurchasePermit v2 for one exact operation, e.g. summarize(dataset-a)
  -> the signed permit is installed in the agent (the agent cannot create or widen one)
React UI
  -> Virtual Haibin agent (signs a typed purchase request, incl. the operation, with a non-spending identity key)
  -> Authority service
       verifies the signed permit, that its issuer is the pinned trusted issuer, and the agent's request signature
       checks the requested operation against the human-approved one (exact match)
       builds the outbound HTTP request from the verified operation
       fetches the paid service's real HTTP 402 x402 challenge for exactly that request (trusted URL only)
       validates the challenge against the settlement profile, the request and the permit
       reserves budget atomically in SQLite
       signs the x402 "exact" payment with its own payment wallet
  -> paid mock service (Pay Kit x402 gate; its facilitator settles on the sandbox)
  -> authority confirms settlement on the pinned sandbox RPC, stores evidence, returns the paid result
```

**Who does what.** Pay.sh / Solana Pay Kit (`@solana/pay-kit` on the service, `@x402/core` + `@x402/svm` on the authority) provide the payment protocol and settlement rail: the x402 v2 402 challenge, the `exact` SPL transfer, the facilitator that verifies and submits it. Virtual Haibin provides delegated authority on top of that rail: the human-signed PurchasePermit and issuer entitlement, agent authentication, semantic policy (exact operation and arguments, service, capability, recipient, asset, amount), durable budget, replay/conflict protection and reconciliation. Virtual Haibin did not invent x402 and does not re-implement it. See [docs/payments-x402-sandbox.md](docs/payments-x402-sandbox.md) for the trust model.

**Phase 4.5: same payment, different meaning.** The paid service has one endpoint, `POST /api/v1/report`, where `summarize` and `export` cost exactly the same (same price, payTo, asset, network). The human approves `summarize(dataset-a)`. A fresh request for `export(dataset-a)` is denied with `OPERATION_NOT_AUTHORIZED`, and `summarize(dataset-b)` with `OPERATION_ARGUMENT_NOT_AUTHORIZED`. Neither is reserved, contacts the service or signs a payment. A permit signed by any key other than the pinned issuer is refused with `ISSUER_NOT_ENTITLED`. A valid payment does not necessarily mean the agent was authorized to buy that operation. See [docs/human-approval-and-semantic-authorization.md](docs/human-approval-and-semantic-authorization.md).

**Judge-facing UI (Phase 6).** `http://localhost:5173` is a single page in the CanFixIT visual language. Blue marks human approval, red marks the attempted violation, and purple marks Virtual Haibin and verification. It walks through:

1. human approval
2. the approved `summarize(dataset-a)` against the unauthorized `export(dataset-a)`
3. the real purchase timeline
4. a side-by-side comparison showing that only the operation differs
5. the standalone verifier's report on the exported evidence

Everything shown comes from real backend responses. The verifier runs as `verifier-api` on port 4004: the standalone verifier library, isolated on its own network with pinned public trust keys. Brand colours are three CSS variables in `apps/web/src/theme.css`. Agent API calls are scoped to a per-page demo session capability, so one visitor cannot use another's permit, purchases or evidence. See [docs/judge-demo-ui.md](docs/judge-demo-ui.md).

The current UI exposes:

- human approval of `summarize(dataset-a)` (requires the approval code from `docker compose exec approver cat /keys/approval-code`)
- the approved operation: 0.01 sandbox USDC (`"10000"` base units) settled on the sandbox, returning the paid result
- an unauthorized `export(dataset-a)` and `summarize(dataset-b)` at the same price: denied, nothing reserved or signed
- a merchant that overcharges in its real 402 (challenge asks `"100000"`): denied, nothing signed
- a merchant whose 402 redirects payment to another address: denied (`RECIPIENT_MISMATCH`), nothing signed
- a merchant whose 402 asks for a different asset (sandbox USDT): denied (`ASSET_NOT_ALLOWED`, `MINT_MISMATCH`), nothing signed

Reusing an `invocationId` with the same request returns the stored result with no second payment and no second contact with the service; reusing it with a different request returns HTTP 409 `INVOCATION_CONFLICT` with no payment and no budget change.

All money is integer base units as canonical decimal strings end to end; decimals are never assumed (the mint's decimals come from chain via the pinned RPC). The full JSON (receipt, payment evidence, paid result) is in the UI's raw output panel; a judge-facing view comes in Phase 7.

Current limitations and remaining boundaries:

- **sandbox only** -- the only settlement profile is `solana-payment-sandbox`. Its challenges advertise mainnet's CAIP-2 id and the mainnet USDC mint address (the sandbox clones mainnet), so the challenge alone cannot prove the settlement environment; the guarantee comes from the authority-pinned sandbox RPC and authority-fetched sandbox blockhash (see the doc above). No public devnet or mainnet path exists.
- **sandbox USDC** is the mainnet USDC mint address as cloned into the sandbox; it has no real value and wallets are funded with Surfnet cheatcodes
- durable state is single-node SQLite (`/data/authority.db` on the `authority_data` volume) behind an `AuthorityStore` interface; no replication/backup, and startup recovery assumes a single authority process
- the authority's receipt/evidence signing key is persistent (authority-only volume) and pinned by verifiers; the payment wallet is still ephemeral per process (reconciliation needs only the stored payer signature, not the key), so the payer's identity in evidence is authority-attested
- the paid service only receives payment through Pay Kit's own x402 verification; it does not yet verify Virtual Haibin's authorization evidence (Phase 5)
- portable evidence: `GET /evidence/<invocationId>` exports an authority-signed EvidenceBundleV1 that a standalone verifier checks with the authority stopped. Offline it verifies signatures, digests and static policy; with `--online` it also observes settlement on the sandbox RPC. It reports what is only authority-attested (budget totals, offline settlement, result observation) and what no bundle can prove. See [docs/evidence-and-verification.md](docs/evidence-and-verification.md)
- service-side verification (Phase 5C): the paid service refuses any paid request lacking a valid authority-signed `x-vh-authorization` for exactly that request and price, before its x402 gate settles. It signs a `ServiceAcknowledgementV1` (operation performed, payment transaction, result digest) with its own persistent key. With `--service-trust` the verifier reports the service's statement as SERVICE_ATTESTED; result correctness stays not provable
- agent identity is ephemeral: the agent generates a fresh non-extractable Ed25519 *identity* key at startup (it signs authorization requests and can never spend funds); after an agent restart the human must approve a new permit for the new identity
- the human approval boundary is demo-grade: the issuer key is a seed file in the approver's private Docker volume, and approval is gated by a 128-bit approval code the human reads from that volume -- not a wallet, HSM or IAM system. The approver's own network and loopback-only port are defense in depth only; on Docker Desktop other containers can reach the port via `host.docker.internal`, which is why the approval code is required
- one exact operation schema (`summarize`/`export` by `datasetId`) with exact-match comparison; no policy language
- agent-to-authority transport authentication is a dev-only shared bearer secret (`AUTHORITY_SHARED_SECRET` in the gitignored `.env`); it is never treated as proof of agent identity -- the agent's request signature is
- an invocation whose payment outcome is unknown is durably `RECONCILIATION_REQUIRED` (HTTP 409) with its budget reserved; reconciliation resolves it read-only against the sandbox (landed -> `CONFIRMED`; not landed and blockhash expired -> `FAILED`, reservation released). An invocation interrupted before its payment attempt was recorded was provably never transmitted (the attempt is durably committed before the credential can leave the authority), so startup recovery releases it as `FAILED`.

**CI.** `.github/workflows/ci.yml` is the required correctness gate. It runs a frozen install, every unit/security/persistence/payment-protocol/evidence test using local fakes, and typecheck/build inside the project image, with no external network.

The live Pay.sh sandbox integration lives in a **separate** workflow, `.github/workflows/sandbox-integration.yml`. It runs manually or on a daily schedule and is never a merge gate, because it depends on third-party availability. It runs `scripts/sandbox-integration.mjs`, `scripts/semantic-demo.mjs` and `scripts/evidence-demo.sh` after a sandbox-availability preflight. Each step's failure is classified, never hidden:

- **Integration regression** (exit 1): a product assertion failed.
- **External sandbox/environment failure** (exit 3): the sandbox, its RPC or the paid service's facilitator failed, or an externally submitted payment ended `RECONCILIATION_REQUIRED`. The authority correctly keeps it blocked, and neither the product nor the tests retry it.

Checks that depend on such a payment are reported as skipped, and the run still fails.

To rerun the external integration:

- **On GitHub:** Actions → "Sandbox integration (external)" → Run workflow.
- **Locally** (stack up):

  ```bash
  code="$(docker compose exec -T approver cat /keys/approval-code)"
  docker compose run --rm -T -e APPROVER_CODE="$code" demo-driver node scripts/sandbox-integration.mjs
  docker compose run --rm -T -e APPROVER_CODE="$code" demo-driver node scripts/semantic-demo.mjs
  ./scripts/evidence-demo.sh
  ```

A repeated external classification across reruns while the sandbox itself looks healthy deserves investigation as a possible regression.

## Core architecture

```text
apps/
  web/             # User-facing dashboard
  agent/           # Autonomous agent runtime (no signing key, no issuer key)
  approver/        # Human-approval boundary (only holder of the permit-issuer key)
  verifier/        # Standalone evidence verifier CLI (no authority, no network offline)
  authority/        # Protected signer/enforcement boundary
  service-agent/   # Demo / integration service

packages/
  identity/        # Agent and issuer identity models
  mandate/         # Signed PurchasePermit representation, validation, Ed25519 signing/verification
  policy/          # Deterministic authorization decisions
  payments/        # Solana/payment abstractions
  audit/           # Action/evidence event models
  evidence/        # EvidenceBundleV1, signed manifest, strict parser, verifier library
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
real Solana settlement (x402 on the Pay.sh Solana Payment Sandbox)
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
- approver (human-approval boundary; host loopback only): `http://127.0.0.1:4003`

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

`down -v` also deletes the `authority_data` volume, i.e. **all durable authority state** (budgets, invocation history, receipts), the `approver_keys` / `issuer_trust` volumes (the issuer key and approval code; a new issuer is created on next start), the `authority_trust` volume (the authority's receipt key itself lives in `authority_data`, so a new authority key is created too; keep the old public key if you still need to verify old bundles), and the `service_keys` / `service_trust` volumes (a new paid-service key). Use plain `docker compose down` to keep them.

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
- [x402 settlement on the Pay.sh Solana Payment Sandbox](docs/payments-x402-sandbox.md)
- [Human approval boundary and semantic operation authorization](docs/human-approval-and-semantic-authorization.md)
- [Portable evidence and the standalone verifier](docs/evidence-and-verification.md)

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
