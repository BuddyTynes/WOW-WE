# Host Setup

This repo documents an AzerothCore WotLK playerbots server.

The setup can live anywhere on the host. In this guide:

- `<server-root>` is the base folder that contains this checkout and any
  sibling services.
- `<core-repo>` is this AzerothCore checkout folder.

Choose any folder for `<server-root>`, then clone or place this repository
inside it as `<core-repo>`.

The core repo lives at:

```text
<server-root>\<core-repo>
```

The LLM bridge source lives in the repo:

```text
<server-root>\<core-repo>\tools\WoWLlmBridge
```

## Prerequisites

- Windows with Docker Desktop and WSL working
- PowerShell
- Git
- Enough free space on the Docker data drive for images, volumes, and build
  cache
- WoW 3.3.5a client pointed at this server's auth address

## First-Time Checkout

```powershell
cd <server-root>
git clone https://github.com/mod-playerbots/azerothcore-wotlk.git <core-repo>
cd <core-repo>
```

If this setup is published to a new fork, clone that fork instead of the upstream URL.

Copy examples into local files:

```powershell
Copy-Item .env.example .env
Copy-Item docker-compose.override.example.yml docker-compose.override.yml
Copy-Item .\tools\WoWLlmBridge\.env.example .\tools\WoWLlmBridge\.env
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

The Compose override expects the tracked bridge source at:

```text
.\tools\WoWLlmBridge
```

That folder needs its own `.env` containing provider settings. Do not commit
that file.

```powershell
Copy-Item .\tools\WoWLlmBridge\.env.example .\tools\WoWLlmBridge\.env
```

The default `.env.example` is set up for the free local llama.cpp path. Run a
llama.cpp OpenAI-compatible server on the Windows host, reachable from Docker
at:

```text
http://host.docker.internal:8088/v1
```

Recommended starting llama.cpp settings for the local 8 GB RTX 3060 Ti target:

```text
--host 0.0.0.0
--port 8088
--model <path-to-gemma-3n-E2B-it-Q4_K_M.gguf>
--ctx-size 4096
--n-gpu-layers 99
--batch-size 512
--ubatch-size 128
--flash-attn
```

The bridge `.env` should then contain:

```text
WOW_LLM_PROVIDER=openai-compatible
WOW_LLM_MODEL=gemma-3n-E2B-it-Q4_K_M
WOW_LLM_BASE_URL=http://host.docker.internal:8088/v1
WOW_LLM_API_KEY=local-llama
```

`WOW_LLM_API_KEY` only needs a non-empty placeholder for llama.cpp; the local
server does not use a paid API key.

The worldserver talks to the bridge at:

```text
http://wow-llm-bridge:11434/api/generate
```

Repo-owned modules also use the bridge for director events and playerbot guild
invite decisions:

```text
http://wow-llm-bridge:11434/api/director/event
http://wow-llm-bridge:11434/api/bot-guild-invite/decision
```

The bridge also imports the tracked Spice of Life chat seed on startup:

```text
tools\WoWLlmBridge\seeds\spice_chat_pool.seed.jsonl
```

To refresh that seed from local ElvUI exports, put `.lua` files in
`tools\ChatLogPool\unparsed logs`, then run:

```powershell
node .\tools\ChatLogPool\import-chat-logs.js
```

The raw and parsed `.lua` files stay local; commit only the regenerated seed.

The host publishes it as:

```text
127.0.0.1:11435
```

Before using `docker compose up --no-build`, build the bridge image from
the core repo so Compose creates the expected local image name:

```powershell
docker compose build wow-llm-bridge
```

The image can build before the API key is filled in, but the running bridge
needs provider/API settings in `.\tools\WoWLlmBridge\.env` before it can answer model
requests.

## Build

Use direct `buildx` commands instead of `docker compose up --build`; it is easier to monitor and avoids building unnecessary targets.

```powershell
cd <server-root>\<core-repo>

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

docker buildx build --progress=plain --target authserver `
  -t acore/ac-wotlk-authserver:playerbots-local `
  --build-arg DOCKER_USER=acore `
  --build-arg USER_ID=1000 `
  --build-arg GROUP_ID=1000 `
  --build-arg APPS_BUILD=auth-only `
  --build-arg CTOOLS_BUILD=none `
  --build-arg BUILD_JOBS=2 `
  -f apps/docker/Dockerfile .

