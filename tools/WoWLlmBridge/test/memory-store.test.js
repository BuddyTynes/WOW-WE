"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/memory-store");

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wow-llm-memory-"));
  return path.join(dir, "memory.sqlite3");
}

test("MemoryStore migrates and reads typed profile/memory APIs", async () => {
  const store = new MemoryStore({ dbPath: tempDb() });
  await store.init();

  assert.equal(store.health().ok, true);
  assert.equal((await store.upsertBotProfile({ bot_guid: 11, name: "Grimtok", tier: 3 })).ok, true);
  assert.equal((await store.upsertPlayerProfile({ player_guid: 99, account_id: 1, name: "Buddy" })).ok, true);

  const relationship = await store.getRelationship({ bot_guid: 11, player_guid: 99, create_if_missing: true });
  assert.equal(relationship.ok, true);
  assert.equal(relationship.data.familiarity, 0);

  const write = await store.writeMemory({
    event_id: "evt-test",
    bot_guid: 11,
    player_guid: 99,
    guild_id: 42,
    scope_type: "bot_player",
    scope_id: "bot:11/player:99",
    kind: "preference",
    summary: "Buddy enjoys testing risky pulls when the group is not in danger.",
    weight: 7,
    confidence: 0.8
  });
  assert.equal(write.ok, true);

  const search = await store.searchMemories({
    bot_guid: 11,
    player_guid: 99,
    guild_id: 42,
    scope_type: "guild",
    scope_id: "guild:42",
    limit: 3
  });
  assert.equal(search.ok, true);
  assert.equal(search.data.memories.length, 1);
  assert.equal(search.data.memories[0].kind, "preference");
});

test("MemoryStore validates memory writes", async () => {
  const store = new MemoryStore({ dbPath: tempDb() });
  await store.init();
  await store.upsertBotProfile({ bot_guid: 11, name: "Grimtok" });

  const result = await store.writeMemory({
    bot_guid: 11,
    scope_type: "system",
    scope_id: "system",
    kind: "unknown",
    summary: "too short"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_request");
});
