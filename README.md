# Buddy WoW AI Server

This repository is the working setup for Buddy's private AzerothCore WotLK server with playerbots, progression gating, Hardcore, AOE loot, Auction House bot, and LLM-backed bot chat.

It is based on:

```text
https://github.com/mod-playerbots/azerothcore-wotlk
```

## What This Setup Runs

Docker services:

```text
ac-database
ac-authserver
ac-worldserver
wow-llm-bridge
```

Gameplay configuration:

```text
Playerbots: enabled, 250 random bots
Progression: Vanilla phase 1
Hardcore: enabled
XP: 1.2x
AOE loot: enabled
Auction House bot: enabled
LLM whispers: enabled
LLM guild/party director: enabled through wow-llm-bridge
LLM playerbot guild invite decisions: enabled
Name/chat profanity: server-side name checks disabled; client chat filter may still be local
```

## Quick Start For Another Helper

Read these in order:

1. [SETUP.md](SETUP.md)
2. [MODULES.md](MODULES.md)
3. [SERVER_BUILD_RUNBOOK.md](SERVER_BUILD_RUNBOOK.md)
4. [doc/LLM_NPC_DESIGN.md](doc/LLM_NPC_DESIGN.md)
5. [doc/LLM_NPC_EXECUTION_PLAN.md](doc/LLM_NPC_EXECUTION_PLAN.md)
6. [doc/LLM_NPC_MEMORY_MCP_SCHEMA.md](doc/LLM_NPC_MEMORY_MCP_SCHEMA.md)

For this host, the normal startup command is:

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
docker compose up -d --no-build ac-database wow-llm-bridge ac-authserver ac-worldserver
```

For a fresh checkout:

```powershell
Copy-Item .env.example .env
Copy-Item docker-compose.override.example.yml docker-compose.override.yml
Copy-Item .\tools\WoWLlmBridge\.env.example .\tools\WoWLlmBridge\.env
powershell -ExecutionPolicy Bypass -File .\scripts\clone-modules.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\apply-host-config.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\restore-live-db.ps1
```

Check status:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

## Files That Are Local On Purpose

These should not be committed:

```text
.env
docker-compose.override.yml
env/dist
build logs
Docker volumes
tools\WoWLlmBridge\.env
tools\WoWLlmBridge\data
```

Use these tracked examples instead:

```text
.env.example
docker-compose.override.example.yml
```

## Current Notes

The repo includes a split live database snapshot in `backups\`. Restore it with
`scripts\restore-live-db.ps1` after the database container exists.

The Dockerfile and `.dockerignore` contain local build fixes for this older Windows host. The main one is trimming Docker context and building with `WITHOUT_GIT=1`; this avoids long silent Docker hangs before BuildKit output appears.

Do not run broad Docker prune/delete commands unless you preserve:

```text
azerothcore-wotlk_ac-database
azerothcore-wotlk_ac-client-data
```

Live server state is stored in Docker volume `azerothcore-wotlk_ac-database` after restore. Use `scripts\backup-live-db.ps1` if someone needs a fresh portable snapshot.

## Publishing This Setup

This checkout currently points at the upstream mod-playerbots remote. To share this as Buddy's setup, create a new GitHub repo/fork and point `origin` at that repo:

```powershell
git remote set-url origin https://github.com/<owner>/<repo>.git
git push -u origin HEAD
```
