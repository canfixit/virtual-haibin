# Claude Code Handoff — Start Here

Date: 22 September 2026

This is the execution handoff for the next implementation phase.

The product decision and longer roadmap are documented elsewhere. This file tells you exactly what to implement first and what “done” means.

## Immediate task

Implement **Phase 1: Signed PurchasePermit**.

Do not implement the signer service, persistent budgets, Solana transfer, or UI redesign in the same first change unless a tiny supporting change is strictly required.

The goal is to replace the current `mock-signature` concept with a real, testable, versioned authorization object.

## Why this comes first

Current code can evaluate a few policy fields, but it cannot prove that a human/issuer actually authorized those fields.

The existing runtime creates:

```ts
signature: "mock-signature"
```

and the policy evaluator does not verify it.

Before the project can honestly claim verifiable permission, we need a signed object whose security-relevant fields cannot be mutated without invalidating the signature.

## Phase 1 deliverables

### A. New PurchasePermit domain model

Refactor/extend `packages/mandate` around a narrow v1 purchase permit.

The exact TypeScript names may vary, but the model must cover:

```text
version
domain
grantId
issuer
authorizedAgent
service
capability
network
mint
recipient
maxPerCallAtomic
maxTotalAtomic
issuedAt
expiresAt
subdelegation
signature
```

Recommended semantics:

- `version`: explicit protocol/schema version, initially 1.
- `domain`: constant domain-separation string, e.g. a Virtual Haibin purchase-permit namespace.
- `grantId`: globally unique grant identifier.
- `issuer`: authoritative public key/identity of the human or organization issuing the permit.
- `authorizedAgent`: identity/public key of the agent that may use it.
- `service`: stable service identifier and/or origin required for the demo.
- `capability`: exact operation, e.g. `research.summary`.
- `network`: explicit Solana cluster for the MVP, e.g. `devnet`.
- `mint`: authoritative token mint address/identifier; do not rely on display label `USDC`.
- `recipient`: authoritative Solana payment recipient.
- `maxPerCallAtomic`: integer atomic units.
- `maxTotalAtomic`: integer atomic units.
- `issuedAt`: issuance time.
- `expiresAt`: expiry time.
- `subdelegation`: false for v1 unless there is a documented reason otherwise.
- `signature`: algorithm/key/signature metadata sufficient for verification.

Avoid unsafe JS-number accounting for token quantities.

If decimal-string atomic amounts are used, validate that they are canonical non-negative/positive integer strings as appropriate.

### B. Strict validation

Add a validation function that rejects malformed permits before signature/policy use.

At minimum validate:

- known version
- exact expected domain
- non-empty grant ID
- valid issuer key format
- valid authorized-agent identity/key format
- non-empty service/capability
- supported network
- valid mint format
- valid recipient format
- positive per-call limit
- positive total limit
- per-call limit <= total limit
- finite/safe timestamps
- expiry > issuance
- subdelegation false for v1
- signature metadata well-formed

Do not silently normalize attacker-controlled values in a way that changes signed semantics after verification.

### C. Canonical signing representation

Create one canonical unsigned representation used by both signing and verification.

The signature must cover every field that could widen authority.

Do not sign the `signature` field itself.

The implementation must have deterministic byte output.

Prefer a well-established canonical encoding/library rather than inventing security-sensitive serialization casually.

If adding a canonicalization dependency, document why it was chosen.

Add a domain/version prefix even if the domain/version fields are already part of the object; explicit domain separation is desirable.

### D. Ed25519 signing/verification

Use a maintained Solana-compatible Ed25519 implementation.

Requirements:

- test/dev signing helper may accept a private key/keypair
- production-facing verification accepts public data only
- no private key is stored in the permit
- invalid signature fails closed
- wrong issuer/public key fails
- malformed signature does not crash the process

Do not write Ed25519 manually.

### E. Tests

Create automated tests for at least:

1. valid permit verifies
2. change `grantId` -> verification fails
3. change authorized agent -> fails
4. change service -> fails
5. change capability -> fails
6. change network -> fails
7. change mint -> fails
8. change recipient -> fails
9. change per-call amount -> fails
10. change total amount -> fails
11. change issuedAt -> fails
12. change expiresAt -> fails
13. change subdelegation -> fails/rejected
14. wrong issuer key -> fails
15. malformed signature -> fails safely
16. unknown version -> rejected
17. wrong domain -> rejected
18. malformed atomic amounts -> rejected
19. max-per-call > max-total -> rejected
20. expiry <= issuance -> rejected

