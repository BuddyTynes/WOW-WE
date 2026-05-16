# LLM Bot Action Director Design

## Purpose

The current LLM bot system can make guild and party bots talk, remember chat context, and use recent memories. The next goal is action behind the words: bots should understand who is talking to them, what they are doing, how much they trust that person, and whether they should act on a request.

Examples this design must support:

- "come to me" should become a real movement/follow/teleport action when allowed.
- "lets trade" should become a trade intent or pending trade action when supported.
- "what do you need?" should inspect the bot's level, gear, bags, quest/activity state, and relationship with the speaker.
- "want me to powerlevel you?" should consider trust, level gap, current activity, and past outcomes.
- KOS and grudges should matter when bots decide whether to help, ignore, mock, flee, or later attack.

The system should feel like persistent guildmates with motives, memories, social opinions, and state. It should not feel like a chatbot that only replies with flavor text.

## Current State

Known working pieces:

- `mod-llm-npc-director` captures guild, group, channel/world, and death chat.
- The bridge builds social prompts from recent chat, memory, bot profiles, relationships, and spice chat lines.
- The bridge exposes memory/profile endpoints and writes durable memories after validation.
- The memory schema already has bot profiles, player profiles, relationships, trust, affinity, memories, conversation summaries, event logs, and tool audit logs.
- Playerbot command routing already works for explicit party command prefixes like `bots`, `bot`, `ai`, `.ai`, and `partybot`.
- The current C++ command surface can route commands such as `attack`, `follow`, `stay`, `flee`, `runaway`, `max dps`, `rti skull`, `rti cross`, `rti cc moon`, `rti cc star`, and `rti cc diamond`.

Known gaps:

- Parsed LLM party intents are not yet routed to playerbot actions.
- The social chat lane still carries too much responsibility.
- The bridge does not yet receive rich world snapshots: bot location, speaker level, gear, quest/activity state, nearby entities, target/mark state, combat state, or KOS status.
- There is no separate action planner endpoint.
- The current "MCP" shape is bridge-owned HTTP tools, not yet a formal model tool loop.
- There is no durable action outcome loop that says whether an action succeeded, failed, timed out, or changed trust.

## Architecture

Use three lanes instead of making one model call do everything.

```text
Raw WoW events
  -> Observer / Distiller Lane
      -> memories
      -> relationship updates
      -> trust changes
      -> KOS changes
      -> activity labels
      -> bot goals
      -> action outcomes
  -> Social Chat Lane
      -> believable guild/party/world speech
      -> no direct raw command execution
  -> Action Director Lane
      -> structured action plan
      -> validated command allowlist
      -> C++ playerbot command routing
```

### Lane 1: Observer / Distiller

The distiller watches messy game events and turns them into clean data points. It does not talk in-game and does not execute playerbot commands.

Inputs:

- Recent guild, party, whisper, world, and death chat.
- Party invites, guild joins, trades, deaths, kills, quest progress, leveling, loot events, and combat outcomes.
- Bot and player snapshots from C++.
- Action success/failure reports from the worldserver.

Outputs:

- New memories.
- Relationship summaries.
- Trust, affinity, familiarity deltas.
- KOS entries or KOS severity changes.
- Activity labels such as `leveling`, `questing`, `traveling`, `following_player`, `waiting`, `in_combat`, `farming`, `dead`, or `lost`.
- Bot goals such as "finish quest", "replace weapon", "avoid Robert", "follow Buddy for powerleveling", or "get revenge on KOS target".

This lane can be hybrid:

- Rules handle obvious events like deaths, trades, party joins, direct help, and repeated interactions.
- LLM distillation handles fuzzy interpretation like insults, betrayal, jokes, risky help, apologies, social escalation, and whether something is worth remembering.

### Lane 2: Social Chat

The social lane creates believable speech. It should read bot personality, recent chat, relationship state, trust, KOS list, current activity, and memories. It should not be responsible for deciding all gameplay actions.

Outputs:

- `say_only`
- optional short action-related narration, only if the action director also accepts the action
- silence/hold when the model output would be generic, stale, repetitive, or immersion-breaking

