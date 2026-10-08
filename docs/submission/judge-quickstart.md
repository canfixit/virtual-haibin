# Judge quickstart

About 10 minutes. You need **Docker only**: Docker Desktop, or Docker Engine with the Compose plugin. No Node.js, pnpm, Solana CLI or Git is required on your machine. The commands below are for bash (Linux, macOS, or WSL on Windows).

**External dependency.** Payments settle on the **Pay.sh Solana Payment Sandbox** (`https://402.surfnet.dev:8899`), a hosted Solana test validator. Your machine needs outbound internet access to it. No wallet, faucet or real funds are involved: the authority creates an ephemeral sandbox wallet and funds it with sandbox cheatcodes.

## 1. Clone (no host Git needed)

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
  alpine/git clone https://github.com/canfixit/virtual-haibin.git
cd virtual-haibin
```

(If you have Git, `git clone https://github.com/canfixit/virtual-haibin.git` works too.)

## 2. Create the local secret file

```bash
cp .env.example .env
sed -i "s|^AUTHORITY_SHARED_SECRET=.*|AUTHORITY_SHARED_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')|" .env
```

On macOS's BSD `sed`, use `sed -i ''` instead of `sed -i`. `.env` is gitignored. The authority refuses to start with the placeholder value.

## 3. Start the stack

```bash
docker compose up --build -d --wait
```

The first run builds the development image and installs dependencies inside it. How long this takes depends on the npm registry and your connection. In one fresh-clone test on 2026-10-08, `pnpm install` inside the image build took about 30 minutes. Later starts reuse the cached image and take under a minute. When it finishes, these are running:

| Service | URL | Role |
|---|---|---|
| web | http://localhost:5173 | Demo UI |
| agent | http://localhost:4000 | The AI agent (no wallet) |
| service-agent | http://localhost:4001 | Mock paid API (x402 / Pay Kit) |
| authority | http://localhost:4002 | Virtual Haibin enforcement + payment signer |
| approver | http://127.0.0.1:4003 | Human approval (holds the issuer key) |
| verifier-api | http://localhost:4004 | Standalone verifier for the UI |

Check: `docker compose ps` should show each service `running`, and every service except `web` also `healthy`.

## 4. Get the approval code

Approval is the human's job. The approval code is only readable from inside the approver's private volume:

```bash
docker compose exec approver cat /keys/approval-code
```

Copy it. Do not paste it anywhere except the approval field in the UI.

## 5. The demo in the browser

Open **http://localhost:5173**.

1. **01 Human approval.** Paste the approval code and click **Approve permission**. You should see "PurchasePermit issued — Human approved summarize(dataset-a)", with a 50,000-unit budget and a 20,000-unit per-call limit.
2. **02 Agent action → Run approved operation.** Expect **AUTHORIZED**: 0.01 sandbox USDC (10,000 units) paid, a transaction signature, and a summary result. The timeline shows *Service authorization: VERIFIED — Service checked Virtual Haibin's signature before settling* and *Payment: SETTLED*. This usually takes 5–20 seconds.
3. **02 Agent action → Try unauthorized export.** Expect **BLOCKED** with `OPERATION_NOT_AUTHORIZED`, plus "No service request. No transaction signed. No payment." Budget, x402 challenge and payment all show *NOT REACHED*.
4. **04 Same payment. Different operation.** Every row is SAME except *Agent asks* (`summarize` vs `export`). Decision: ALLOW vs DENY. Payment: SETTLED vs NONE.
5. **Verify evidence.** The approved purchase's evidence was already checked by the separate verifier: **VALID**, *Offline: no network access*. Click **Verify + observe settlement on-chain** to also observe the transaction on the sandbox RPC. *Settlement* then changes from AUTHORITY-ATTESTED to VERIFIED.
6. Optional: **Technical details** contains raw JSON and more adversarial tests:
   - `summarize(dataset-b)` → `OPERATION_ARGUMENT_NOT_AUTHORIZED`
   - merchant overcharge, wrong recipient, wrong asset → DENY, nothing signed

## 6. Evidence with the authority switched off (CLI)

This proves that verification does not depend on Virtual Haibin being online.

**Option A: one script.** Run it from the repo root on the host; it needs bash and Docker only.

