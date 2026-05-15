# LLM NPC Execution Plan

This is the manager/agent handoff plan for getting the new LLM NPC system into
the game with the fewest possible rebuilds.

Primary objective:

```text
Human-guild bots should feel alive in guild chat, and party bots should be able
to make real bounded decisions through the MCP/tool layer.
```

Equal primary objective:

```text
The llama.cpp-backed LLM runtime must not silently bloat, hang, or stop
answering over time. It must use the available VRAM headroom intelligently,
recover when needed, and pass sustained-load smoke tests before we rely on it
for guild or party bots.
```

Secondary objective:

```text
Bring Robert's latest repo/module changes live without rebuilding anything that
does not need to be rebuilt.
```

Architecture and schema references:

- [LLM_NPC_DESIGN.md](LLM_NPC_DESIGN.md)
- [LLM_NPC_MEMORY_MCP_SCHEMA.md](LLM_NPC_MEMORY_MCP_SCHEMA.md)

## Non-Negotiable Priorities

1. Guild bots in real human guilds work first.
2. Party bots can make real decisions through the MCP/tool layer.
3. llama.cpp stability is equal priority with guild/party intelligence.
4. The bridge must detect and recover from hangs, context bloat, and stale
   queues before guild/party bots depend on it.
5. Bot-only guilds never become an LLM chatter surface.
6. Do not edit `mod-playerbots` unless every public hook/command path fails.
7. Avoid repeat worldserver rebuilds by batching all C++ work before building.
8. Bridge-only work should stay bridge-only and avoid worldserver rebuilds.
9. Every agent must preserve the live Docker database and server data.

## Rebuild Boundaries

Use this table before touching anything.

| Change type | Required rebuild? | Notes |
| --- | --- | --- |
| `wow-llm-bridge` prompt/queue/memory code | Bridge rebuild/restart only | No worldserver rebuild. |
| `..\llm-bridge\.env` provider/model settings | Bridge restart only | No image rebuild unless app requires it. |
| `env/dist/etc` config | Container recreate/restart only | No source rebuild. |
| New/changed repo-owned C++ module | `ac-worldserver` rebuild | Batch with all C++ work. |
| Module SQL under `modules/<module>/data/sql` | `ac-db-import` rebuild and setup import | Run import after worldserver/db-import build. |
| Core hook changes under `src/server` | `ac-worldserver` rebuild | Already present in Robert's latest changes. |
| Auth-only source changes | `ac-authserver` rebuild | Avoid unless proven necessary. |
| Third-party module edits | Avoid | Especially avoid `mod-playerbots`. |

## Current Ops Baseline

Last read-only inspection: 2026-05-15.

Live repo:

```text
C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
branch: Playerbot
status: ahead 1, dirty
modified: .gitignore, README.md, SETUP.md
untracked: scripts/backup-live-db.ps1
```

Publish repo:

```text
C:\Users\Buddy\Documents\wow-ai-server\WOW-WE-publish
branch: main
status: dirty with LLM planning docs
```

Robert's latest publish changes are not yet live in the running checkout.
The live repo is missing the repo-owned modules and core hook changes from the
latest publish branch:

```text
modules/mod-friend-boost
modules/mod-hardcore
modules/mod-small-group-tweaks
src/server/game/Handlers/QueryHandler.cpp
src/server/game/Scripting/ScriptDefines/PlayerScript.cpp
src/server/game/Scripting/ScriptDefines/PlayerScript.h
src/server/game/Scripting/ScriptMgr.h
```

Docker was healthy at inspection time:

```text
ac-database      Up, healthy, 3307->3306
ac-authserver    Up, 3724
ac-worldserver   Up, 8085/7878
wow-llm-bridge   Up, 11435->11434
```

Port checks passed for `3724`, `8085`, and `11435`.

Protected volumes present:

```text
azerothcore-wotlk_ac-client-data
azerothcore-wotlk_ac-database
```

Ops implications:

