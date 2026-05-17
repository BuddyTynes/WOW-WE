# WoW LLM Bridge Runtime Notes

This bridge is intentionally configured as limited-concurrency infrastructure
for llama.cpp/OpenAI-compatible backends.

Current safety posture:

- `WOW_LLM_MAX_CONCURRENT=1` is enforced by config loading.
- `WOW_LLM_TIMEOUT_MS` bounds each backend completion request.
- `WOW_LLM_MAX_PROMPT_CHARS`, `WOW_LLM_MAX_TOKENS`, and
  `WOW_LLM_MAX_OUTPUT_CHARS` cap prompt and response size.
- `WOW_LLM_MAX_QUEUE_SIZE` and `WOW_LLM_MAX_QUEUE_AGE_MS` bound queued work and
  drop stale chat events instead of letting old events block fresh ones.
- `WOW_LLM_CIRCUIT_FAILURE_THRESHOLD` and `WOW_LLM_CIRCUIT_COOLDOWN_MS` open a
  temporary circuit after repeated backend failures.
- `WOW_LLM_MEMORY_DB` defaults to `./data/llm_memory.sqlite3`. The bridge
  creates the parent directory, runs SQLite migrations, enables WAL/foreign key
  settings, and reports degraded health if migration fails.
  The current implementation expects `sqlite3` to be available on `PATH`.
- `WOW_LLM_MAX_TOOL_CALLS_PER_EVENT` defaults to 6 and
  `WOW_LLM_MAX_TOOL_TIME_MS` defaults to 2500 ms for director memory/profile
  lookups before the model call.
- `WOW_LLM_SPICE_ENABLE=1` enables the imported Spice of Life chat pool.
  `WOW_LLM_SPICE_LINES`, `WOW_LLM_SPICE_EXACT_CHANCE`, and
  `WOW_LLM_SPICE_MIN_QUALITY` control how many style examples are added to
  director prompts and how often exact-safe lines may be reused.
- `WOW_LLM_BURST_MAX_LINES` and `WOW_LLM_BURST_SPICE_LINES` bound the
  multi-bot director burst endpoint used for hardcore death pile-ons and
  World-channel argument beats. If the local model is not running, the
  worldserver falls back to bounded canned lines.
- `/health` reports queue/circuit/cap state plus memory DB health and counts.
  `/health?probe=1` also probes the OpenAI-compatible `/models` endpoint.
  `apiKeyRequired=false` and `hasApiKey=false` are expected for local
  llama.cpp endpoints.

Bridge-owned memory endpoints:

```text
POST /api/memory/get_bot_profile
POST /api/memory/get_player_profile
POST /api/memory/upsert_player_profile
POST /api/memory/get_relationship
POST /api/memory/search_memories
POST /api/memory/write_memory
POST /api/memory/record_event
POST /api/memory/get_recent_chat
POST /api/memory/get_chat_inspiration
POST /api/memory/write_conversation_summary
```

Bot guild invite decisions are handled by:

```text
POST /api/bot-guild-invite/decision
```

The first implementation uses cached bridge-owned relationship affinity as the
likeability source. Affinity `-100..100` maps to accept chance `0..100`; missing
relationships use the caller's `default_likeability`. Decisions are cached per
bot/inviter/guild for the requested TTL, defaulting to one hour from the
worldserver module config.

Typed memory endpoints return `{ "ok": true, "error": null, "data": ... }` or
`{ "ok": false, "error": { "code": "...", "message": "..." }, "data": null }`.
`write_memory` is restricted to callers marked as `bridge`, `admin`, or `debug`
with `x-wow-caller` or a `caller` body field. Normal gameplay memory writes are
performed by bridge-owned director code after validation.

Director events can be posted to `POST /api/director/event`. Director-shaped
bodies sent to `/api/generate` are also routed through the same path. The bridge
selects the highest-tier eligible bot, upserts the speaker profile, records the
incoming chat event, retrieves bounded relationship/memory/recent-chat context,
and asks the model for strict JSON:

```json
{
  "bot_guid": 11,
  "say": "I'm in. Make it ugly.",
  "intent": "say_only",
  "target_guid": null,
  "confidence": 0.82,
  "memory_update": {
    "write": false,
    "kind": "summary",
    "summary": "",
    "weight": 5,
    "confidence": 0.7
  }
}
```

The validated action response returned to the director is:

```json
{
  "event_id": "evt_...",
  "bot_guid": 11,
  "channel_type": "guild",
  "say": "I'm in. Make it ugly.",
  "intent": "say_only",
  "target_guid": null,
  "confidence": 0.82,
  "memory_write_ids": [],
  "debug": {
    "memory_count": 0,
    "prompt_chars": 1200,
    "latency_ms": 400
  }
}
```

Guild replies are capped at 180 characters and party replies at 120. Unknown
intents fall back to `say_only`; target-required intents without a target also
fall back to `say_only`. Proposed `memory_update` objects are validated by the
bridge before insertion and failed memory writes do not block the chat response.

For local llama.cpp, keep prompts modest and spend VRAM headroom on stable
runtime settings rather than giant context. If `/health?probe=1` reports the
backend unhealthy or the circuit stays open, restart or refresh the llama.cpp
server, then recheck bridge health before relying on guild or party chat.

Verification commands:

```powershell
node --test
node scripts/smoke.js
```

The smoke harness uses a fake OpenAI-compatible backend, simulates guild and
party events, injects malformed output and temporary backend failures, and
prints request counts, success/failure counts, p50/p95 latency, queue depth,
prompt/output size ranges, stale drops, and backend health recovery.