Rules:

- Avoid canned assistant phrases.
- Avoid fake memory acknowledgements.
- Use current activity and relationship state naturally.
- If an action is not wired, avoid lying. Say it in-character or stay silent.

### Lane 3: Action Director

The action director turns requests, tactical calls, and state changes into validated plans. This lane should be structured, lower-temperature, and prioritized above ambient chat.

Example output:

```json
{
  "event_id": "evt_123",
  "bot_guid": 11,
  "target_player_guid": 42,
  "intent": "follow_player",
  "say": "fine, invite me but im not eating another death for free",
  "commands": [
    { "type": "playerbot_command", "command": "follow", "target_guid": 42 }
  ],
  "memory_updates": [
    {
      "kind": "relationship",
      "summary": "Buddy offered to powerlevel the bot again after a risky prior death.",
      "trust_delta": 1,
      "affinity_delta": 1,
      "weight": 6
    }
  ],
  "ttl_ms": 4000,
  "confidence": 0.86
}
```

The worldserver must validate the plan before executing it. The model should never be allowed to send arbitrary playerbot commands directly.

## MCP / Tool Model

The first implementation should use bridge-owned tools/endpoints rather than exposing raw SQL or raw server commands to the model.

Read tools:

- `get_recent_chat`
- `search_memories`
- `get_bot_profile`
- `get_player_profile`
- `get_relationship`
- `get_party_state`
- `get_bot_state`
- `get_player_snapshot`
- `get_nearby_entities`
- `get_current_activity`
- `get_kos_status`
- `get_action_history`

Write tools:

- `write_memory`
- `update_relationship`
- `record_event`
- `record_action_plan`
- `record_action_result`
- `set_current_activity`
- `set_bot_goal`
- `upsert_kos_entry`
- `queue_validated_action`

SQL escape hatch:

- Do not give the model arbitrary write SQL.
- If a SQL-like tool is added, it should be read-only and restricted to approved views such as `v_llm_bot_profiles`, `v_llm_player_profiles`, `v_llm_relationships`, `v_llm_memories`, `v_llm_recent_events`, and future state views.
- Prefer query templates or a small query builder over raw SQL.

## Data Model Additions

The existing schema already supports profiles, relationships, memories, events, and tool audit logs. Add focused tables for action/state.

### Bot State

Stores the latest known live state for each bot.