- Preserve/review live dirty files before syncing.
- Do not blindly reset or overwrite the live `Playerbot` branch.
- Robert's changes require one batched `worldserver` rebuild.
- Robert's module SQL requires one `db-import` build and setup import.
- No evidence currently requires an `authserver` rebuild.
- Finish `mod-llm-npc-director` before starting the worldserver build so it can
  ride the same rebuild.

## Current Implementation Status

Last manager update: 2026-05-15 overnight pass.

Completed first-wave work:

- Bridge stability patch exists in the sibling `llm-bridge` project.
- Bridge tests pass with `node --test`.
- Bridge smoke test passes with bounded queue behavior and max active request
  count `1`.
- Memory/MCP schema spec exists in
  [LLM_NPC_MEMORY_MCP_SCHEMA.md](LLM_NPC_MEMORY_MCP_SCHEMA.md).
- A minimal repo-owned `modules/mod-llm-npc-director` skeleton exists.
- `mod-llm-npc-director` observes player guild and group chat and forwards
  compact events to `wow-llm-bridge`.
- `mod-llm-npc-director` has no SQL and does not edit `mod-playerbots`.
- `.gitignore`, `MODULES.md`, and `scripts/apply-host-config.ps1` know about
  `mod-llm-npc-director`.
- `OllamaChat.MaxConcurrentQueries` is set to `1` in host config generation to
  align with bridge queueing.
- Bridge-owned SQLite memory/profile/event APIs are implemented in the sibling
  `llm-bridge` project.
- The live `wow-llm-bridge` image was rebuilt with `sqlite` and migrations
  included.
- The live `wow-llm-bridge` container was recreated without restarting the
  worldserver.
- Live bridge `/health` and `/health?probe=1` pass.
- Live bridge `/api/generate` reaches the local llama.cpp backend and returned
  `llama-ok`.
- Live bridge `/api/director/event` returned a validated `say_only` action with
  memory/debug metadata.
- Local llama.cpp server is running on `0.0.0.0:8088` using
  `gemma-3n-E2B-it-Q4_K_M`.
- Docker can reach llama.cpp at `host.docker.internal:8088`.
- RTX 3060 Ti VRAM rose to about `2430 MiB` used after model load, confirming
  the local backend is using the GPU.
- Bridge legacy-director memory now includes a rolling short-term chat window
  and relationship/world-event memory extraction.
- Bridge legacy-director tests pass with sqlite installed in the test
  container.
- `mod-llm-npc-director` now observes player guild, group, and custom/world
  channel chat.
- `mod-llm-npc-director` now forwards hardcore death events as `world`
  `hardcore_death` events when a hardcore player dies.
- `mod-llm-npc-director` can route validated `say_only` responses back through
  eligible guild, group, and channel bots.
- `mod-llm-npc-director` translates prefixed party commands such as `bots
  skull`, `bots cc moon`, `bots aoe`, `bots run`, `ai follow`, and `ai stay`
  into existing public `mod-playerbots` chat commands without editing
  `mod-playerbots`.
- `scripts/apply-host-config.ps1` applies the new director config and disables
  older `mod-ollama-chat` player-channel replies so the director owns world
  chat responses.
- Playerbot loot need rolling is held at `AiPlayerbot.LootNeedRollLevel = 1`
  through host config, preventing bots from Need-rolling over players.

Current critical gaps:

- The overnight director changes are building now and need in-game verification
  after the worldserver image is recreated.
- Party controls are currently a safe command-translation layer, not a deep
  custom target-selection AI.
- Bridge-owned memory/MCP is implemented, but it still needs real in-game event
  soak testing.
- Runtime llama.cpp still needs a longer real-backend soak test after in-game
  wiring is live.
- Exact class-specific simultaneous CC priorities, target
  highest/lowest-health mob logic, runner detection, and cooldown/CC callouts
  may need a second repo-owned module pass or deeper public playerbot action
  integration if existing commands are not enough.

Next wave priorities:

1. Finish the detached `ac-worldserver` build and recreate the worldserver
   without rebuilding extra services.
2. Verify ports and bridge health after restart.
3. In-game test world chat awareness, hardcore-death reactions, guild context,
   and party macro controls.
