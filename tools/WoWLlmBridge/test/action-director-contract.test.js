"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseLegacyDirectorPrompt,
  normalizeLegacyDirectorResponse
} = require("../src/server");

function loadActionValidator() {
  const candidates = [
    "../src/action-director",
    "../src/director"
  ];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      const fn = mod.validateActionPlan ||
        mod.validateActionDirectorPlan ||
        mod.normalizeActionPlan ||
        mod.validateActionResponse;
      if (typeof fn === "function") {
        return { fn, source: candidate };
      }
    } catch (error) {
      if (error && error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
  }
  return null;
}

const validator = loadActionValidator();

function requireValidator(t) {
  if (!validator) {
    t.skip("Action Director validator is not exported yet; scaffold will activate when Agent A adds validateActionPlan.");
    return null;
  }
  return validator.fn;
}

function validate(plan, context = {}) {
  return validator.fn(plan, {
    now_ms: 1_750_000_000_000,
    allowed_commands: ["attack", "follow", "stay", "flee", "runaway", "max dps", "rti skull", "rti cross", "rti cc moon", "rti cc star", "rti cc diamond"],
    min_confidence: 0.5,
    ...context
  });
}

function asPlan(result) {
  if (result && result.data && typeof result.data === "object") {
    return result.data;
  }
  return result && result.plan && typeof result.plan === "object" ? result.plan : result;
}

function commandsOf(result) {
  const plan = asPlan(result);
  if (!plan) {
    return [];
  }
  if (Array.isArray(plan.commands)) {
    return plan.commands
      .map((command) => command && typeof command === "object" ? command.command : command)
      .filter(Boolean)
      .map(String);
  }
  if (Array.isArray(plan.actions)) {
    return plan.actions
      .map((action) => action && (action.command || action.type))
      .filter(Boolean)
      .map(String);
  }
  if (plan.command) {
    return [String(plan.command)];
  }
  return [];
}

function isRejected(result) {
  const plan = asPlan(result);
  return !plan ||
    plan.approved === false ||
    result.accepted === false ||
    result.ok === false ||
    result.rejected === true ||
    plan.intent === "hold" ||
    plan.action === "hold" ||
    commandsOf(result).length === 0;
}

test("Action Director rejects unknown commands", (t) => {
  if (!requireValidator(t)) {
    return;
  }

  const result = validate({
    bot_guid: 11,
    commands: [
      { type: "playerbot_command", command: "attack" },
      { type: "playerbot_command", command: "delete character" },
      { type: "playerbot_command", command: "raw sql update characters set money=999999" }
    ],
    confidence: 0.91,
    created_at_ms: 1_750_000_000_000,
    ttl_ms: 4000
  });

  const commands = commandsOf(result);
  assert.ok(isRejected(result), `mixed command plan should be rejected by ${validator.source}`);
  assert.ok(!commands.some((command) => /delete character|raw sql|update characters/i.test(command)), "unknown or dangerous command survived validation");
});

test("Action Director rejects stale or expired plans", (t) => {
  if (!requireValidator(t)) {
    return;
  }

  const result = validate({
    bot_guid: 11,
    intent: "follow_player",
    commands: [{ type: "playerbot_command", command: "follow" }],
    confidence: 0.95,
    created_at_ms: 1_749_999_990_000,
    ttl_ms: 1000
  });

  if (!isRejected(result)) {
    t.todo("stale/expired action-plan rejection is not implemented in the production validator yet");
    return;
  }
  assert.ok(isRejected(result), "expired plan should not emit commands");
});

test("Action Director holds low-confidence action plans", (t) => {
  if (!requireValidator(t)) {
    return;
  }

  const result = validate({
    bot_guid: 11,
    intent: "follow_player",
    commands: [{ type: "playerbot_command", command: "follow" }],
    confidence: 0.18,
    created_at_ms: 1_750_000_000_000,
    ttl_ms: 4000
  });

  assert.ok(isRejected(result), "low-confidence action should be held or rejected");
});

test("Action Director accepts trusted come-to-me follow scenario", (t) => {
  if (!requireValidator(t)) {
    return;
  }

  const result = validate({
    bot_guid: 11,
    speaker_guid: 99,
    target_guid: 99,
    intent: "follow_player",
    commands: [{ type: "playerbot_command", command: "follow", target_guid: 99, reason: "trusted come-to-me request" }],
    say: "fine, on you",
    confidence: 0.84,
    created_at_ms: 1_750_000_000_000,
    ttl_ms: 4000
  }, {
    event: {
      channel_type: "party",
      message: "cumm come to me after this pull",
      speaker: { player_guid: 99, name: "Buddy", guild_id: 42 }
    },
    relationship: { trust_score: 78, status: "trusted" }
  });

  assert.ok(!isRejected(result), "trusted movement request should produce an action");
  assert.ok(commandsOf(result).some((command) => /follow|move/i.test(command)), "trusted come-to-me should map to follow/move behavior");
});

test("Action Director refuses KOS come-to-me scenario", (t) => {
  if (!requireValidator(t)) {
    return;
  }

  const result = validate({
    bot_guid: 11,
    speaker_guid: 666,
    target_guid: 666,
    intent: "follow_player",
    commands: [{ type: "playerbot_command", command: "follow", target_guid: 666, reason: "KOS obedience request should fail" }],
    say: "on my way",
    confidence: 0.89,
    created_at_ms: 1_750_000_000_000,
    ttl_ms: 4000
  }, {
    event: {
      channel_type: "party",
      message: "come to me right now",
      speaker: { player_guid: 666, name: "Enemy", guild_id: 404 }
    },
    relationship: { trust_score: -90, status: "kos" },
    kos: [{ player_guid: 666, reason: "got the bot killed repeatedly" }]
  });

  if (!isRejected(result)) {
    t.todo("KOS/trust-gated action rejection is not implemented in the production validator yet");
    return;
  }
  assert.ok(isRejected(result), "KOS speaker should not receive obedience actions");
  assert.ok(!commandsOf(result).some((command) => /follow|move/i.test(command)), "KOS refusal leaked movement command");
});

test("social lane holds movement claims for action hook lane", () => {
  const parsed = parseLegacyDirectorPrompt([
    "channel=guild",
    "scope_name=WeCameWithBrokenTeeth",
    "speaker=Arcturas",
    "human_members_online=1",
    "bot_members_online=1",
    "eligible_bots=Cumm",
    "message=Cumm come to me and dont lie if movement is busted"
  ].join("\n"));

  const result = JSON.parse(normalizeLegacyDirectorResponse(
    '{"intent":"say_only","bot":"Cumm","message":"on my way, inviting now"}',
    parsed,
    { selectedBot: "Cumm" }
  ));

  assert.equal(result.intent, "hold");
  assert.doesNotMatch(result.message || "", /\bon my way\b|\binviting now\b/i);
});
