# Contributing To This Server Setup

This repo is a working game-server setup, not a clean upstream AzerothCore package. Keep changes practical and documented.

## Do Commit

- Docs that explain setup or operations
- Dockerfile/build fixes
- Example files such as `.env.example`
- Helper scripts under `scripts`
- Small config-generation scripts

## Do Not Commit

- `.env`
- `docker-compose.override.yml`
- API keys
- `env/dist`
- Build logs
- Docker volumes or database dumps with private account/player data
- Full module directories unless we intentionally switch to submodules or vendored modules

## Before Handing Off

Run:

```powershell
git status --short
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

If source or module code changed, update:

```text
MODULES.md
SERVER_BUILD_RUNBOOK.md
```

If startup behavior changed, update:

```text
README.md
SETUP.md
```
