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

## Start the development stack

```bash
docker compose up --build
```

Services:

- web UI: http://localhost:5173
- Virtual Haibin agent: http://localhost:4000
- mock service agent: http://localhost:4001

The agent talks to the service agent over Docker's internal network using:

```text
http://service-agent:4001
```

The browser talks to the exposed agent port using:

```text
http://localhost:4000
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
