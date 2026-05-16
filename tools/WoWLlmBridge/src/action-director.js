"use strict";

const { ACTION_COMMANDS, CHANNEL_TYPES, asInt, fail, ok, randomId } = require("./memory-store");

const ALLOWED_ACTION_COMMANDS = ACTION_COMMANDS;

const ACTION_INTENTS = new Set([
  "hold",
  "say_only",
  "follow_player",
  "assist_target",
  "hold_position",
  "move_closer",
  "heal_priority",
  "avoid_combat",
  "need_help",
  "focus_target",
  "set_mark",
  "cc_target",
  "run_away",
  "trade",
  "answer_need",
  "powerlevel_request"
]);

const COMMAND_TYPES = new Set(["playerbot_command"]);

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeCommand(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeChannel(value) {
  const channel = String(value || "party").trim().toLowerCase();
  return CHANNEL_TYPES.has(channel) ? channel : "party";
}

function normalizeGuidObject(value = {}, aliases = []) {
  for (const alias of aliases) {
    const parsed = asInt(value[alias]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function pickBot(event) {
  const message = String(event.message || event.text || "").toLowerCase();
  const pickAddressedName = (names) => names.find((name) => {
    const lower = name.toLowerCase();
    return message === lower ||
      message.startsWith(`${lower} `) ||
      message.startsWith(`${lower},`) ||
      message.startsWith(`${lower}:`) ||
      message.startsWith(`yo ${lower} `) ||
      new RegExp(`\\b${lower}\\b`).test(message);
  });

  const direct = asInt(event.bot_guid) ||
    normalizeGuidObject(event.bot || {}, ["bot_guid", "guid"]) ||
    normalizeGuidObject(event.selected_bot || {}, ["bot_guid", "guid"]);
  if (direct) {
    return {
      bot_guid: direct,
      name: event.bot?.name || event.selected_bot?.name || event.bot_name || `Bot ${direct}`,
      ...event.bot
    };
  }
  const bots = Array.isArray(event.eligible_bots) ? event.eligible_bots : [];
  const selected = bots
    .filter((bot) => asInt(bot.bot_guid || bot.guid))
    .sort((a, b) => (asInt(b.tier) || 0) - (asInt(a.tier) || 0))[0];
  if (selected) {
    const botGuid = asInt(selected.bot_guid || selected.guid);
    return { ...selected, bot_guid: botGuid, name: selected.name || `Bot ${botGuid}` };
  }

  const scopedBots = Array.isArray(event.scope?.eligible_bots) ? event.scope.eligible_bots : [];
  const scopedNames = scopedBots
    .map((bot) => typeof bot === "string" ? bot : bot && bot.name)
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  const scopedName = pickAddressedName(scopedNames) || scopedNames[0];
  if (scopedName) {
    return { bot_guid: -1, name: scopedName, synthetic_group_bot: true };
  }

  if (["party", "raid"].includes(normalizeChannel(event.channel_type || event.channel))) {
    return { bot_guid: -1, name: "party-bots", synthetic_group_bot: true };
  }

  return null;
}

function pickSpeaker(event) {
  const speaker = event.speaker || event.player || {};
  const playerGuid = asInt(event.player_guid) || asInt(event.speaker_player_guid) ||
    asInt(speaker.player_guid) || asInt(speaker.guid);
  if (!playerGuid) {
    return null;
  }
  return {
    ...speaker,
    player_guid: playerGuid,
    name: speaker.name || event.player_name || event.speaker_name || `Player ${playerGuid}`
  };
}

function sanitizeSay(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function validateActionCommands(commands) {
  if (commands === undefined || commands === null) {
    return ok({ commands: [] });
  }
  if (!Array.isArray(commands)) {
    return fail("invalid_request", "commands must be an array");
  }
  if (commands.length > 5) {
    return fail("invalid_request", "commands cannot contain more than 5 entries");
  }
  const normalized = [];
  for (const command of commands) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      return fail("invalid_request", "each command must be an object");
    }
    const type = command.type || "playerbot_command";
    if (!COMMAND_TYPES.has(type)) {
      return fail("rejected_command", `command type '${type}' is not allowed`);
    }
    const commandText = normalizeCommand(command.command);
    if (!ALLOWED_ACTION_COMMANDS.has(commandText)) {
      return fail("rejected_command", `command '${command.command || ""}' is not allowed`);
    }
    normalized.push({
      type,
      command: commandText,
      target_guid: asInt(command.target_guid || command.targetGuid || command.target) || null,
      reason: String(command.reason || "").replace(/\s+/g, " ").trim().slice(0, 160)
    });
  }
  return ok({ commands: normalized });
}

function validateActionPlan(candidate = {}, event = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return fail("invalid_request", "candidate action plan must be an object");
  }
  const commandResult = validateActionCommands(candidate.commands);
  const intent = ACTION_INTENTS.has(candidate.intent) ? candidate.intent : "hold";
  const confidence = clampNumber(candidate.confidence, 0, 1, 0.5);
  const ttlMs = Math.round(clampNumber(candidate.ttl_ms ?? candidate.ttlMs, 250, 30000, 4000));
  const say = sanitizeSay(candidate.say || candidate.message || "");
  const base = {
    action_plan_id: candidate.action_plan_id || randomId("ap"),
    event_id: event.event_id || candidate.event_id || randomId("evt"),
    bot_guid: asInt(candidate.bot_guid) || asInt(event.bot_guid),
    speaker_player_guid: asInt(candidate.speaker_player_guid) || asInt(event.speaker_player_guid) || null,
    channel_type: normalizeChannel(candidate.channel_type || event.channel_type),
    bot_name: candidate.bot_name || event.bot_name || "",
    intent,
    say,
    commands: commandResult.ok ? commandResult.data.commands : [],
    confidence,
    ttl_ms: ttlMs,
    created_at: new Date().toISOString()
  };
  if (!commandResult.ok) {
    return ok({
      ...base,
      approved: false,
      rejection_reason: commandResult.error.message
    });
  }
  if (base.commands.length > 0 && confidence < 0.2) {
    return ok({
      ...base,
      approved: false,
      rejection_reason: "confidence below 0.2 for command execution"
    });
  }
  return ok({
    ...base,
    approved: true,
    rejection_reason: null
  });
}

function defaultHoldPlan(event, bot, speaker) {
  return {
    action_plan_id: randomId("ap"),
    event_id: event.event_id,
    bot_guid: bot.bot_guid,
    speaker_player_guid: speaker ? speaker.player_guid : null,
    channel_type: event.channel_type,
    intent: "hold",
    say: "",
    commands: [],
    confidence: 0.5,
    ttl_ms: 4000
  };
}

function textIncludesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function heuristicCandidatePlan(event, bot, speaker) {
  const text = String(event.message || event.text || "").toLowerCase();
  const channel = normalizeChannel(event.channel_type || event.channel);
  if (!text.trim() || !["party", "raid", "guild", "channel", "world", "say", "yell", "whisper"].includes(channel)) {
    return null;
  }

  const commands = [];
  const push = (command) => {
    if (!commands.some((entry) => entry.command === command)) {
      commands.push({
        type: "playerbot_command",
        command,
        target_guid: speaker ? speaker.player_guid : null,
        reason: "deterministic party action request"
      });
    }
  };

  if (textIncludesAny(text, [
    /\bcome\s+(to\s+)?me\b/,
    /\bget\s+(over\s+)?here\b/,
    /\bfollow\s+me\b/,
    /\bstack\s+(on\s+)?me\b/,
    /\bon\s+me\b/
  ])) {
    push("follow");
  }

  if (textIncludesAny(text, [/\bstay\b/, /\bhold\b/, /\bhold\s+position\b/, /\bdont\s+move\b/, /\bdon't\s+move\b/])) {
    push("stay");
  }

  if (textIncludesAny(text, [/\brun\b/, /\bescape\b/, /\bget\s+out\b/, /\bflee\b/, /\breset\b/])) {
    push("flee");
    push("runaway");
  }

  if (textIncludesAny(text, [/\bskull\b/, /\bkill\s+skull\b/, /\bfocus\s+skull\b/])) {
    push("rti skull");
    push("attack");
  } else if (textIncludesAny(text, [/\bcross\b/, /\bx\s+(first|next|after|dies|kill|focus)\b/, /\bkill\s+x\b/, /\bfocus\s+x\b/])) {
    push("rti cross");
    push("attack");
  }

  if (textIncludesAny(text, [/\bmoon\b/, /\bsheep\b/])) {
    push("rti cc moon");
  } else if (textIncludesAny(text, [/\bstar\b/, /\bsap\b/])) {
    push("rti cc star");
  } else if (textIncludesAny(text, [/\bdiamond\b/, /\bpurple\b/, /\bfear\b/])) {
    push("rti cc diamond");
  }

  if (textIncludesAny(text, [/\baoe\b/, /\bcleave\b/, /\bmax\s+dps\b/])) {
    push("max dps");
  }

  if (commands.length === 0) {
    return null;
  }

  return {
    action_plan_id: randomId("ap"),
    event_id: event.event_id,
    bot_guid: bot.bot_guid,
    speaker_player_guid: speaker ? speaker.player_guid : null,
    channel_type: channel,
    bot_name: bot.name,
    intent: commands.some((entry) => entry.command === "follow") ? "follow_player" : "assist_target",
    say: "",
    commands,
    confidence: 0.72,
    ttl_ms: 4000
  };
}

class ActionDirectorService {
  constructor(options) {
    this.store = options.store;
    this.logger = options.logger || (() => {});
  }

  async handleStateSnapshot(input) {
    const result = await this.store.upsertRuntimeSnapshot(input);
    return { status: result.ok ? 200 : 400, body: result };
  }

  async handleActionEvent(input) {
    const bot = pickBot(input);
    if (!bot) {
      return { status: 400, body: fail("invalid_request", "bot_guid, bot, or eligible_bots is required") };
    }
    const speaker = pickSpeaker(input);
    const eventId = input.event_id || randomId("evt");
    const channelType = normalizeChannel(input.channel_type || input.channel);
    const event = {
      ...input,
      event_id: eventId,
      bot_guid: bot.bot_guid,
      speaker_player_guid: speaker ? speaker.player_guid : null,
      channel_type: channelType,
      message: input.message || input.text || ""
    };

    await this.store.upsertRuntimeSnapshot({
      bot: bot.synthetic_group_bot ? null : bot,
      player: speaker,
      party: input.party,
      metadata: { source: "action_event_snapshot" }
    });
    await this.store.recordEvent({
      event_id: eventId,
      event_kind: "intent_in",
      channel_type: channelType,
      scope_type: input.scope_type || channelType,
      scope_id: input.scope_id || input.party_id || input.guild_id || `${channelType}:unknown`,
      bot_guid: bot.bot_guid,
      player_guid: speaker ? speaker.player_guid : null,
      guild_id: input.guild_id || bot.guild_id || speaker?.guild_id,
      party_id: input.party_id || bot.party_id,
      source: "action-director",
      direction: "in",
      text: event.message,
      intent: input.intent || null,
      payload: {
        event_kind: input.event_kind || input.event_type || "action_event",
        bot_name: bot.name,
        speaker_name: speaker ? speaker.name : null,
        party: input.party || null,
        marks: input.marks || null,
        nearby: input.nearby || null
      }
    });

    const candidate = input.candidate_plan || input.action_plan || input.plan ||
      heuristicCandidatePlan(event, bot, speaker) ||
      defaultHoldPlan(event, bot, speaker);
    const planResult = validateActionPlan(candidate, event);
    if (!planResult.ok) {
      return { status: 400, body: planResult };
    }

    const plan = {
      ...planResult.data,
      event_id: eventId,
      bot_guid: bot.bot_guid,
      bot_name: planResult.data.bot_name || bot.name,
      speaker_player_guid: speaker ? speaker.player_guid : null,
      channel_type: channelType
    };
    const saved = await this.store.recordActionPlan(plan);
    await this.store.recordEvent({
      parent_event_id: eventId,
      event_kind: "intent_out",
      channel_type: channelType,
      scope_type: input.scope_type || channelType,
      scope_id: input.scope_id || input.party_id || input.guild_id || `${channelType}:unknown`,
      bot_guid: bot.bot_guid,
      player_guid: speaker ? speaker.player_guid : null,
      guild_id: input.guild_id || bot.guild_id || speaker?.guild_id,
      party_id: input.party_id || bot.party_id,
      source: "action-director",
      direction: "out",
      text: plan.say,
      intent: plan.intent,
      success: plan.approved,
      error_code: plan.approved ? null : "rejected_action_plan",
      error_message: plan.rejection_reason,
      payload: {
        action_plan_id: plan.action_plan_id,
        commands: plan.commands,
        confidence: plan.confidence,
        ttl_ms: plan.ttl_ms
      }
    });
    this.logger("info", "action_director_plan", {
      eventId,
      actionPlanId: plan.action_plan_id,
      bot: bot.bot_guid,
      player: speaker ? speaker.player_guid : null,
      approved: plan.approved,
      commandCount: plan.commands.length,
      rejectionReason: plan.rejection_reason
    });
    return {
      status: saved.ok ? 200 : 400,
      body: saved.ok ? ok(plan) : saved
    };
  }

  async handleActionResult(input) {
    const commandResult = validateActionCommands([{ command: input.command }]);
    if (!commandResult.ok) {
      return { status: 400, body: commandResult };
    }
    const result = await this.store.recordActionResult(input);
    return { status: result.ok ? 200 : 400, body: result };
  }
}

module.exports = {
  ActionDirectorService,
  ACTION_INTENTS,
  ALLOWED_ACTION_COMMANDS,
  validateActionCommands,
  heuristicCandidatePlan,
  validateActionPlan
};
