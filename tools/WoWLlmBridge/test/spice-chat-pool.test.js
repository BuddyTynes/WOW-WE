"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseElvuiChat, stripWowMarkup } = require("../../ChatLogPool/src/elvui-parser");
const { MemoryStore } = require("../src/memory-store");
const { buildLegacyDirectorPrompt } = require("../src/server");
const { DirectorService } = require("../src/director");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tempDb() {
  return path.join(tempDir("wow-llm-spice-"), "memory.sqlite3");
}

function writeSeed(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  const seedPath = path.join(dir, "spice_chat_pool.seed.jsonl");
  fs.writeFileSync(seedPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return seedPath;
}

function seedRecord(overrides = {}) {
  return {
    line_hash: overrides.line_hash || "line_one",
    source_hash: overrides.source_hash || "source_one",
    source_file: overrides.source_file || "source_file_hash",
    source_table: overrides.source_table || "ChatHistoryLog",
    source_key: overrides.source_key || "1",
    message: overrides.message || "yeah we can do that after this pull",
    speaker: overrides.speaker || "Tester",
    channel_type: overrides.channel_type || "guild",
    channel_name: overrides.channel_name || "Guild",
    event_type: overrides.event_type || "CHAT_MSG_GUILD",
    event_timestamp: overrides.event_timestamp || 1700000000,
    quality_score: overrides.quality_score || 85,
    exact_safe: overrides.exact_safe === undefined ? true : overrides.exact_safe,
    tags: overrides.tags || ["guild"],
    metadata: overrides.metadata || { fixture: true }
  };
}

test("ElvUI parser extracts ChatHistoryLog and cleans WoW markup", () => {
  const lua = `
ElvCharacterDB = {
  ["ChatHistoryLog"] = {
    {
      "|cffffd623Hello|r |Hitem:123|h[Shiny Sword]|h", -- [1]
      "Speaker", -- [2]
      "", -- [3]
      "Guild", -- [4]
      "Speaker", -- [5]
      "", -- [6]
      0, -- [7]
      0, -- [8]
      "Guild", -- [9]
      [51] = 1700000000,
      [50] = "CHAT_MSG_GUILD",
    }, -- [1]
  },
}`;

  const parsed = parseElvuiChat(lua, { sourceFileHash: "fixture" });

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].message, "Hello Shiny Sword");
  assert.equal(parsed.records[0].channel_type, "guild");
  assert.equal(stripWowMarkup("|TIcon:16|t {Star} yo |r"), "yo");
});

test("ElvUI parser extracts timestamp-keyed ChatLog entries and rejects system chat", () => {
  const lua = `
ElvCharacterDB = {
  ["ChatLog"] = {
    ["1686274973.437"] = {
      "psst this is a whisper", -- [1]
      "Buddy", -- [2]
      "", -- [3]
      "", -- [4]
      [20] = "CHAT_MSG_WHISPER",
    },
    ["1686274974.000"] = {
      "You have learned a spell.", -- [1]
      "", -- [2]
      [20] = "CHAT_MSG_SYSTEM",
    },
  },
}`;

  const parsed = parseElvuiChat(lua, { sourceFileHash: "fixture" });

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].source_table, "ChatLog");
  assert.equal(parsed.records[0].channel_type, "whisper");
  assert.equal(parsed.records[0].exact_safe, false);
  assert.equal(parsed.rejected.not_player_chat, 1);
});

test("MemoryStore imports Spice seed idempotently and returns inspiration", async () => {
  const seedsDir = tempDir("wow-llm-spice-seeds-");
  writeSeed(seedsDir, [
    seedRecord(),
    seedRecord({ line_hash: "line_two", message: "rip, that pull was doomed", channel_type: "world", channel_name: "world" }),
    seedRecord({ line_hash: "line_three", message: "buddy whispered this one", channel_type: "whisper", exact_safe: false })
  ]);
  const store = new MemoryStore({ dbPath: tempDb(), seedsDir });
  await store.init();
  await store.importBundledSpiceSeeds();

  const counts = await store.getCounts();
  assert.equal(counts.spice_lines, 3);

  const result = await store.getChatInspiration({
    channel_type: "guild",
    limit: 2,
    min_quality: 50,
    exact_chance: 100
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.lines.length >= 1);
  assert.ok(result.data.lines.some((line) => line.allow_exact));

  const ambient = await store.getChatInspiration({
    channel_type: "whisper",
    limit: 3,
    min_quality: 50,
    exact_chance: 100,
    exact_safe_only: true
  });

  assert.equal(ambient.ok, true);
  assert.ok(ambient.data.lines.length >= 1);
  assert.ok(ambient.data.lines.every((line) => line.exact_safe));
  assert.ok(!ambient.data.lines.some((line) => line.line_hash === "line_three"));
});

test("legacy director prompt includes Spice style examples", () => {
  const prompt = buildLegacyDirectorPrompt({
    channel: "guild",
    scopeName: "Tiny Problems",
    speaker: "Buddy",
    bots: ["Grimtok"],
    message: "anyone up for RFC?"
  }, {
    selectedBot: "Grimtok",
    memories: [],
    recentChat: [],
    spiceLines: [seedRecord({ channel_type: "guild" })]
  });

  assert.match(prompt, /SPICE_OF_LIFE_STYLE/);
  assert.match(prompt, /copy-ok/);
  assert.match(prompt, /yeah we can do that after this pull/);
});

test("DirectorService prompt receives Spice inspiration", async () => {
  const seedsDir = tempDir("wow-llm-spice-seeds-");
  writeSeed(seedsDir, [seedRecord()]);
  const store = new MemoryStore({ dbPath: tempDb(), seedsDir });
  await store.init();
  let capturedPrompt = "";
  const service = new DirectorService({
    store,
    config: {
      maxPromptChars: 8000,
      maxToolCallsPerEvent: 6,
      maxToolTimeMs: 2500,
      spiceEnable: true,
      spiceLines: 1,
      spiceMinQuality: 50,
      spiceExactChance: 100
    },
    logger: () => {},
    complete: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ bot_guid: 11, say: "sounds good", intent: "say_only" });
    }
  });

  await service.handleEvent({
    event_id: "evt-spice",
    channel_type: "guild",
    scope_type: "guild",
    scope_id: "guild:42",
    guild_id: 42,
    speaker: { player_guid: 99, account_id: 1, name: "Buddy" },
    eligible_bots: [{ bot_guid: 11, name: "Grimtok", tier: 3 }],
    message: "ready?"
  });

  assert.match(capturedPrompt, /chat_inspiration/);
  assert.match(capturedPrompt, /yeah we can do that after this pull/);
});