```bash
./scripts/evidence-demo.sh
```

It buys `summarize(dataset-a)` and is denied `export(dataset-a)`, exports both evidence bundles, **stops the authority**, and runs these checks:

- verifies both bundles offline
- tampers with operation, amount, recipient, settlement, authority key and service acknowledgement, each of which must become INVALID
- verifies online against the sandbox RPC
- restarts the authority and confirms its signing key did not change
- confirms the paid service refuses a payment that lacks Virtual Haibin's authorization

The last line is `All evidence demo checks passed.` (exit 0). Exit 3 means an external sandbox failure; see Troubleshooting.

**Option B: step by step.**

```bash
code="$(docker compose exec -T approver cat /keys/approval-code)"
docker compose run --rm -T --user "$(id -u):$(id -g)" -e APPROVER_CODE="$code" \
  demo-driver node scripts/export-evidence.mjs
# prints: {"allow":".evidence/<run>-summarize-a.json","deny":".evidence/<run>-export-a.json","transactionId":"…"}

docker compose stop authority

# Offline verifier: this container has NO network at all (network_mode: none)
docker compose run --rm verifier verify .evidence/<run>-summarize-a.json --offline \
  --issuer-trust /trust/issuer/trusted-issuer \
  --authority-trust /trust/authority/authority.pub \
  --service-trust /trust/service/service.pub
# -> overall: VALID   (exit 0)

# Optional online check: observes the transaction on the sandbox RPC (still no authority)
docker compose run --rm verifier-online verify .evidence/<run>-summarize-a.json --online \
  --issuer-trust /trust/issuer/trusted-issuer \
  --authority-trust /trust/authority/authority.pub \
  --service-trust /trust/service/service.pub

docker compose start authority
```

The trust roots are **public** keys mounted read-only from Docker volumes. The verifier never reads trust from the bundle itself.

## 7. Run the automated tests (optional)

These are the same commands as the deterministic CI gate (`.github/workflows/ci.yml`). They need no external network, sandbox or keys. Every test uses local fakes.

```bash
docker compose run --rm -T --no-deps agent sh -euc '
  for p in identity mandate policy payments authority approver agent evidence verifier service-agent web; do
    pnpm --filter @virtual-haibin/$p test
  done
  pnpm check
'
```

`pnpm check` on its own runs only the typecheck and the web build.

## 8. Clean up

```bash
docker compose down        # stop; keeps keys, budgets and history
docker compose down -v     # also deletes ALL volumes: issuer/authority/service keys, SQLite state
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AUTHORITY_SHARED_SECRET is required` | Step 2 was skipped. Create `.env`. |
| `up --wait` fails; `docker compose logs authority` says the secret must be at least 32 characters, not the placeholder | `.env` still has the example value. Rerun the `sed` line, then `docker compose up -d --wait`. |
| Approval fails with 401 | Wrong or partial approval code. Re-read it (step 4). The code changes after `docker compose down -v`. |
| "Your demo session has ended…" | The 60-minute demo session expired, or the agent restarted (the agent's identity key is per process). Approve again. |
| Outcome card says **Request refused · RECONCILIATION_REQUIRED** | The hosted sandbox or its facilitator timed out **after** the payment was sent. Virtual Haibin cannot know whether it settled, so it keeps the invocation blocked and never retries it automatically. This is the safety behaviour, not a crash. Click **Run approved operation** again: this starts a **new** purchase with a new invocation ID, and the budget allows it. You can also approve again for a fresh budget. |
| `evidence-demo.sh` exits 3 / "EXTERNAL ENVIRONMENT FAILURE" | Same cause: the sandbox was unavailable. No product check failed. Rerun later. |
| Online verification `INDETERMINATE` | The verifier could not reach the sandbox RPC. Offline verification is unaffected. |
| Port already in use | Another process uses 4000–4004 or 5173. Stop it, or edit the `ports:` entries in `compose.yaml`. |
| Old evidence no longer verifies after `down -v` | `down -v` created new keys. Old bundles verify only against the old public keys. |
| Check sandbox reachability | `docker run --rm curlimages/curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' https://402.surfnet.dev:8899` should print `"result":"ok"`. |

Next: [architecture](architecture.md) · [security and limitations](security-and-limitations.md)