docker compose build wow-llm-bridge
```

`BUILD_JOBS=2` is conservative for memory-constrained hosts. `3` may be
possible; `4` can thrash on smaller machines.

The authserver build intentionally uses `CTOOLS_BUILD=none`. Building
`authserver` with `APPS_BUILD=auth-only` and `CTOOLS_BUILD=db-only` can make
the `dbimport` tool compile without the generated module list and fail with:

```text
fatal error: use of undeclared identifier 'AC_MODULES_LIST'
```

After the build, verify that Compose can find the local images:

```powershell
docker compose config --quiet
docker compose config --images
docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"
```

Expected local images:

```text
acore/ac-wotlk-worldserver:playerbots-local
acore/ac-wotlk-authserver:playerbots-local
acore/ac-wotlk-db-import:playerbots-local
wow-we-wow-llm-bridge:latest
```

`mysql:8.4` is not built locally; Docker pulls it the first time Compose
starts the database.

## Known Build Fixes

The module set in this setup may need these compatibility fixes on a fresh
checkout before the first successful build:

- If `src\server\scripts\Custom` contains only `README.md`, static script
  linking can fail with `undefined reference to AddCustomScripts()`. Add
  `src\server\scripts\Custom\custom_script_loader.cpp`:

```cpp
void AddCustomScripts()
{
}
```

Docker Desktop on Windows may print warnings like:

```text
WARNING: Error loading config file: open C:\Users\<user>\.docker\config.json: Access is denied.
```

Those warnings are harmless when the command continues. If a Docker build
stops on `CreateFile ...\.docker\buildx\instances: Access is denied`, rerun
the command from an elevated shell or a shell with access to Docker's buildx
state.

## Database Import

This setup expects a project-seeded database, not an empty stock AzerothCore
database. The seeded database must provide at least:

```text
acore_auth
acore_characters
acore_world
acore_playerbots
```

If authserver or worldserver logs show `Unknown database 'acore_auth'`, do
not run `ac-db-import` unless you intentionally want to create a fresh stock
database from the SQL files in this repo. This repository includes the current
project seed at `backups\wow-live-db.sql.gz`.

Restore the included live snapshot after `ac-database` exists:

```powershell
docker compose up -d --no-build ac-database
powershell -ExecutionPolicy Bypass -File .\scripts\restore-live-db.ps1
```

The restore script copies the gzip dump into the MySQL container and imports
`acore_auth`, `acore_characters`, `acore_world`, and `acore_playerbots`.

After restoring a shared database snapshot, check the realm address that the
authserver advertises to WoW clients:

```powershell
docker exec -e MYSQL_PWD=acore ac-database mysql -uroot -e "SELECT id, name, address, localAddress, localSubnetMask, port FROM acore_auth.realmlist;"
```

For local testing on the same machine as Docker, the realm should advertise
`127.0.0.1:8085`:

```powershell
docker exec -e MYSQL_PWD=acore ac-database mysql -uroot -e "UPDATE acore_auth.realmlist SET address='127.0.0.1', localAddress='127.0.0.1', localSubnetMask='255.255.255.0', port=8085 WHERE id=1;"
docker compose restart ac-authserver
```

For the shared server host, use the server's public/LAN address instead. The
current shared server snapshot used `38.190.118.191:8085`. A mismatched realm
address can still let users log in and see the realm or character count, but
selecting the realm will kick them back to server select because the client is
trying to connect to the wrong worldserver address.

The setup import service is only for applying repo/module SQL to the expected
database state. Run it after source/module changes that include SQL updates:

```powershell
docker compose --profile setup up -d --no-build ac-db-import
docker compose ps -a
docker compose logs --tail=200 ac-db-import
```

Wait for `ac-db-import` to exit `0`.

Repo-owned modules can include SQL under `modules\<module>\data\sql`. After
adding or changing one of these modules, rebuild `ac-worldserver` and
`ac-db-import`, rerun `scripts\apply-host-config.ps1`, then run the setup
import service so new tables or cleanup SQL are applied. For example,
`mod-hardcore` creates `acore_characters.mod_hardcore_characters` and removes
the old Challenge Shrine rows during import. `mod-small-group-tweaks` adds
player RBAC links for cross-faction friend status, who visibility, and
whispers.

To export an ad-hoc live DB backup from a host:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-live-db.ps1
```

That writes a timestamped gzip dump under `backups\`. Ad-hoc backups are ignored unless deliberately promoted to the shared snapshot.

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

## Small-Group Realm Tweaks

Use `.online` to list connected real players without the random playerbots
that appear in `/who`:

```text
.online
```

The realm is configured for cross-faction party/raid invites, guild invites,
friend adds/status, and whispers. Broad cross-faction chat is still not
enabled, so normal say/yell language behavior is left alone. One client/core
quirk to remember: AzerothCore sends party, raid, and guild chat as universal
language when cross-faction groups or guilds are enabled, so those mixed-faction
channels will be readable.

Characters can learn all 11 WotLK primary professions over time. The setup
sets `MaxPrimaryTradeSkill = 11`, and `mod-small-group-tweaks` refreshes the
remaining profession slots on login for existing characters.

## GM Utilities

Use the hardcore command to permanently opt the current character into
hardcore mode:

```text
.hardcore
.hardcore enable confirm
```

Hardcore state is stored in the characters database by `mod-hardcore`; it does
not require `EnablePlayerSettings`. Hardcore characters receive the configured
indicator aura and a configurable `<HC>` name tag in client name-query
responses, which is what unit frames, nameplates, tooltips, and player chat
names use. By default, 25% of random playerbots are also marked hardcore the
first time they are evaluated. Hardcore deaths send a global chat/server
announcement and screen notification. Dead hardcore random bots stay online
for 60 seconds, then log out and are replaced by the normal playerbot random
pool logic. GM level 1+ accounts can mark an online bot:

```text
.hardcore bot <botName> confirm
```

Use the friend boost command to catch up an online real player to the
group's current level with generated bot-style gear and supplies:

```text
.boost <playerName> <level>
```

If the target player is selected, the name can be omitted:

```text
.boost <level>
```

The command requires GM access, levels the character, learns level-appropriate
class and trainer spells, assigns talents, equips level-appropriate generated
gear, and adds bags, consumables, reagents, ammo, mounts, and pets where
applicable. It does not learn or level professions, so catch-up characters can
still choose their own crafting and gathering path. It only works while the
target player is online. Generated gear is intentionally conservative for
catch-up play: the command rolls mostly green gear with occasional blue pieces
so there is still plenty to replace through dungeon and quest rewards.

For full host notes and troubleshooting, see [SERVER_BUILD_RUNBOOK.md](SERVER_BUILD_RUNBOOK.md).
