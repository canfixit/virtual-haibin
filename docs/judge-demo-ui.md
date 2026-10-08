# Judge-facing demo UI (Phase 6)

`http://localhost:5173`: one page that shows, in 30–60 seconds, that

> a valid payment does not necessarily mean the AI agent was authorized to buy that operation.

## Running it

```bash
docker compose up -d --wait
docker compose exec approver cat /keys/approval-code   # paste into step 01
```

Then:

1. **Approve permission:** summarize(dataset-a)
2. **Run approved operation**
3. **Try unauthorized export**
4. **Verify evidence**

The page uses:

| Service | URL | Purpose |
|---|---|---|
| agent | `http://localhost:4000` | `/identity`, `/permit`, `/demo`, `/evidence/:id` |
| approver | `http://127.0.0.1:4003` | human approval, with the approval code |
| verifier-api | `http://localhost:4004` | the standalone verifier |

## Sections, and where each value comes from

Nothing on the page is simulated. A step without backing data is shown as *not reached* or *checking*, never as done.

| Section | Source |
|---|---|
| 01 Human approval | approver `/health` terms; the signed PurchasePermit returned by `/approvals` |
| 02 Agent action | agent `/demo` with `summarize` or `export` on `dataset-a` |
| 03 Decision + timeline | the authority's signed receipt (decision, reason codes), the payment evidence and service result returned by the agent, then the exported evidence bundle and the verifier's report (service authorization) |
| 04 Same payment, different operation | both real requests. Payment terms are taken from the authority-signed receipts, and SAME/DIFFERENT is computed from the raw values, never asserted |
| How it works | orientation only: which stops the last request reached |
| Verify evidence | bundle relayed by the agent from the authority's `/evidence/:id`, checked by `verifier-api` offline, or online, which also observes settlement on the sandbox RPC |
| Technical details | raw permit, responses, bundle and report; extra adversarial tests (`summarize(dataset-b)`, merchant overcharge, wrong recipient, wrong asset) |

### Why relaying the evidence through the agent is safe

The browser must not hold the authority's bearer secret, so the agent relays the bundle. That gives the agent no power over the result. The bundle is accepted only if its signatures verify against keys the verifier pinned independently, and a modified bundle is INVALID.

### `verifier-api`

`verifier-api` is the same library as the CLI (`packages/evidence`) behind a small HTTP front. It is constrained in four ways:

- It holds no keys and has no database.
- It mounts the repository, its dependencies and the three *public* trust files read-only.
- It sits on its own `verification` network, so it cannot resolve or reach the authority, agent, approver or service (tested).
- Its online mode queries only its own configured sandbox RPC.

## Verifier status styling

| Status | Style | Meaning |
|---|---|---|
| VERIFIED | solid purple | checked by the verifier |
| SERVICE_ATTESTED | outlined purple | the service's own signed statement; its signature is verified, its truth is not |
| AUTHORITY_ATTESTED | neutral outline | supported only by the authority's signed statement |
| NOT PROVABLE | dashed, muted | outside what any bundle can prove (listed under *Limits of proof*) |
| NOT_SATISFIED | red outline | a policy condition that fails, consistent with a DENY |
| INVALID | solid red | evidence not acceptable |
| NOT_CHECKED / INDETERMINATE | muted | not applicable / could not be decided |

## Brand colours

All colours live in `apps/web/src/theme.css`. Components use only its variables (a test enforces this).

```css
--canfixit-blue:   #2563eb; /* Blue Team   — human approval, permit, trusted issuer */
--canfixit-red:    #dc2626; /* Red Team    — attempted violation, blocked, no payment */
--canfixit-purple: #9333ea; /* Purple Team — Virtual Haibin, verification, evidence */
```

These are the Tailwind 600 shades found in the canfixit.com.au stylesheet, which uses the blue-500/600, red-500/600 and purple-500/600/800 families. Tints, borders and strong variants are derived with `color-mix`, so changing the three values re-themes the page. Neutrals follow the site's Tailwind gray scale, and type uses the same system font stack. No CanFixIT asset is copied; the logo is a text wordmark.

## Safety properties of the page

- The approval code is a password field held in page memory only. It is sent only as an `Authorization` header to the approver and cleared after a successful approval. It is never written to localStorage, sessionStorage, cookies or URLs, and never logged. This is enforced by a static test and checked in a real browser.
- The environment badge always reads *Solana payment sandbox · no real funds*. The page never claims mainnet; a test enforces this too.
- The browser never holds a private key, the bearer secret or the approval code beyond the approval request.
