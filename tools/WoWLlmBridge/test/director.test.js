"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/memory-store");
const { DirectorService, validateDirectorResponse } = require("../src/director");

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wow-llm-director-"));
  return path.join(dir, "memory.sqlite3");
}

test("validateDirectorResponse clamps unsafe model output", () => {
  const result = validateDirectorResponse({
    say: "x".repeat(200),
    intent: "assist_target",
    target_guid: null,
    confidence: 2
  }, { channel_type: "party" }, { bot_guid: 11 });

  assert.equal(result.intent, "say_only");
  assert.equal(result.say.length, 120);
  assert.equal(result.confidence, 1);
});

test("DirectorService returns action contract and writes proposed memory", async () => {
  const store = new MemoryStore({ dbPath: tempDb() });
  await store.init();
  const service = new DirectorService({
    store,
    config: {
      maxPromptChars: 8000,
      maxToolCallsPerEvent: 6,
      maxToolTimeMs: 2500
    },
    logger: () => {},
    complete: async () => JSON.stringify({
      bot_guid: 11,
      say: "I'm in. Make it ugly.",
      intent: "say_only",
      target_guid: null,
      confidence: 0.82,
      memory_update: {
        write: true,
        kind: "preference",
        summary: "Buddy likes testing risky pulls with guildmates when danger is controlled.",
        weight: 7,
        confidence: 0.75
      }
    })
  });

  const result = await service.handleEvent({
    event_id: "evt-director",
    event_type: "guild_chat",
    channel_type: "guild",
    scope_type: "guild",
    scope_id: "guild:42",
    guild_id: 42,
    speaker: {
      player_guid: 99,
      account_id: 1,
      name: "Buddy",
      is_real_player: true
    },
    eligible_bots: [{ bot_guid: 11, name: "Grimtok", tier: 3 }],
    message: "who wants to test a pull?"
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.bot_guid, 11);
  assert.equal(result.body.intent, "say_only");
  assert.equal(result.body.memory_write_ids.length, 1);
  assert.equal(result.body.debug.memory_count, 0);
});