4. Run a longer real-backend soak test with bridge, llama.cpp, and in-game
   events active.

## Overnight Gameplay Control Scope

Implemented without editing `mod-playerbots`:

- World/custom channel chat is now an LLM director surface when at least one
  human and one eligible bot are in the channel.
- Hardcore deaths are forwarded to the bridge as world events so bots can
  remember and comment on them later.
- Recent chat context is included in bridge prompts so bots can follow a short
  argument or refer back to messages a few lines earlier.
- Prefixed party control commands are translated into existing playerbot
  commands:
  - `bots skull`, `bots x`, `bots cross`
  - `bots moon`, `bots sheep`, `bots star`, `bots sap`, `bots purple`,
    `bots diamond`, `bots fear`
  - `bots single target`, `bots focus`, `bots keep target`
  - `bots aoe`, `bots cleave`, `bots max dps`
  - `bots run`, `bots escape`, `bots get out`
  - `bots follow`, `bots stack`, `bots stay`, `bots hold`

Still requiring validation or a future deeper pass:

- `mod-playerbots` has one public `rti cc` target at a time, so moon/sheep,
  star/sap, and diamond/fear may not all behave simultaneously without deeper
  action integration.
- Highest/lowest-health target choice and runner focus were not found as simple
  safe public commands in the first pass.
- Important cooldown/CC announcements may already happen through playerbot
  text, but reliable party callouts likely need an additional observer/action
  pass.
- The conservative loot setting prevents bot Need-roll stealing; a true “bots
  Need only if no player needs” policy would require deeper loot-roll code.

Current llama.cpp/backend target:

```text
ac-worldserver
-> wow-llm-bridge:11434/api/generate
-> host.docker.internal:8088/v1/chat/completions
```

Recommended llama.cpp starting settings for the 8 GB RTX 3060 Ti:

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

Use VRAM for model offload and stable batching first. Do not increase context
above `4096` until real-backend smoke tests prove latency and VRAM stability.

## Desired Final Shape

```text
Player guild/party chat
  -> repo-owned mod-llm-npc-director
  -> wow-llm-bridge
  -> MCP/tool layer
  -> SQL memory + game state
  -> llama.cpp
  -> validated chat/intent
  -> guild response or safe playerbot command
```

`mod-llm-npc-director` should stay thin:

- observe guild and party chat through existing `PlayerScript` hooks
- detect real players vs playerbots
- ignore bot-only guilds
- forward eligible events to the bridge
- receive validated response/intent
- send chat or route safe commands

`wow-llm-bridge` should own:

- request queue
- llama.cpp timeout/retry
- llama.cpp process/backend health checks
- context and prompt budget enforcement
- VRAM/runtime tuning configuration
- memory retrieval
- MCP/tool calls
- prompt assembly
- output validation
- structured logs
- health endpoint

## Agent Assignments

## Manager Agent Operating Rules

The manager agent is responsible for keeping the whole effort moving until the
first milestone is genuinely complete.

Manager responsibilities:

- Spawn agents for bounded, documented work packages.
- Give each agent clear ownership of files, modules, or responsibilities.
- Tell coding agents they are not alone in the codebase and must not revert
  work by other agents.
- Keep one rebuild budget in mind at all times.
- Prefer bridge-only work before worldserver rebuild work.
- Merge completed agent work into the active plan.
- Release/close agents after their assigned task is complete.
- Spawn the next needed agent when a previous agent finishes and a new bounded
  task becomes clear.
- Keep verification independent from implementation when possible.
- Stop and reassess if an agent discovers that `mod-playerbots` must be edited.

Agent lifecycle:

```text
spawn agent with clear task and ownership
-> agent inspects/implements within that scope
-> manager continues non-overlapping work
-> manager reviews result
-> manager closes released agent
-> manager assigns next bounded task if needed
```

Parallelism rules:

- Bridge/MCP work and C++ director-module work can run in parallel.
- Database/memory schema planning can run in parallel if it does not modify the
  same files as bridge or director work.
- Verification agents should run after implementation artifacts exist, or in
  parallel only for read-only environment checks.
