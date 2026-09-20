# Virtual Haibin

**Verifiable authority for AI agents.**

Virtual Haibin is an autonomous AI agent project exploring how AI agents can act on behalf of humans with **verifiable identity, delegated authority, bounded permissions, auditable actions, and machine-to-machine payments**.

The immediate goal is to build a focused MVP for the **Colosseum / Superteam Crypto World's Fair 2026** while keeping every core component useful for the longer-term Virtual Haibin platform.

## Product thesis

AI agents are becoming capable of calling tools, interacting with services, and moving money. But giving an agent access to a wallet or API does not prove that it was legitimately authorised to act.

Virtual Haibin is exploring a model where a human or organisation can issue a constrained mandate describing:

- who the agent is
- what capabilities it may use
- what services it may interact with
- how much it may spend
- when the authority expires
- how actions can be verified and audited

The long-term thesis is that **IAM and blockchain should complement each other**:

- IAM defines identity, roles, permissions, capabilities, delegation, and policy.
- Blockchain can provide verifiable authorization, settlement, tamper-resistant records, and independent auditability.

## Crypto World's Fair 2026

The current competition strategy is approximately:

- **70%** focused on a strong World's Fair vertical slice
- **30%** focused on reusable Virtual Haibin platform foundations

These are not separate projects. The hackathon MVP is intended to be the first deployable component of the broader system.

The exact MVP remains intentionally flexible until mentor and ecosystem feedback is incorporated.

### Current candidate MVP

**Delegated autonomous commerce**

```text
Human / Organization
        |
        | signed mandate
        v
Virtual Haibin Agent
        |
        +--> Identity
        +--> Policy / Authority
        +--> Wallet / Payments
        +--> Audit
        |
        v
External Agent / Service / Tool
```

A user delegates a bounded task and budget to Virtual Haibin. The agent verifies the mandate, checks policy, interacts with an external service, performs an allowed machine-to-machine payment, and records an auditable result.

A request outside the delegated authority should be denied rather than executed.

## Core architecture

The project is being designed around reusable components:

```text
apps/
  web/             # User-facing dashboard
  agent/           # Virtual Haibin runtime
  service-agent/   # Demo / integration service

packages/
  identity/        # Agent and issuer identity
  mandate/         # Delegation and signed authority
  policy/          # Capability and spending decisions
  payments/        # Solana / machine payment abstractions
  audit/           # Verifiable action records
```

The repository will be built incrementally. This structure describes the intended architecture and may evolve as the MVP is validated.

## Design principles

1. **Bounded autonomy** — agents should receive explicit, constrained authority rather than unlimited access.
2. **Verifiable delegation** — an agent should be able to prove that it is authorised to perform an action.
3. **Policy before execution** — identity, capability, budget, expiry, and other constraints should be checked before an irreversible action.
4. **Auditability** — actions, policy decisions, and payments should be attributable and inspectable.
5. **Composable infrastructure** — Virtual Haibin should integrate with existing Solana, payment, agent, and IAM infrastructure rather than rebuilding everything.
6. **MVP first** — establish a working vertical slice before adding deeper protocol complexity.

## Roadmap

Current high-level sequence:

```text
working end-to-end skeleton
        ->
delegation / mandate
        ->
policy enforcement
        ->
Solana integration
        ->
machine-to-machine payment
        ->
verifiable audit UX
        ->
external integrations / validation
```

Major features such as long-term memory, multi-agent marketplaces, robotics control, cross-chain support, reputation systems, and advanced multi-agent conflict resolution are deliberately deferred until the core authority model is validated.

## Longer-term direction

Virtual Haibin is intended to grow beyond the hackathon into a personal autonomous AI/digital-agent architecture covering:

- agent-to-agent interaction
- identity and delegated authority
- autonomous payments
- secure tool execution
- machine-to-machine trust
- robotics / physical AI
- policy and precedence between autonomous actors

A longer-term research question is:

> When autonomous agents or robots reach conflicting decisions, how should identity, authority, delegation, policy, and priority determine which decision takes precedence?

## Project documents

- [Strategy and World's Fair roadmap](docs/strategy.md)
- [Provisional MVP plan](docs/mvp-plan.md)

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
