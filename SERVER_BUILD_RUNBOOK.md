# WoW Server Build Runbook

This documents the build path that worked on this Ryzen box, with the goal of avoiding accidental full rebuilds, lost progress from closed shells, and Docker Compose trying to build every helper image.

## Current Runtime Shape

The server runs from:

```powershell
C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
```

Runtime containers that should exist:

```text
ac-database
ac-authserver
ac-worldserver
wow-llm-bridge
```

Runtime volumes that should be kept:

```text
azerothcore-wotlk_ac-database
azerothcore-wotlk_ac-client-data
```

The setup-only services are intentionally behind the `setup` Compose profile:

```text
ac-db-import
ac-client-data-init
```

This keeps normal `docker compose up -d --no-build` from trying to pull/recreate helper images we do not need every boot.

## Important Settings

The local image tag is:

```text
DOCKER_IMAGE_TAG=playerbots-local
```

Gameplay tuning is in `.env`:

```text
WOW_XP_RATE=1.2
WOW_INDIVIDUAL_PROGRESSION_LIMIT=1
WOW_INDIVIDUAL_PROGRESSION_DISABLE_DEFAULT=1
```

Bot count is in `docker-compose.override.yml`:

```yaml
AC_AI_PLAYERBOT_MIN_RANDOM_BOTS: "250"
AC_AI_PLAYERBOT_MAX_RANDOM_BOTS: "250"
AC_AI_PLAYERBOT_RANDOM_BOTS_PER_INTERVAL: "20"
```

Module settings in `docker-compose.override.yml`:

```yaml
AC_CHALLENGE_MODES_ENABLE: "1"
AC_HARDCORE_ENABLE: "1"
AC_INDIVIDUAL_PROGRESSION_ENABLE: "1"
AC_INDIVIDUAL_PROGRESSION_PROGRESSION_LIMIT: "${WOW_INDIVIDUAL_PROGRESSION_LIMIT:-1}"
AC_INDIVIDUAL_PROGRESSION_DISABLE_DEFAULT_PROGRESSION: "${WOW_INDIVIDUAL_PROGRESSION_DISABLE_DEFAULT:-1}"
```

The config files also exist on the host:

```text
env\dist\etc\modules\challenge_modes.conf
env\dist\etc\modules\individualProgression.conf
env\dist\etc\modules\mod_ahbot.conf
env\dist\etc\modules\mod_aoe_loot.conf
env\dist\etc\modules\mod_ollama_chat.conf
```

Auction House bot currently uses:

```text
account: ahbot
character: Marketbot
guid: 1010
```

`mod_ahbot.conf` must stay based on the full `mod_ahbot.conf.dist`. A tiny override-only file caused repeated `No valid list proportion for new listing could be found` errors.

Key module settings:

```text
AuctionHouseBot.EnableSeller = true
AuctionHouseBot.GUIDs = 1010
AuctionHouseBot.ItemsPerCycle = 500
AuctionHouseBot.Neutral.MinItems = 30000
AuctionHouseBot.Neutral.MaxItems = 30000
AuctionHouseBot.Buyer.Enabled = true
AOELoot.Enable = 1
AOELoot.Range = 70.0
OllamaChat.Enable = 1
OllamaChat.Url = http://wow-llm-bridge:11434/api/generate
OllamaChat.EnableWhisperReplies = 1
```

## What Was Installed

Modules cloned under `modules`:

```text
modules\mod-individual-progression
modules\mod-challenge-modes
modules\mod-ah-bot-plus
modules\mod-aoe-loot
modules\mod-ollama-chat
modules\mod-playerbots
```

`mod-challenge-modes` is being used for Hardcore because it includes the Hardcore mode.

Compatibility patch applied in:

```text
modules\mod-challenge-modes\src\ChallengeModes.cpp
```

The `OnPlayerResurrect` hook needed `bool&` on this AzerothCore branch:

```cpp
void OnPlayerResurrect(Player* player, float /*restore_percent*/, bool& /*applySickness*/) override
```

## Dockerfile Changes That Matter

`apps\docker\Dockerfile` was changed so we can avoid building every app/tool:

```dockerfile
ARG APPS_BUILD="all"
ARG BUILD_JOBS=2
```

The CMake configure uses:

```dockerfile
-DAPPS_BUILD="$APPS_BUILD"
-DWITHOUT_GIT=1
```

The build uses:

```dockerfile
cmake --build . --config "$CTYPE" -j "$BUILD_JOBS"
```

BuildKit cache mounts were added:

```dockerfile
--mount=type=cache,target=/ccache,sharing=locked
--mount=type=cache,target=/azerothcore/build,sharing=locked
```

These helped preserve compile artifacts across attempts, but Docker build cache may be pruned if we need disk space. If pruned, future source rebuilds will be slow again.

The biggest speed fix was trimming Docker context in `.dockerignore`:

```text
.git
modules/**/.git
modules/**/.github
*.log
*.err.log
data/sql/base
data/sql/old
data/sql/archive
```

Before that fix, Docker Desktop could sit silently before the first BuildKit line. After it, the worldserver context was about 354 KB and the db-import context was about 22 MB.

Because `data/sql/base`, `old`, and `archive` are ignored, this setup assumes the MySQL volume is already seeded. If rebuilding a totally fresh database volume, temporarily remove those three ignore lines before building/running `ac-db-import`.

## Normal Start

Use this for normal server startup:

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
docker compose up -d --no-build
```

Check status:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Test-NetConnection -ComputerName 127.0.0.1 -Port 3724
Test-NetConnection -ComputerName 127.0.0.1 -Port 8085
```

Good runtime state:

```text
ac-database healthy
ac-authserver up on 3724
ac-worldserver up on 8085
wow-llm-bridge up on 11435
```

