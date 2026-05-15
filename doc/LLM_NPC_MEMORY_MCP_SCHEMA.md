# LLM NPC Memory And MCP Schema

This document is the implementation-ready persistence and tool-contract spec
for the LLM NPC system described in [LLM_NPC_DESIGN.md](LLM_NPC_DESIGN.md) and
[LLM_NPC_EXECUTION_PLAN.md](LLM_NPC_EXECUTION_PLAN.md).

## Storage Decision

Use bridge-owned storage for the first milestone.

Recommended first implementation:

```text
wow-llm-bridge
  owns SQLite database file
  owns migrations
  owns memory/profile/event APIs
  exposes typed internal APIs and optional MCP tools

mod-llm-npc-director
  sends compact chat/game event payloads
  receives validated chat/intent results
  does not own durable memory tables
```

Rationale:

- Bridge-owned migrations avoid `ac-worldserver` and `ac-db-import` rebuilds.
- Memory schema can change quickly while prompt and retrieval behavior evolves.
- The director module stays thin and does not need broad SQL permissions.
- The bridge can use the same store for prompt assembly, MCP tools, smoke tests,
  and local debugging.
- The live AzerothCore character/world schemas stay lower risk.

Do not add module SQL for the first milestone unless the director must perform a
worldserver-side query that cannot be supplied in the event payload. If module
SQL becomes necessary later, place it under
`modules/mod-llm-npc-director/data/sql` and batch it with other C++/SQL rebuild
work.

## Database File

Default bridge database path:

```text
WOW_LLM_MEMORY_DB=./data/llm_memory.sqlite3
```

The bridge should create the parent directory if missing, run migrations on
startup, and fail health checks if migrations fail.

SQLite settings on open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

## Identity Rules

Use stable game IDs when available, and names only as display fields.

| Field | Meaning |
| --- | --- |
| `bot_guid` | AzerothCore character GUID for the bot. Required for bot-scoped rows. |
| `player_guid` | AzerothCore character GUID for the speaking/known player. Required when known. |
| `account_id` | AzerothCore account ID if supplied by the director. Useful for cross-character profile stitching later. |
| `guild_id` | AzerothCore guild ID. Required for guild-scoped events and summaries. |
| `party_id` | Runtime group/party identifier supplied by the director or bridge. May be ephemeral. |
| `scope_type` | One of `guild`, `party`, `whisper`, `bot_player`, `system`. |
| `scope_id` | Stable string within `scope_type`, such as `guild:42`, `party:abc`, or `bot:11/player:99`. |

Do not key durable memory only by character name. Names can change.

## Enums

`channel_type`:

```text
guild, party, raid, whisper, say, system
```

`memory_kind`:

```text
relationship, preference, fact, promise, conflict, achievement, instruction,
summary, system_note
```

`event_kind`:

```text
chat_in, chat_out, intent_in, intent_out, memory_write, summary_write,
tool_call, tool_error, model_error, system
```

`intent`:

```text
say_only, follow_leader, assist_target, hold_position, move_closer,
heal_priority, avoid_combat, need_help
```

## SQLite DDL