- Do not assign two agents to edit the same file set.
- Do not start a rebuild until all planned C++ work for the milestone is done.

Release criteria for agents:

- The agent reports changed files or confirms read-only findings.
- The agent documents any commands/tests it ran.
- The agent identifies remaining risks or follow-up tasks.
- The manager has enough information to integrate or delegate the next step.

### Agent 1: Manager/Ops Agent

Owns sequencing and rebuild discipline.

Tasks:

- Confirm the live repo path:
  `C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk`.
- Confirm the publish repo path:
  `C:\Users\Buddy\Documents\wow-ai-server\WOW-WE-publish`.
- Pull/sync Robert's latest changes into the live repo.
- Check `git status` before and after every major step.
- Decide the minimum Docker build targets.
- Ensure C++ work is complete before the single worldserver rebuild.
- Run only the required builds.
- Run setup import only when module SQL changed.
- Bring services up and verify ports.
- Coordinate verification before declaring done.

Do not:

- run broad Docker prune commands
- delete Docker volumes
- rebuild authserver unless a source/config reason is proven
- restart working services before the build plan is ready

### Agent 2: LLM Bridge/MCP Agent

Owns the fast-iteration runtime and llama.cpp stability.

Tasks:

- Inspect `..\llm-bridge`.
- Add or verify a request queue with max concurrency `1`.
- Add llama.cpp request timeout and reconnect/retry behavior.
- Add stale-request cancellation and queue draining.
- Add a circuit breaker when llama.cpp repeatedly times out or returns invalid
  output.
- Add automatic backend refresh/restart instructions or code path if the local
  llama.cpp server becomes unhealthy.
- Add prompt size and max token caps.
- Add context budgeting so retrieved memories replace old raw chat instead of
  endlessly growing prompts.
- Add memory summarization or compaction for long-running relationships.
- Add structured logs with event id, bot, player, channel, prompt size,
  latency, memory count, output size, parse status, and intent.
- Add a health endpoint.
- Add response cleanup that strips model reasoning/tool chatter.
- Add memory/profile APIs.
- Add MCP/tool-call loop with strict limits.
- Add read-only SQL escape hatch for dev/debug.
- Keep writes behind typed APIs such as `write_memory`.
- Measure current llama.cpp VRAM/RAM usage during idle and load.
- Tune llama.cpp settings to use available VRAM headroom safely without relying
  on giant prompts. Candidate settings include GPU layer count, context size,
  KV cache placement/type, batch/ubatch size, and max generated tokens.
- Document the chosen runtime settings and why they are safe for this host.
- Build a smoke/stability test that exercises the bridge for a sustained period
  and proves it does not hang, leak, or build an unbounded queue.

MCP/tool loop rules:

- hard max tool calls per event
- hard timeout per event
- no recursive autonomous loops
- bridge controls tool selection
- model returns chat text or validated JSON intent

Bridge work should not require a worldserver rebuild.

Stability smoke test requirements:

- simulate guild chat events from multiple players
- simulate party chat decision events
- include memory retrieval and memory writes
- include malformed model-output cases if possible
- run long enough to catch queue buildup and context bloat
- record request count, success count, timeout count, p50/p95 latency, max queue
  depth, prompt size range, output size range, llama.cpp health, and RAM/VRAM
  observations
- prove that stale events are dropped, summarized, or safely failed instead of
  blocking all future responses
- prove the bridge recovers after llama.cpp is restarted or temporarily
  unavailable

### Agent 3: LLM Director Module Agent

Owns the in-game hook module.

Target module:

```text
modules/mod-llm-npc-director
```

Tasks:

- Create a repo-owned companion module.
- Use `PlayerScript::OnPlayerCanUseChat(..., Guild*)` for guild chat.
- Use `PlayerScript::OnPlayerCanUseChat(..., Group*)` for party/raid chat.
- Use `CommandScript` only for admin/debug commands if useful.
- Copy the real-player/bot detection pattern from `mod-small-group-tweaks`.
- Include `Playerbots.h` only behind `#ifdef MOD_PLAYERBOTS`.
- Ignore bot-only guilds.
- Only process guilds with at least one real human player.
- Throttle responses so one message does not cause a swarm.
- Forward compact event payloads to `wow-llm-bridge`.
- Route validated `say` responses back to guild/party chat.
- Route validated first-pass intents to existing public bot command surfaces.

