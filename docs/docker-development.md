# Docker-first development

Virtual Haibin is designed to be developed without installing Node.js, pnpm, Git, or project dependencies into WSL.

The only host-level requirement is a working Docker engine / Docker Desktop WSL integration.

## Why this setup

The repository is bind-mounted into the development containers so source edits are immediately visible.

All dependency directories are mounted as Docker-managed named volumes:

- root `node_modules`
- each app `node_modules`
- each shared package `node_modules`

This prevents pnpm dependencies and native build artifacts from being written into the WSL project tree.

## Clone without installing Git in WSL

Because the repository is public, use a temporary Git container:

```bash
mkdir -p ~/Projects
cd ~/Projects

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" \
  -w /work \
  alpine/git \
  clone https://github.com/canfixit/virtual-haibin.git
```

Then:

```bash
cd virtual-haibin
```

No Git binary is installed into WSL. The `.git` directory belongs to the project as normal.

## Create the local secrets file

Compose requires `AUTHORITY_SHARED_SECRET` (a dev-only agent -> authority bearer token) and will refuse to start without it. Create the gitignored `.env` once:

```bash
cp .env.example .env
sed -i "s|^AUTHORITY_SHARED_SECRET=.*|AUTHORITY_SHARED_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')|" .env
```

Never commit `.env`. The authority refuses to start with the `.env.example` placeholder or a secret shorter than 32 characters.

## Start the development stack

```bash
docker compose up --build
```

Services:

- web UI: http://localhost:5173
- Virtual Haibin agent: http://localhost:4000
- authority (protected signer): http://localhost:4002
- mock service agent: http://localhost:4001
- approver (human-approval boundary): http://127.0.0.1:4003 (host loopback only, on its own `approval` network)

The agent talks to the service agent and authority over Docker's internal network using:

```text
http://service-agent:4001
http://authority:4002
```

The browser talks to the exposed agent port using:

```text
http://localhost:4000
```

The browser also talks to the approver at `http://127.0.0.1:4003`. Approvals require the human's approval code, which lives only in the approver's private volume:

```bash
docker compose exec approver cat /keys/approval-code
```

Volumes involved in the approval boundary:

- `approver_keys`: the issuer private key seed and the approval code. Mounted **only** by `approver`.
- `issuer_trust`: the issuer **public** key. Written by `approver`, mounted read-only by `authority`.

Scripted demo and integration runs use the `demo-driver` tools container. It stands in for the human's browser and can reach both the approver and the agent:

```bash
docker compose run --rm \
  -e APPROVER_CODE="$(docker compose exec -T approver cat /keys/approval-code)" \
  demo-driver node scripts/semantic-demo.mjs
```

## Run in the background

```bash
docker compose up --build -d
```

Follow logs:

```bash
docker compose logs -f
```

Or inspect one service:

```bash
docker compose logs -f agent
docker compose logs -f service-agent
docker compose logs -f web
```

## Stop the stack

```bash
docker compose down
```

This keeps dependency volumes for the next startup.

To remove the dependency volumes as well:

```bash
docker compose down -v
```

The next `up --build` recreates them from the development image.

**Warning:** `down -v` also deletes the `authority_data` volume, which holds the authority's durable SQLite state (`/data/authority.db`: grant budgets, invocation ids/states and receipts). Plain `docker compose down` and container restarts keep it. The database lives only on that volume; `*.db` files are gitignored and never belong in the source tree.

Evidence verification uses two tools-profile services. Bundles are exported to the gitignored `.evidence/` directory:

- `verifier` runs with `network_mode: none`, read-only repository and dependencies, and read-only public trust files at `/trust/issuer/trusted-issuer` and `/trust/authority/authority.pub`.
- `verifier-online` is the same, plus network access for `--online` sandbox settlement checks.

```bash
./scripts/evidence-demo.sh
```

The authority's receipt-signing seed lives in `authority_data` (authority only). Its public key is published to `authority_trust`, which the verifiers and the paid service mount read-only.

The paid service's acknowledgement seed lives in `service_keys` (service only). Its public key is published to `service_trust`, which the authority and the verifiers mount read-only. The authority starts after the service, because it pins the service's key. The service reads the authority's key lazily, on its first paid request.

`down -v` likewise deletes `approver_keys` and `issuer_trust`. On the next start the approver creates a **new** issuer key and approval code, and the authority trusts only the new issuer.

## Run checks inside Docker

No Node.js or pnpm is required on the host:

```bash
docker compose run --rm agent pnpm check
```

## Install a dependency

Install through a container, not on the WSL host.

For example, to add a dependency to the agent workspace:

```bash
docker compose run --rm agent \
  pnpm --filter @virtual-haibin/agent add <package>
```

This updates the repository's package metadata while package binaries remain in Docker-managed volumes.

After changing dependencies, rebuild:

```bash
docker compose up --build
```

## Git operations without host Git

For read-only/public Git operations, use a temporary Git container.

Check status:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/repo" \
  -w /repo \
  alpine/git status
```

Pull:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/repo" \
  -w /repo \
  alpine/git pull --ff-only
```

Authenticated pushes should use an explicitly configured credential or SSH mount rather than placing tokens in the image or repository.

## Isolation boundary

The host / WSL environment contains only:

- project source files
- the repository's `.git` metadata
- Docker CLI integration

The containers contain:

- Node.js
- pnpm
- JavaScript dependencies
- TypeScript tooling
- Vite
- application runtime processes

This keeps the WSL distribution clean while retaining normal source-code editing and hot reload.