Use one migration per schema version. The first migration should create the
tables and indexes below.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS bot_profiles (
  bot_guid INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  race TEXT,
  class TEXT,
  gender TEXT,
  tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 4),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  temperament TEXT,
  speech_style TEXT,
  personality_seed TEXT NOT NULL DEFAULT '',
  likes_json TEXT NOT NULL DEFAULT '[]',
  dislikes_json TEXT NOT NULL DEFAULT '[]',
  boundaries_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS player_profiles (
  player_guid INTEGER PRIMARY KEY,
  account_id INTEGER,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  known_facts_json TEXT NOT NULL DEFAULT '{}',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bot_player_relationships (
  bot_guid INTEGER NOT NULL,
  player_guid INTEGER NOT NULL,
  relationship_summary TEXT NOT NULL DEFAULT '',
  affinity INTEGER NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -100 AND 100),
  trust INTEGER NOT NULL DEFAULT 0 CHECK (trust BETWEEN -100 AND 100),
  familiarity INTEGER NOT NULL DEFAULT 0 CHECK (familiarity BETWEEN 0 AND 100),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (bot_guid, player_guid),
  FOREIGN KEY (bot_guid) REFERENCES bot_profiles(bot_guid) ON DELETE CASCADE,
  FOREIGN KEY (player_guid) REFERENCES player_profiles(player_guid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  bot_guid INTEGER NOT NULL,
  player_guid INTEGER,
  guild_id INTEGER,
  party_id TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_event_id TEXT,
  weight INTEGER NOT NULL DEFAULT 5 CHECK (weight BETWEEN 1 AND 10),
  confidence REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  superseded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (bot_guid) REFERENCES bot_profiles(bot_guid) ON DELETE CASCADE,
  FOREIGN KEY (player_guid) REFERENCES player_profiles(player_guid) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  summary_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bot_guid INTEGER,
  player_guid INTEGER,
  guild_id INTEGER,
  party_id TEXT,
  channel_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_event_id TEXT,
  end_event_id TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_event_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS event_log (
  event_id TEXT PRIMARY KEY,
  parent_event_id TEXT,
  event_kind TEXT NOT NULL,
  channel_type TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bot_guid INTEGER,
  player_guid INTEGER,
  guild_id INTEGER,
  party_id TEXT,
  source TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'internal')),
  text TEXT,
  intent TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  model_json TEXT,
  prompt_chars INTEGER,
  output_chars INTEGER,
  latency_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tool_audit_log (
  audit_id TEXT PRIMARY KEY,
  event_id TEXT,
  caller TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  bot_guid INTEGER,
  player_guid INTEGER,
  request_json TEXT NOT NULL DEFAULT '{}',
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  row_count INTEGER,
  latency_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

## Required Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_bot_profiles_enabled_tier
  ON bot_profiles(enabled, tier, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_player_profiles_account
  ON player_profiles(account_id, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_player_profiles_name
  ON player_profiles(normalized_name);

CREATE INDEX IF NOT EXISTS idx_relationships_player
  ON bot_player_relationships(player_guid, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_relationships_bot_seen
  ON bot_player_relationships(bot_guid, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_memories_bot_player_seen
  ON memories(bot_guid, player_guid, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_scope_seen
  ON memories(scope_type, scope_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_guild_seen
  ON memories(guild_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_party_seen
  ON memories(party_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_weight_seen
  ON memories(weight DESC, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_kind
  ON memories(kind, bot_guid, player_guid);

CREATE INDEX IF NOT EXISTS idx_summaries_scope_event
  ON conversation_summaries(scope_type, scope_id, last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_summaries_guild
  ON conversation_summaries(guild_id, last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_summaries_party
  ON conversation_summaries(party_id, last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_scope_created
  ON event_log(scope_type, scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_bot_created
  ON event_log(bot_guid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_player_created
  ON event_log(player_guid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_guild_created
  ON event_log(guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_party_created
  ON event_log(party_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_kind_created
  ON event_log(event_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_audit_event
  ON tool_audit_log(event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_audit_tool_created
  ON tool_audit_log(tool_name, created_at DESC);
```

Optional, if SQLite is compiled with FTS5:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(summary, memory_id UNINDEXED, tokenize='porter unicode61');
```

If FTS5 is not available, `search_memories` should combine scoped indexed
queries with simple application-side scoring over the top recent/weighted rows.

## Retention And Compaction

Defaults:

- Keep `event_log` rows for 30 days.
- Keep failed `event_log` and `tool_audit_log` rows for 90 days.
- Keep `memories` until explicitly expired or superseded.
- Keep `conversation_summaries` until superseded by a newer summary for the same
  scope, then retain old summaries for 90 days.

The bridge should summarize raw chat into `conversation_summaries` whenever a
scope accumulates more than 25 recent chat events or 8 KB of raw text since the
last summary.

Memory writes should be compact, durable claims, not raw transcripts.

## Typed Tool Contracts

Tool responses must include:

```json
{
  "ok": true,
  "error": null,
  "data": {}
}
```

On failure:

```json
{
  "ok": false,
  "error": {
    "code": "not_found",
    "message": "Bot profile not found"
  },
  "data": null
}
```

### get_bot_profile

Request:

```json
{
  "bot_guid": 11,
  "bot_key": null
}
```

Response data:

```json
{
  "bot_guid": 11,
  "bot_key": "grimtok",
  "name": "Grimtok",
  "race": "Orc",
  "class": "Warrior",
  "tier": 3,
  "enabled": true,
  "temperament": "loud, loyal, reckless",
  "speech_style": "classic MMO player, short and confident",
  "personality_seed": "Grimtok loves risky pulls but protects guildmates.",
  "likes": ["duels", "big crits", "risky pulls"],
  "dislikes": ["cowardice", "overplanning"],
  "boundaries": ["Do not claim to be an AI"],
  "metadata": {}
}
```

### get_player_profile

Request:

```json
{
  "player_guid": 99,
  "account_id": null,
  "name": "Buddy"
}
```

Lookup order: `player_guid`, then `account_id`, then normalized `name`.

Response data:

```json
{
  "player_guid": 99,
  "account_id": 1,
  "name": "Buddy",
  "known_facts": {},
  "preferences": {},
  "first_seen_at": "2026-05-15T20:00:00.000Z",
  "last_seen_at": "2026-05-15T20:10:00.000Z"
}
```

### upsert_player_profile

The director should call this, or the bridge should call it implicitly, when a
human player appears in an event.

Request:

```json
{
  "player_guid": 99,
  "account_id": 1,
  "name": "Buddy",
  "metadata": {
    "race": "Human",
    "class": "Paladin"
  }
}
```

Response data:

```json
{
  "player_guid": 99,
  "created": false,
  "updated": true
}
```

### get_relationship

Request:

```json
{
  "bot_guid": 11,
  "player_guid": 99,
  "create_if_missing": true
}
```

Response data:

```json
{
  "bot_guid": 11,
  "player_guid": 99,
  "relationship_summary": "Buddy likes chaotic PvP testing.",
  "affinity": 15,
  "trust": 10,
  "familiarity": 35,
  "interaction_count": 8,
  "last_seen_at": "2026-05-15T20:10:00.000Z"
}
```

### search_memories

Request:

```json
{
  "bot_guid": 11,
  "player_guid": 99,
  "guild_id": 42,
  "party_id": null,
  "scope_type": "guild",
  "scope_id": "guild:42",
  "query": "risky pulls and PvP testing",
  "kinds": ["relationship", "preference", "fact", "promise", "summary"],
  "limit": 6,
  "include_expired": false
}
```

Limits:

- `limit` defaults to 5.
- `limit` hard maximum is 12.
- Exclude rows where `superseded_by IS NOT NULL`.
- Exclude expired rows unless `include_expired=true` and caller is `debug`.

Scoring should prioritize:

1. Same `bot_guid` plus same `player_guid`.
2. Same guild or party scope.
3. Higher `weight`.
4. More recent `last_seen_at`.
5. Text similarity when FTS/vector search is available.

Response data:

```json
{
  "memories": [
    {
      "memory_id": "mem_01HX...",
      "kind": "relationship",
      "summary": "Buddy likes chaotic PvP testing and strange builds.",
      "weight": 8,
      "confidence": 0.8,
      "last_seen_at": "2026-05-15T20:10:00.000Z",
      "score": 0.91
    }
  ]
}
```

### write_memory

Request:

```json
{
  "event_id": "evt_01HX...",
  "bot_guid": 11,
  "player_guid": 99,
  "guild_id": 42,
  "party_id": null,
  "scope_type": "bot_player",
  "scope_id": "bot:11/player:99",
  "kind": "preference",
  "summary": "Buddy enjoys testing risky pulls when the group is not in hardcore danger.",
  "weight": 7,
  "confidence": 0.75,
  "pinned": false,
  "expires_at": null,
  "metadata": {}
}
```

Validation:

- `summary` must be 20 to 500 characters.
- `kind` must be an approved `memory_kind`.
- `weight` must be 1 to 10.
- `confidence` must be 0.0 to 1.0.
- Only bridge code or trusted admin/debug callers may write memory.
- The model may propose a memory update, but the bridge must validate and write
  it through this API.

Response data:

```json
{
  "memory_id": "mem_01HX...",
  "created": true
}
```

### record_event

Request:

```json
{
  "event_id": "evt_01HX...",
  "parent_event_id": null,
  "event_kind": "chat_in",
  "channel_type": "guild",
  "scope_type": "guild",
  "scope_id": "guild:42",
  "bot_guid": 11,
  "player_guid": 99,
  "guild_id": 42,
  "party_id": null,
  "source": "mod-llm-npc-director",
  "direction": "in",
  "text": "who wants to test a pull?",
  "intent": null,
  "payload": {
    "player_name": "Buddy",
    "guild_name": "Test Guild"
  }
}
```

Response data:

```json
{
  "event_id": "evt_01HX...",
  "created": true
}
```

### get_recent_chat

Request:

```json
{
  "scope_type": "guild",
  "scope_id": "guild:42",
  "channel_type": "guild",
  "limit": 12,
  "since_event_id": null
}
```

Limits:

- `limit` defaults to 10.
- `limit` hard maximum is 25.
- Return only `chat_in` and `chat_out` events.
- Truncate each text field to 500 characters in the response.

Response data:

```json
{
  "events": [
    {
      "event_id": "evt_01HX...",
      "created_at": "2026-05-15T20:10:00.000Z",
      "direction": "in",
      "player_guid": 99,
      "bot_guid": null,
      "speaker_name": "Buddy",
      "text": "who wants to test a pull?"
    }
  ]
}
```

### write_conversation_summary

Request:

```json
{
  "scope_type": "guild",
  "scope_id": "guild:42",
  "bot_guid": 11,
  "player_guid": null,
  "guild_id": 42,
  "party_id": null,
  "channel_type": "guild",
  "summary": "Buddy asked the guild to test risky pulls; Grimtok encouraged it.",
  "start_event_id": "evt_01HX...",
  "end_event_id": "evt_01HY...",
  "event_count": 14,
  "token_estimate": 96,
  "metadata": {}
}
```

Response data:

```json
{
  "summary_id": "sum_01HX...",
  "created": true
}
```

## Director Event Payload Contract

The director should forward compact events to the bridge in this shape:

```json
{
  "event_id": "evt_01HX...",
  "event_type": "guild_chat",
  "channel_type": "guild",
  "scope_type": "guild",
  "scope_id": "guild:42",
  "guild_id": 42,
  "party_id": null,
  "speaker": {
    "player_guid": 99,
    "account_id": 1,
    "name": "Buddy",
    "is_bot": false,
    "is_real_player": true
  },
  "eligible_bots": [
    {
      "bot_guid": 11,
      "name": "Grimtok",
      "tier": 3
    }
  ],
  "message": "who wants to test a pull?",
  "server_time": "2026-05-15T20:10:00.000Z",
  "context": {
    "map_id": 0,
    "zone_id": 12,
    "guild_has_real_player": true
  }
}
```

The bridge owns bot selection if more than one eligible bot is supplied. The
director must never send bot-only guild events as eligible LLM events.

## Action Response Contract

Guild/chat-only response:

```json
{
  "event_id": "evt_01HX...",
  "bot_guid": 11,
  "channel_type": "guild",
  "say": "I'm in. Make it ugly.",
  "intent": "say_only",
  "target_guid": null,
  "confidence": 0.82,
  "memory_write_ids": ["mem_01HX..."],
  "debug": {
    "memory_count": 4,
    "prompt_chars": 3100,
    "latency_ms": 1200
  }
}
```

Party/action response:

```json
{
  "event_id": "evt_01HX...",
  "bot_guid": 11,
  "channel_type": "party",
  "say": "On you.",
  "intent": "assist_target",
  "target_guid": 99,
  "confidence": 0.79,
  "memory_write_ids": [],
  "debug": {
    "memory_count": 3,
    "prompt_chars": 3400,
    "latency_ms": 1400
  }
}
```

Validation:

- `say` maximum 180 characters for guild and 120 characters for party.
- `intent` must be in the allowed intent enum.
- `target_guid` is required only for intents that need a target.
- Unknown intents become `say_only` or safe no-op.
- The director routes only validated responses.

## SQL Escape Hatch

The SQL escape hatch is for development and advanced debugging only. Normal
gameplay must use typed APIs.

Tool name:

```text
sql_query
```

Request:

```json
{
  "caller": "debug",
  "event_id": "evt_01HX...",
  "query": "SELECT bot_guid, name, tier FROM v_llm_bot_profiles WHERE enabled = 1 LIMIT 10",
  "params": {},
  "max_rows": 25,
  "timeout_ms": 500
}
```

Hard restrictions:

- Read-only connection.
- Single statement only.
- `SELECT` only after trimming comments and whitespace.
- No semicolons except an optional final semicolon.
- No `PRAGMA`, `ATTACH`, `DETACH`, `CREATE`, `DROP`, `ALTER`, `INSERT`,
  `UPDATE`, `DELETE`, `REPLACE`, `VACUUM`, `ANALYZE`, `REINDEX`, `TRIGGER`, or
  `WITH ... INSERT/UPDATE/DELETE`.
- Approved views only; raw table access is denied by default.
- `max_rows` defaults to 25 and hard-caps at 50.
- `timeout_ms` defaults to 500 and hard-caps at 1000.
- Every query is logged to `tool_audit_log` with caller, event, bot, player,
  latency, row count, approval result, and error code.
- Disable this tool in normal gameplay prompts. Enable only for admin/debug
  callers or smoke tests.

Approved read views:

```sql
CREATE VIEW IF NOT EXISTS v_llm_bot_profiles AS
SELECT bot_guid, bot_key, name, race, class, tier, enabled, last_seen_at
FROM bot_profiles;

CREATE VIEW IF NOT EXISTS v_llm_player_profiles AS
SELECT player_guid, account_id, name, first_seen_at, last_seen_at
FROM player_profiles;

CREATE VIEW IF NOT EXISTS v_llm_relationships AS
SELECT bot_guid, player_guid, affinity, trust, familiarity, interaction_count,
       last_seen_at
FROM bot_player_relationships;

CREATE VIEW IF NOT EXISTS v_llm_memories AS
SELECT memory_id, bot_guid, player_guid, guild_id, party_id, scope_type,
       scope_id, kind, summary, weight, confidence, pinned, last_seen_at,
       expires_at
FROM memories
WHERE superseded_by IS NULL;

CREATE VIEW IF NOT EXISTS v_llm_recent_events AS
SELECT event_id, event_kind, channel_type, scope_type, scope_id, bot_guid,
       player_guid, guild_id, party_id, direction, intent, success, error_code,
       created_at
FROM event_log;

CREATE VIEW IF NOT EXISTS v_llm_conversation_summaries AS
SELECT summary_id, scope_type, scope_id, bot_guid, player_guid, guild_id,
       party_id, channel_type, summary, event_count, last_event_at
FROM conversation_summaries;
```

The SQL validator should reject any query referencing objects outside this
allowlist. Prefer a real SQL parser if one is already available in the bridge
stack; otherwise use a conservative deny-by-default validator and allow only
simple `SELECT ... FROM approved_view ... LIMIT n` shapes.

## Bridge/MCP Runtime Limits

Per event:

- Maximum 6 typed tool calls.
- Maximum 1 SQL escape-hatch call, debug only.
- Maximum 2500 ms total tool time before model call.
- Maximum 8000 prompt characters for first milestone unless runtime tuning
  proves a higher cap is stable.
- Maximum 4 retrieved direct memories plus 2 scope summaries for guild chat.
- Maximum 6 retrieved direct memories plus 2 scope summaries for party actions.

Failure posture:

- Missing profile: no LLM call unless the bot has an inline event profile.
- Missing relationship: create empty relationship and continue.
- Memory search failure: continue with profile and recent chat only.
- Event logging failure: continue only if the event can still be handled safely,
  but mark bridge health degraded.
- Memory write failure: never block chat/intent response.

## Seed Data Shape

Initial bot profiles can be inserted by bridge migration, admin API, or a small
seed file loaded by the bridge:

```json
[
  {
    "bot_guid": 11,
    "bot_key": "grimtok",
    "name": "Grimtok",
    "race": "Orc",
    "class": "Warrior",
    "tier": 3,
    "enabled": true,
    "temperament": "loud, loyal, reckless",
    "speech_style": "classic MMO player, short and confident",
    "personality_seed": "Grimtok is a loyal guild bruiser who likes risky pulls.",
    "likes": ["duels", "big crits", "risky pulls"],
    "dislikes": ["cowardice", "overplanning"]
  }
]
```

Keep seed data outside AzerothCore SQL for the first milestone so profile tuning
does not spend rebuild or DB-import budget.

## Future Migration Path

If bridge-owned SQLite becomes too limiting, migrate to bridge-owned MySQL or
PostgreSQL before considering module-owned SQL. The contract above should stay
stable while storage changes behind it.

Module-owned SQL is justified only when:

- The worldserver must make local decisions while the bridge is unavailable.
- The director needs persistent state before forwarding events.
- Bridge-local storage cannot satisfy performance or operational requirements.

Even then, normal memory writes should still route through typed APIs, and the
director should not expose arbitrary SQL to model output.