Allowed first-pass party intents:

- `say_only`
- `follow_leader`
- `assist_target`
- `hold_position`
- `move_closer`
- `heal_priority`
- `avoid_combat`
- `need_help`

Do not:

- edit `mod-playerbots`
- directly expose arbitrary GM commands to the model
- let bot-only guilds trigger LLM calls
- add broad SQL if bridge-owned storage is enough

### Agent 4: Database/Memory Agent

Owns persistence and queries.

Tasks:

- Decide whether memory tables live in `acore_characters`, a new schema, or
  bridge-local storage.
- Prefer bridge-owned migrations if they avoid worldserver/db-import rebuilds.
- If module SQL is required, place it under
  `modules/mod-llm-npc-director/data/sql`.
- Define tables or storage for:
  - bot profiles
  - player profiles
  - bot/player memories
  - recent event log
  - conversation summaries
- Add indexes for bot id, player id, guild id, party id, weight, and last seen.
- Provide typed access APIs:
  - `get_bot_profile`
  - `get_player_profile`
  - `get_relationship`
  - `search_memories`
  - `write_memory`
  - `record_event`
- Provide read-only SQL escape hatch with:
  - `SELECT` only
  - approved tables/views only
  - row limit
  - timeout
  - logging

### Agent 5: Verification Agent

Owns proof that this works in game.

Tasks:

- Verify containers:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

- Verify ports:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 3724
Test-NetConnection -ComputerName 127.0.0.1 -Port 8085
Test-NetConnection -ComputerName 127.0.0.1 -Port 11435
```

- Verify Robert's changes:
  - `.online` lists real players only
  - hardcore command exists
  - friend boost command exists
  - cross-faction guild/party QoL still works
- Verify LLM bridge health endpoint.
- Run the LLM bridge/llama.cpp sustained smoke test.
- Verify smoke-test metrics show no unbounded prompt, queue, RAM, or VRAM
  growth.
- Verify llama.cpp recovery behavior by restarting or interrupting the backend
  during a controlled test.
- Verify guild chat:
  - human guild message can trigger one eligible bot response
  - bot-only guild does not trigger LLM
  - response is short and in character
  - memory retrieval appears in logs
- Verify party chat:
  - party command triggers a structured intent
  - invalid intent is rejected
  - allowed intent routes to a safe bot behavior or safe no-op
- Verify logs:
  - no repeated format errors
  - no runaway queues
  - no llama.cpp hangs
  - no worldserver crash

## Execution Sequence

### Step 0: Freeze Scope

Before building, decide whether the first implementation includes
`mod-llm-npc-director`.

Recommendation:

```text
Yes. Include a minimal director module in the same rebuild needed for Robert's
C++ changes, because guild/party hooks are the priority and rebuilds are
expensive.
```

### Step 1: Sync Live Repo

Manager/Ops Agent:

```powershell
cd C:\Users\Buddy\Documents\wow-ai-server\azerothcore-wotlk
git status --short
git pull --rebase --autostash origin main
git status --short
```

If local live changes exist, preserve them. Do not reset or discard user work.

### Step 2: Implement Bridge Runtime First

Bridge/MCP Agent:

- Implement queue, timeout, caps, health, logging, validation, and MCP/memory
  APIs in `..\llm-bridge`.
- Implement llama.cpp hang recovery and context-bloat protection.
- Tune llama.cpp/runtime settings to use safe VRAM headroom.
- Implement the sustained smoke test before in-game dependence.
- Rebuild/restart only `wow-llm-bridge` when ready.
- Keep bridge tests independent from worldserver.

Reason:

```text
Bridge work is fast, does not spend the painful worldserver rebuild, and must
be stable before guild/party bots depend on it.
```

### Step 3: Implement Thin Director Module

Director Module Agent:

- Add `modules/mod-llm-npc-director`.
- Keep it thin.
- Do not edit `mod-playerbots`.
- Add SQL only if the bridge cannot own the required memory storage.

When complete, stop and hand off to Manager/Ops Agent before building.

### Step 4: Apply Host Config

Manager/Ops Agent:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\apply-host-config.ps1
```