## Fast Path For Config-Only Changes

If only `.env`, `docker-compose.override.yml`, or config files under `env\dist\etc` changed, do not rebuild.

Run:

```powershell
docker compose up -d --no-build --force-recreate ac-authserver ac-worldserver
```

Then verify:

```powershell
docker compose logs --tail=120 ac-authserver ac-worldserver
Test-NetConnection -ComputerName 127.0.0.1 -Port 3724
Test-NetConnection -ComputerName 127.0.0.1 -Port 8085
```

## When Source/Module Code Changes

Avoid `docker compose up -d --build` for source changes. It can queue extra targets and is harder to monitor.

Build the worldserver target directly:

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
$env:DOCKER_BUILDKIT="1"
docker buildx build --progress=plain --target worldserver `
  -t acore/ac-wotlk-worldserver:playerbots-local `
  --build-arg DOCKER_USER=acore `
  --build-arg USER_ID=1000 `
  --build-arg GROUP_ID=1000 `
  --build-arg APPS_BUILD=world-only `
  --build-arg CTOOLS_BUILD=db-only `
  --build-arg BUILD_JOBS=2 `
  -f apps/docker/Dockerfile .
```

`BUILD_JOBS=2` was chosen because Docker Desktop has about 7.6 GB available and this old PC can get memory-tight. The CPU has 4 cores / 8 threads, so `BUILD_JOBS=3` may be worth trying later if memory is stable. `BUILD_JOBS=4` may be faster or may thrash.

After that, build the db-import image from cache:

```powershell
$env:DOCKER_BUILDKIT="1"
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

Then run the setup profile once:

```powershell
docker compose --profile setup up -d --no-build ac-db-import
```

Wait until `ac-db-import` exits `0`:

```powershell
docker compose ps -a
docker compose logs --tail=160 ac-db-import
```

Then restart runtime:

```powershell
docker compose up -d --no-build --force-recreate ac-authserver ac-worldserver
```

## Safer Long Build: Background Job With Logs

Use this when the shell may close or when we want progress visible in files.

For the current overnight module rebuild, use:

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
$p = Start-Process powershell `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\overnight-mod-build.ps1" `
  -WorkingDirectory (Get-Location) `
  -PassThru `
  -WindowStyle Hidden
$p.Id
```

Watch it:

```powershell
Get-Content overnight-mod-build.status.log -Tail 40
Get-Content overnight-worldserver-build.err.log -Tail 120
Get-Content overnight-setup-restart.log -Tail 120
```

Worldserver:

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
$env:DOCKER_BUILDKIT="1"
$cmd = @'
$env:DOCKER_BUILDKIT="1"
docker buildx build --progress=plain --target worldserver -t acore/ac-wotlk-worldserver:playerbots-local --build-arg DOCKER_USER=acore --build-arg USER_ID=1000 --build-arg GROUP_ID=1000 --build-arg APPS_BUILD=world-only --build-arg CTOOLS_BUILD=db-only --build-arg BUILD_JOBS=2 -f apps/docker/Dockerfile .
'@
$p = Start-Process powershell `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cmd `
  -WorkingDirectory (Get-Location) `
  -RedirectStandardOutput build-direct-worldserver.log `
  -RedirectStandardError build-direct-worldserver.err.log `
  -PassThru `
  -WindowStyle Hidden
$p.Id
```

Watch progress:

```powershell
Get-Content build-direct-worldserver.err.log -Tail 120
Get-Process -Id <PID> -ErrorAction SilentlyContinue
docker images --format "table {{.Repository}}:{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}" | Select-String "ac-wotlk-worldserver|ac-wotlk-db-import"
```

BuildKit plain progress usually writes to stderr, so `build-direct-worldserver.err.log` is the main progress file.

Scan for real errors:

```powershell
Select-String -Path build-direct-worldserver.err.log `
  -Pattern "fatal error:|undefined reference|No such file|failed to solve|Error [0-9]|\berror:" `
  -Context 1,1 |
  Select-Object -Last 80
```

## Interpreting Slow Progress

The long pause was not data transfer. It was C++ compilation, especially `mod-playerbots`.

Examples from the successful build:

```text
[96%] mod-playerbots/src/Bot/Engine/...
[97%] mod-playerbots/src/Mgr/...
[98%] Linking CXX static library libmodules.a
[99%] Linking CXX executable dbimport
[100%] Linking CXX executable worldserver
[100%] Built target worldserver
```

Windows Task Manager may show low CPU on `docker.exe` while WSL/Docker is still compiling. Trust the build log timestamps and new lines more than the wrapper process CPU.

## Cleanup Notes

To see Docker usage:

```powershell
docker system df -v
```

Safe runtime keep-set:

```text
Containers: ac-database, ac-authserver, ac-worldserver, wow-llm-bridge
Volumes: azerothcore-wotlk_ac-database, azerothcore-wotlk_ac-client-data
Images: mysql:8.4, acore/ac-wotlk-authserver:playerbots-local, acore/ac-wotlk-worldserver:playerbots-local, azerothcore-wotlk-wow-llm-bridge:latest
```

Build cache can be removed for space, but it makes later source rebuilds slow:

```powershell
docker builder prune -a -f
```

Do not delete:

```text
azerothcore-wotlk_ac-database
azerothcore-wotlk_ac-client-data
```

## Current Caveat

After cleanup, Docker itself reported low usage, but Windows C: did not reclaim all of it because Docker Desktop stores data inside:

```text
C:\Users\Buddy\AppData\Local\Docker\wsl\disk\docker_data.vhdx
```

The safe DiskPart compact route only reclaimed a small amount. WSL offered `--set-sparse true --allow-unsafe`, but that was not used because it warned about possible data corruption. Do not force sparse mode unless the database is backed up first.
