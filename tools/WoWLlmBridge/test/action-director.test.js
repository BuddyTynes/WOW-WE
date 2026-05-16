"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/memory-store");
const { ActionDirectorService, validateActionPlan } = require("../src/action-director");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wow-llm-action-"));
  const seedsDir = path.join(dir, "empty-seeds");
  fs.mkdirSync(seedsDir);
  return new MemoryStore({ dbPath: path.join(dir, "memory.sqlite3"), seedsDir });
}

test("validateActionPlan rejects unknown playerbot commands", () => {
  const result = validateActionPlan({
    intent: "follow_player",
    confidence: 0.8,
    commands: [{ type: "playerbot_command", command: "delete gear" }]
  }, {
    event_id: "evt-action",
    bot_guid: 11,
    speaker_player_guid: 99,
    channel_type: "party"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.approved, false);
  assert.match(result.data.rejection_reason, /not allowed/);
  assert.deepEqual(result.data.commands, []);
});

test("ActionDirectorService stores snapshots and approved action plans", async () => {
  const store = tempStore();
  await store.init();
  const service = new ActionDirectorService({ store, logger: () => {} });

  const snapshot = await service.handleStateSnapshot({
    bot: {
      guid: 11,
      name: "Cumm",
      level: 18,
      class: "Warrior",
      guild_id: 42,
      party_id: "party:1",
      current_activity: "questing",
      current_goal: "finish Westfall errands"
    },
    player: {
      guid: 99,
      account_id: 1,
      name: "Buddy",
      level: 60,
      class: "Warrior",
      guild_id: 42,
      guild_rank: "Guild Master",
      gear_score: 9001
    }
  });

  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.data.bots[0].bot_guid, 11);
  assert.equal(snapshot.body.data.players[0].player_guid, 99);

  const event = await service.handleActionEvent({
    event_id: "evt-follow",
    event_kind: "party_chat",
    channel_type: "party",
    scope_type: "party",
    scope_id: "party:1",
    party_id: "party:1",
    message: "come to me",
    bot: { guid: 11, name: "Cumm", party_id: "party:1" },
    speaker: { guid: 99, name: "Buddy", guild_id: 42 },
    candidate_plan: {
      intent: "follow_player",
      say: "fine but if you get me killed im haunting your bags",
      confidence: 0.82,
      ttl_ms: 4000,
      commands: [{ type: "playerbot_command", command: "follow", target_guid: 99 }]
    }
  });

  assert.equal(event.status, 200);
  assert.equal(event.body.ok, true);
  assert.equal(event.body.data.approved, true);
  assert.equal(event.body.data.commands[0].command, "follow");

  const counts = await store.getCounts();
  assert.equal(counts.action_plans, 1);
  assert.equal(counts.events, 2);
});

test("ActionDirectorService records action execution results", async () => {
  const store = tempStore();
  await store.init();
  const service = new ActionDirectorService({ store, logger: () => {} });
  await store.recordActionPlan({
    action_plan_id: "ap-follow",
    event_id: "evt-follow",
    bot_guid: 11,
    speaker_player_guid: 99,
    channel_type: "party",
    intent: "follow_player",
    approved: true,
    confidence: 0.8,
    ttl_ms: 4000,
    commands: [{ type: "playerbot_command", command: "follow", target_guid: 99 }]
  });

  const result = await service.handleActionResult({
    action_plan_id: "ap-follow",
    bot_guid: 11,
    command: "follow",
    success: true,
    result_code: "ok",
    result_message: "bot accepted follow command"
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.command, "follow");
  const counts = await store.getCounts();
  assert.equal(counts.action_results, 1);
});

test("ActionDirectorService builds deterministic party actions when no candidate plan is supplied", async () => {
  const store = tempStore();
  await store.init();
  const service = new ActionDirectorService({ store, logger: () => {} });

  const event = await service.handleActionEvent({
    event_id: "evt-skull-follow",
    event_kind: "party_chat",
    channel_type: "party",
    scope_type: "party",
    scope_id: "party:1",
    message: "cumm come to me and skull first",
    bot: { guid: 11, name: "Cumm", party_id: "party:1" },
    speaker: { guid: 99, name: "Buddy", guild_id: 42 }
  });

  assert.equal(event.status, 200);
  assert.equal(event.body.ok, true);
  assert.equal(event.body.data.approved, true);
  assert.deepEqual(event.body.data.commands.map((command) => command.command), ["follow", "rti skull", "attack"]);
});

test("ActionDirectorService accepts C++ action event shape with scoped bot names", async () => {
  const store = tempStore();
  await store.init();
  const service = new ActionDirectorService({ store, logger: () => {} });

  const event = await service.handleActionEvent({
    event_id: "evt-cpp-shape",
    event_kind: "party_chat",
    channel_type: "party",
    text: "bots run get out",
    speaker: { guid: 99, name: "Buddy", level: 60 },
    scope: {
      id: 123,
      name: "Buddy",
      human_count: 1,
      bot_count: 2,
      eligible_bots: ["Cumm", "Zartorg"]
    },
    command_allowlist: ["attack", "follow", "stay", "flee", "runaway"]
  });

  assert.equal(event.status, 200);
  assert.equal(event.body.ok, true);
  assert.equal(event.body.data.approved, true);
  assert.equal(event.body.data.bot_guid, -1);
  assert.deepEqual(event.body.data.commands.map((command) => command.command), ["flee", "runaway"]);
});

test("ActionDirectorService builds directed guild follow actions outside parties", async () => {
  const store = tempStore();
  await store.init();
  const service = new ActionDirectorService({ store, logger: () => {} });

  const event = await service.handleActionEvent({
    event_id: "evt-guild-come",
    event_kind: "guild_chat",
    channel_type: "guild",
    text: "Zartorg come to me",
    speaker: { guid: 99, name: "Buddy", level: 60 },
    scope: {
      id: 42,
      name: "WeCameWithBrokenTeeth",
      human_count: 1,
      bot_count: 2,
      eligible_bots: ["Cumm", "Zartorg"]
    }
  });

  assert.equal(event.status, 200);
  assert.equal(event.body.ok, true);
  assert.equal(event.body.data.approved, true);
  assert.equal(event.body.data.bot_name, "Zartorg");
  assert.deepEqual(event.body.data.commands.map((command) => command.command), ["follow"]);
});