```sql
CREATE TABLE bot_runtime_state (
  bot_guid INTEGER PRIMARY KEY,
  map_id INTEGER,
  zone_id INTEGER,
  area_id INTEGER,
  position_x REAL,
  position_y REAL,
  position_z REAL,
  level INTEGER,
  class TEXT,
  race TEXT,
  guild_id INTEGER,
  party_id TEXT,
  current_activity TEXT,
  current_goal TEXT,
  combat_state TEXT,
  target_guid INTEGER,
  leader_guid INTEGER,
  last_snapshot_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

### Player Snapshot

Stores the latest visible facts about players who interact with bots.

```sql
CREATE TABLE player_runtime_snapshots (
  player_guid INTEGER PRIMARY KEY,
  account_id INTEGER,
  name TEXT NOT NULL,
  level INTEGER,
  class TEXT,
  race TEXT,
  guild_id INTEGER,
  guild_rank TEXT,
  map_id INTEGER,
  zone_id INTEGER,
  area_id INTEGER,
  gear_score INTEGER,
  equipped_summary_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

### KOS / Social Flags

Stores bot-specific grudges, enemies, protected players, and temporary social states.

```sql
CREATE TABLE bot_social_flags (
  flag_id TEXT PRIMARY KEY,
  bot_guid INTEGER NOT NULL,
  target_player_guid INTEGER,
  target_bot_guid INTEGER,
  guild_id INTEGER,
  flag_type TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 5 CHECK (severity BETWEEN 1 AND 10),
  reason TEXT NOT NULL,
  evidence_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

Suggested `flag_type` values:

- `kos`
- `disliked`
- `trusted`
- `protected`
- `rival`
- `owes_favor`
- `owes_revenge`
- `avoid`

### Action Plans

Records model-proposed actions before execution.

```sql
CREATE TABLE bot_action_plans (
  action_plan_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  bot_guid INTEGER NOT NULL,
  speaker_player_guid INTEGER,
  channel_type TEXT,
  intent TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  rejection_reason TEXT,
  confidence REAL NOT NULL DEFAULT 0.0,
  ttl_ms INTEGER NOT NULL DEFAULT 4000,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### Action Results

Records execution outcome after C++ attempts the action.

```sql
CREATE TABLE bot_action_results (
  action_result_id TEXT PRIMARY KEY,
  action_plan_id TEXT NOT NULL,
  bot_guid INTEGER NOT NULL,
  command TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  result_code TEXT,
  result_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

## World Snapshot Contract

C++ should send richer context to the bridge for action and distillation events.

Minimum v1 event body:

```json
{
  "event_kind": "party_chat",
  "channel_type": "party",
  "scope_type": "party",
  "scope_id": "party_123",
  "text": "come to me and help me kill this idiot",
  "speaker": {
    "guid": 42,
    "account_id": 3,
    "name": "Buddy",
    "level": 60,
    "class": "Warrior",
    "guild_id": 99,
    "guild_rank": "Guild Master",
    "map_id": 0,
    "zone_id": 12,
    "gear_summary": {}
  },
  "bot": {
    "guid": 11,
    "name": "Cumm",
    "level": 18,
    "class": "Warrior",
    "guild_id": 99,
    "party_id": "party_123",
    "current_activity": "questing",
    "current_goal": "finish Westfall quests",
    "combat_state": "out_of_combat",
    "map_id": 0,
    "zone_id": 40
  },
  "party": {
    "leader_guid": 42,
    "members": []
  },
  "marks": {
    "skull": null,
    "cross": null,
    "moon": null,
    "star": null,
    "diamond": null
  },
  "nearby": {
    "players": [],
    "creatures": []
  }
}
```

## Action Command Allowlist

Start with the commands that are already routed by the C++ module.

```text
attack
follow
stay
flee
runaway
max dps
rti skull
rti cross
rti cc moon
rti cc star
rti cc diamond
```

Add new commands only after manual testing confirms the playerbot module supports them.

Future candidates:

- accept party invite
- leave party
- move to player
- open trade
- accept trade
- equip item
- set loot preference
- sell junk
- repair
- hearth
- mount
- assist named player
- avoid player
- target KOS player

## Decision Policy

The action director should decide from state, not only from the latest chat line.

Inputs that matter:

- Speaker trust, affinity, familiarity, and guild status.
- Whether the speaker is in the bot's guild or party.
- Whether the speaker is on KOS, disliked, trusted, protected, or owed a favor.
- Speaker level, class, gear, location, and current target.
- Bot level, class, health/death state, current activity, and current goal.
- Whether the request risks death, lost time, or social embarrassment.
- Recent bot/player history.

Example policies:

- High trust guildmate asks "come to me": follow/move if not busy or in danger.
- Low trust stranger asks "come here": ask why, refuse, or ignore.
- KOS target asks for help: refuse, mock, warn guild, or later target them when systems support it.
- Trusted player offers powerleveling: accept if useful and not repeatedly fatal.
- Player recently got bot killed: reduce trust and require clearer plan before accepting help again.
- Bot is in combat or fleeing: action director can prioritize survival over chat.

## Queueing And Concurrency

llama.cpp should remain low-concurrency. Multiple lanes do not mean multiple simultaneous model calls by default.

Priority order:

1. Action Director events in active party/combat.
2. Distiller events for major outcomes: death, trade, party join/leave, KOS-worthy event.
3. Direct whispers from trusted players.
4. Guild chat responses.
5. World/death chatter.
6. Ambient spice chatter, preferably no-model.

Rules:

- Action events should be short and expire quickly.
- Stale action events should be dropped rather than executed late.
- Social chat can be dropped if stale.
- Distiller can batch and summarize.
- Ambient spice should never block action or direct social responses.
- Use a single backend request queue at first, with per-lane priority.
- Add a lane field to event logs: `social`, `action`, `distiller`, `ambient`.

## Endpoints

### Action Event

```text
POST /api/action/event
```

Returns a validated action plan.

### Distill Event

```text
POST /api/distill/event
```

Returns memory/relationship/state changes only.

### Action Result

```text
POST /api/action/result
```

Called by C++ after command execution.

### State Snapshot

```text
POST /api/state/snapshot
```

Called by C++ to update bot/player/party/runtime state without necessarily invoking the model.

## C++ Integration Plan

1. Add config toggles:

```text
LLMNpcDirector.ActionDirectorEnable = 0
LLMNpcDirector.ActionDirectorUrl = http://wow-llm-bridge:11434/api/action/event
LLMNpcDirector.ActionDirectorTimeoutMs = 2500
LLMNpcDirector.RouteActionPlans = 0
LLMNpcDirector.StateSnapshotsEnable = 1
LLMNpcDirector.DistillerEnable = 0
```

2. Extend `DirectorAction` or add `BotCommandAction`:

```cpp
struct BotCommandAction
{
    ObjectGuid botGuid;
    ObjectGuid speakerGuid;
    std::string intent;
    std::vector<std::string> commands;
    std::string say;
    uint32 ttlMs = 4000;
    float confidence = 0.0f;
};
```

3. Validate commands in C++:

- Reject commands not in the allowlist.
- Reject expired plans.
- Reject low-confidence actions unless config allows them.
- Reject commands for bots not in the correct party/guild context.

4. Execute commands through existing playerbot `HandleCommand`.

5. Report action results back to bridge.

## Bridge Implementation Plan

1. Add action schemas and validators.
2. Add memory store methods for bot runtime state, player snapshots, social flags, action plans, and action results.
3. Add `/api/state/snapshot`.
4. Add `/api/action/event`.
5. Add `/api/action/result`.
6. Add `/api/distill/event`.
7. Build prompts from:

- current event
- bot profile
- player profile
- relationship
- KOS/social flags
- recent chat
- relevant memories
- current bot/player/party snapshots
- command allowlist
- recent action history

8. Normalize model output into approved commands or no-op.
9. Record prompt/model/final plan/action result in audit logs.

## Concurrent Agent Work Plan

This project should be split between agents with non-overlapping ownership.

### Agent A: Bridge Data And APIs

Ownership:

- `tools/WoWLlmBridge/src/memory-store.js`
- `tools/WoWLlmBridge/src/server.js`
- new bridge modules for action/distill/state
- bridge migrations
- bridge unit tests

Tasks:

- Add state/action/KOS schema migration.
- Add memory-store methods.
- Add endpoint validators.
- Add action plan logging.
- Add action result logging.
- Add read-only MCP-style tools for state and social flags.

Avoid touching:

- C++ worldserver module.
- realness scorecard content except test output notes.

### Agent B: C++ Worldserver Routing

Ownership:

- `modules/mod-llm-npc-director/src/llm_npc_director.cpp`
- `modules/mod-llm-npc-director/conf/llm_npc_director.conf.dist`

Tasks:

- Add config toggles.
- Build world/player/bot snapshot payloads.
- Add action event posting.
- Parse action plan response.
- Validate command allowlist.
- Route approved commands through playerbot `HandleCommand`.
- Report action results.

Avoid touching:

- bridge memory schema except agreed endpoint fields.
- social prompt behavior.

### Agent C: Distiller And Social Logic

Ownership:

- bridge prompt builders
- distiller prompt/normalizer
- social memory decision logic
- realness smoke scripts

Tasks:

- Add distiller rules and model prompt.
- Convert major events into memories/trust/KOS/activity updates.
- Keep social chat reading distilled state.
- Prevent social lane from pretending to execute actions.

Avoid touching:

- C++ command routing.
- migration shape after Agent A lands it.

### Agent D: Test And Smoke Harness

Ownership:

- `tools/WoWLlmBridge/test/*`
- `tools/WoWLlmBridge/scripts/*`
- `docs/llm-bot-scorecards/*`

Tasks:

- Add action planner tests.
- Add state snapshot tests.
- Add distiller tests.
- Add fake bridge/C++ command routing smoke tests where possible.
- Extend live realness tests to include action-readiness scoring.
- Append scorecards after live tests.

Avoid touching:

- production route code unless fixing a failing test with coordination.

### Manager Responsibilities

- Keep agents on separate files where possible.
- Merge in this order: schema/API, C++ route, distiller/social, tests/docs.
- Avoid rebuilding playerbot unless a change actually touches playerbot-owned C++.
- Rebuild bridge only for bridge changes.
- Rebuild worldserver only for `mod-llm-npc-director` C++ changes.
- Keep commits squashed to meaningful milestones.

## Build Policy

Bridge-only changes:

```powershell
docker compose build wow-llm-bridge
docker compose up -d --no-build --force-recreate wow-llm-bridge
```

Worldserver module changes:

```powershell
docker compose build ac-worldserver
docker compose up -d --no-build --force-recreate ac-worldserver
```

Database import changes:

```powershell
docker compose build ac-db-import
```

Do not rebuild playerbot-specific modules unless their source/config actually changed.

## Testing

Required unit tests:

- action plan schema validation
- unknown command rejection
- expired plan rejection
- low-confidence action rejection
- KOS/trust decision policy
- "come to me" trusted player path
- "come to me" low-trust player refusal
- "what do you need" state-aware answer path
- "want powerlevel" trust/activity decision
- distiller trust deltas from help, death, trade, apology, and repeated grief
- no fake action claim from social lane

Required smoke tests:

- Live bridge health.
- Fake backend action plan success.
- Fake backend malformed output normalization.
- Fake backend repeated action throttle.
- C++ route with explicit allowlisted commands.
- Party chat request that causes both speech and action.
- Action result is written back to bridge.

Realness scoring should add an action category:

```text
Action Behind Words:
1 = says things but never acts, lies about actions, or repeats canned failure
5 = sometimes gives useful action-flavored chat but no reliable execution
8 = executes simple trusted requests and stays in character
10 = state-aware action, trust-aware refusal/acceptance, clean memory update, believable speech
```

## Risks

- Playerbot command vocabulary may be smaller than expected.
- LLM latency is too slow for twitch combat reactions.
- Stale action plans could execute after the context changed.
- Model may over-obey untrusted players without hard trust checks.
- Raw SQL or raw command tools could damage the server if exposed too early.
- Too many model lanes could overload llama.cpp unless strict priority and stale-drop rules are enforced.

Mitigations:

- Start with an allowlist.
- Keep action TTL short.
- Use rules for emergency commands where possible.
- Keep action lane structured and low-token.
- Log every final command and its source event.
- Use bridge-side validation and C++ validation.
- Keep social chat separate from command execution.

## Milestones

### Milestone 1: Bridge Skeleton

- Add state/action/KOS schema.
- Add `/api/state/snapshot`, `/api/action/event`, and `/api/action/result`.
- Add action validators and fake backend tests.
- No C++ routing yet.

### Milestone 2: C++ Command Execution

- Add action director config.
- Send minimal party action events.
- Parse action plan.
- Execute allowlisted commands.
- Report action result.

### Milestone 3: Trust And KOS

- Use relationship trust and social flags in action prompts.
- Add KOS storage and retrieval.
- Distill major events into trust/KOS updates.

### Milestone 4: State-Aware Requests

- Add bot/player snapshots.
- Support "come to me", "follow me", "what do you need", "want powerlevel", and "lets trade" as real state-aware flows.

### Milestone 5: Autonomous Party Bot Behavior

- Periodic action lane while grouped.
- Bot can call out needs, runners, cooldowns, CC, bad pulls, KOS sightings, and danger.
- Bot can act without requiring every command to be explicitly phrased.

## Working Principle

The chat model gives the bot a voice. The distiller gives it memory and social continuity. The action director gives it hands.

Do not let any one lane do all three jobs.