Review generated config paths before restart when practical.

### Step 5: Build Only Needed Targets

If C++ module/core changed:

```powershell
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

If module SQL changed:

```powershell
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

Only build authserver if authserver source or build inputs changed:

```powershell
docker buildx build --progress=plain --target authserver `
  -t acore/ac-wotlk-authserver:playerbots-local `
  --build-arg DOCKER_USER=acore `
  --build-arg USER_ID=1000 `
  --build-arg GROUP_ID=1000 `
  --build-arg APPS_BUILD=auth-only `
  --build-arg CTOOLS_BUILD=none `
  --build-arg BUILD_JOBS=2 `
  -f apps/docker/Dockerfile .
```

Expected for this plan:

```text
Build worldserver: yes
Build db-import: yes if director/module SQL exists or Robert SQL not imported
Build authserver: probably no
Build wow-llm-bridge: yes only if bridge code changed
```

### Step 6: Run Setup Import If Needed

Only if SQL changed or Robert's module SQL has not been imported:

```powershell
docker compose --profile setup up -d --no-build ac-db-import
docker compose ps -a
docker compose logs --tail=200 ac-db-import
```

Wait for `ac-db-import` to exit `0`.

### Step 7: Start Services

```powershell
docker compose up -d --no-build ac-database wow-llm-bridge ac-authserver ac-worldserver
```

If only config changed:

```powershell
docker compose up -d --no-build --force-recreate ac-authserver ac-worldserver
```

### Step 8: Verification

Verification Agent runs the checks from its assignment section.

Do not declare done until:

- Robert's changes are visible in game.
- llama.cpp survives the sustained smoke test without silently hanging.
- bridge queue depth remains bounded under reasonable load.
- prompt/context size remains bounded through memory retrieval and summaries.
- llama.cpp recovery works after backend restart or temporary failure.
- Human-guild bot chat works.
- Bot-only guilds are ignored.
- Party chat can produce and validate a real structured decision.
- MCP/tool logs show bounded calls.
- No repeated llama.cpp hangs or format errors appear.

## First Milestone Definition Of Done

The first milestone is done when:

- Server starts from the new images.
- `.online` works.
- Existing LLM whispers still work or fail gracefully.
- llama.cpp runtime settings are documented.
- The LLM bridge passes the sustained smoke test.
- The bridge can recover from llama.cpp timeout/restart.
- A real human guild message can cause exactly one eligible bot to respond.
- The response uses a stable bot profile/personality.
- Memory lookup happens before the model call.
- A party message can produce a validated structured intent.
- Unsafe/unknown intents are rejected.
- The bridge queue does not exceed configured concurrency.
- The worldserver does not need another rebuild for the same milestone.

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Worldserver rebuild takes hours | Batch all C++ changes before building. |
| llama.cpp hangs | Queue, timeout, health check, reconnect. |
| Prompt/context bloat | SQL memories and prompt caps. |
| llama.cpp stops after running for a while | Sustained smoke test, circuit breaker, backend refresh/restart path. |
| VRAM headroom is wasted | Tune runtime settings after measuring idle/load VRAM and RAM. |
| Bot-only guilds spam model calls | Guild eligibility check requires real players. |
| Model outputs invalid action | Validate JSON and allowlist intents. |
| MCP loop runs wild | Hard tool-call and timeout limits. |
| `mod-playerbots` rebuild/edit pain | Use companion module and public hooks. |
| SQL migration requires extra build | Prefer bridge-owned storage unless module SQL is necessary. |

## Manager Reminder

When in doubt, preserve rebuild budget:

```text
Bridge changes first.
Director C++ changes batched once.
Playerbots untouched.
SQL import only when required.
Verification before celebration.
```