Prefer table-driven tests where that keeps the code readable.

### F. Policy preparation

Refactor the policy types enough that the next phase can stop depending on:

```ts
amount: number
alreadySpent: number
token: "USDC"
```

Do not implement durable budget state yet, but move security-sensitive monetary values toward integer atomic units and authoritative mint/network/recipient fields.

Do not make `alreadySpent` look authoritative if it is still caller supplied.

If a temporary compatibility layer is required for the current demo, clearly mark it as transitional.

### G. Agent compatibility

Keep the existing demo runnable if practical, but do not fake cryptographic verification.

Preferred approach:

- update the demo to use a real ephemeral/dev permit-signing flow only if that can be done without creating a misleading production architecture
- otherwise isolate legacy demo compatibility and document that the agent integration will move to the new signed permit in Phase 2

Do not put a persistent private key in source code.

Do not commit generated key files.

## Suggested package API

This is guidance, not a mandatory exact API:

```ts
type UnsignedPurchasePermitV1 = { ... };
type SignedPurchasePermitV1 = UnsignedPurchasePermitV1 & {
  signature: PermitSignature;
};

validateUnsignedPurchasePermit(...);
canonicalizeUnsignedPurchasePermit(...): Uint8Array;
signPurchasePermit(...): SignedPurchasePermitV1;
verifyPurchasePermit(...): VerificationResult;
```

Prefer returning structured verification results or typed errors over throwing for expected invalid-input cases.

Possible stable reason codes:

```text
INVALID_SCHEMA
UNSUPPORTED_VERSION
INVALID_DOMAIN
INVALID_ISSUER
INVALID_AGENT
INVALID_SERVICE
INVALID_CAPABILITY
INVALID_NETWORK
INVALID_MINT
INVALID_RECIPIENT
INVALID_AMOUNT
INVALID_TIME_RANGE
INVALID_SIGNATURE
```

Do not over-engineer a generic error framework.

## Security review checklist before finishing Phase 1

Confirm explicitly:

- [ ] signature covers all security-relevant fields
- [ ] canonical bytes are deterministic
- [ ] signature field excluded from signed payload
- [ ] wrong public key fails
- [ ] malformed signature fails closed
- [ ] no private key committed
- [ ] atomic amounts avoid floating point
- [ ] mint and recipient are authoritative identifiers
- [ ] domain/version separation exists
- [ ] tests mutate every authority-widening field
- [ ] validation runs before data reaches later policy/signing paths

## Docker commands

Do not install tools in WSL.

Examples:

```bash
docker compose build
docker compose run --rm agent pnpm check
```

For package-specific testing, add appropriate workspace scripts and run them via Docker.

If using Node's test runner with tsx, keep it simple and document the script.

After dependency changes:

```bash
docker compose up -d --build --wait
```

Then smoke test:

```bash
curl --fail http://localhost:4000/health
curl --fail http://localhost:4001/health
curl --fail http://localhost:5173/
```

Host `curl` is optional; use a container if the host does not provide it.

## Phase 1 definition of done

Phase 1 is done only when:

1. Real Ed25519 permit signing and verification exist.
2. Permit validation is strict.
3. Atomic token limits no longer rely on floating point inside the new permit.
4. Every security-relevant permit field is signature-bound.
5. The tests listed above pass.
6. Existing workspace typecheck/build passes.
7. Docker build/stack still works.
8. No secret/private key appears in tracked source.
9. Documentation accurately distinguishes Phase 1 from unimplemented signer/Solana/payment work.
10. A concise completion report is produced.

## Completion report format

When Phase 1 is finished, report:

```text
PHASE 1 — SIGNED PURCHASE PERMIT

Implemented:
- ...

Security decisions:
- signing library:
- canonical encoding:
- key/public identifier format:
- atomic amount representation:

Tests:
- targeted:
- full workspace:
- Docker/Compose:

Remaining mocks / not yet implemented:
- protected signer:
- durable budget:
- replay persistence:
- Solana payment:
- service verification:
- evidence receipt:

Files changed:
- ...

Recommended Phase 2 starting point:
- ...
```

Do not proceed to Phase 2 until Phase 1 is green and the completion report has been shown to the user, unless the user explicitly tells you to continue automatically.
