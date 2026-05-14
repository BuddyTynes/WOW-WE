# Host Setup

This repo documents Buddy's AzerothCore WotLK playerbots server.

The expected parent folder is:

```text
C:\Users\Buddy\Documents\wow-ai-server
```

The core repo lives at:

```text
C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
```

The LLM bridge lives beside it:

```text
C:\Users\Buddy\Documents\wow-ai-server\llm-bridge
```

## Prerequisites

- Windows with Docker Desktop and WSL working
- PowerShell
- Git
- Enough free C: drive space for Docker images, volumes, and build cache
- WoW 3.3.5a client pointed at this server's auth address

## First-Time Checkout

```powershell
cd C:\Users\Buddy\Documents
mkdir wow-ai-server
cd wow-ai-server
git clone https://github.com/mod-playerbots/azerothcore-wotlk.git
cd azerothcore-wotlk
```

If this setup is published to a new fork, clone that fork instead of the upstream URL.

Copy examples into local files:

```powershell
Copy-Item .env.example .env
Copy-Item docker-compose.override.example.yml docker-compose.override.yml
```

Then clone modules:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\clone-modules.ps1
```

You can also clone them manually from [MODULES.md](MODULES.md).

Apply the local host config:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\apply-host-config.ps1
```

## LLM Bridge

The Compose override expects a sibling folder:

```text
..\llm-bridge
```

That folder needs its own `.env` containing the API key and provider settings. Do not commit that file.

The worldserver talks to the bridge at:

```text
http://wow-llm-bridge:11434/api/generate
```

The host publishes it as:

```text
127.0.0.1:11435
```

## Build

Use direct `buildx` commands instead of `docker compose up --build`; it is easier to monitor and avoids building unnecessary targets.

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk

docker buildx build --progress=plain --target worldserver `
  -t acore/ac-wotlk-worldserver:playerbots-local `
  --build-arg DOCKER_USER=acore `
  --build-arg USER_ID=1000 `
  --build-arg GROUP_ID=1000 `
  --build-arg APPS_BUILD=world-only `
  --build-arg CTOOLS_BUILD=db-only `
  --build-arg BUILD_JOBS=2 `
  -f apps/docker/Dockerfile .

docker buildx build --progress=plain --target db-import `
  -t acore/ac-wotlk-db-import:playerbots-local `
  --build-arg DOCKER_USER=acore `
  --build-arg USER_ID=1000 `
  --build-arg GROUP_ID=1000 `
  --build-arg APPS_BUILD=world-only `
  --build-arg CTOOLS_BUILD=db-only `
  --build-arg BUILD_JOBS=2 `
  -f apps/docker/Dockerfile .
```

On this host, `BUILD_JOBS=2` is conservative for memory. `3` may be possible; `4` can thrash.

## Database Import

Run this after source/module changes that include SQL updates:

```powershell
docker compose --profile setup up -d --no-build ac-db-import
docker compose ps -a
docker compose logs --tail=200 ac-db-import
```

Wait for `ac-db-import` to exit `0`.

## Start

```powershell
docker compose up -d --no-build ac-database wow-llm-bridge ac-authserver ac-worldserver
```

Verify:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Test-NetConnection -ComputerName 127.0.0.1 -Port 3724
Test-NetConnection -ComputerName 127.0.0.1 -Port 8085
Test-NetConnection -ComputerName 127.0.0.1 -Port 11435
```

Expected ports:

```text
3724  authserver
8085  worldserver
11435 LLM bridge on host
3307  MySQL on host
7878  SOAP
```

## Normal Operations

For config-only changes:

```powershell
docker compose up -d --no-build --force-recreate ac-authserver ac-worldserver
```

For full host notes and troubleshooting, see [SERVER_BUILD_RUNBOOK.md](SERVER_BUILD_RUNBOOK.md).
