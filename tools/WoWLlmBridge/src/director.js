"use strict";

const { complete, capPrompt } = require("./provider");
const { INTENTS, asInt, randomId } = require("./memory-store");

const TARGET_INTENTS = new Set(["follow_leader", "assist_target", "move_closer", "heal_priority"]);

function parseModelJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function selectBot(event) {
  const bots = Array.isArray(event.eligible_bots) ? event.eligible_bots : [];
  return bots
    .filter((bot) => asInt(bot.bot_guid))
    .sort((a, b) => (asInt(b.tier) || 0) - (asInt(a.tier) || 0))[0] || null;
}

function defaultScope(event) {
  const scopeType = event.scope_type || event.channel_type || "system";
  if (event.scope_id) {
    return { scope_type: scopeType, scope_id: event.scope_id };
  }
  if (scopeType === "guild" && event.guild_id) {
    return { scope_type: "guild", scope_id: `guild:${event.guild_id}` };
  }
  if (scopeType === "party" && event.party_id) {
    return { scope_type: "party", scope_id: `party:${event.party_id}` };
  }
  return { scope_type: scopeType, scope_id: `${scopeType}:unknown` };
}

function validateDirectorResponse(model, event, selectedBot) {
  const channel = event.channel_type === "party" ? "party" : "guild";
  const maxSay = channel === "party" ? 120 : 180;
  let intent = typeof model.intent === "string" && INTENTS.has(model.intent) ? model.intent : "say_only";
  let targetGuid = asInt(model.target_guid || model.target || model.targetGuid);
  if (TARGET_INTENTS.has(intent) && !targetGuid) {
    intent = "say_only";
    targetGuid = null;
  }
  if (!TARGET_INTENTS.has(intent)) {
    targetGuid = null;
  }
  const say = String(model.say || model.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxSay);

  return {
    bot_guid: asInt(model.bot_guid) || asInt(selectedBot.bot_guid),
    channel_type: channel,
    say: say || (channel === "party" ? "On you." : "I'm in."),
    intent,
    target_guid: targetGuid,
    confidence: Math.min(1, Math.max(0, Number.parseFloat(model.confidence) || 0.5)),
    memory_update: model.memory_update && typeof model.memory_update === "object" ? model.memory_update : null
  };
}

function validateMemoryUpdate(update) {
  if (!update || update.write === false) {
    return null;
  }
  const summary = String(update.summary || "").trim();
  return {
    kind: update.kind || "summary",
    summary,
    weight: update.weight === undefined ? 5 : update.weight,
    confidence: update.confidence === undefined ? 0.7 : update.confidence,
    pinned: Boolean(update.pinned),
    expires_at: update.expires_at || null,
    metadata: update.metadata || {}
  };
}

function buildPrompt({ event, bot, player, relationship, memories, recentChat }) {
  const memoryLines = memories.map((memory) => `- [${memory.kind} w${memory.weight}] ${memory.summary}`).join("\n");
  const chatLines = recentChat.map((chat) => `${chat.speaker_name || chat.direction}: ${chat.text}`).join("\n");
  const payload = {
    contract: {
      bot_guid: bot.bot_guid,
      say: "string",
      intent: "say_only|follow_leader|assist_target|hold_position|move_closer|heal_priority|avoid_combat|need_help",
      target_guid: null,
      confidence: 0.0,
      memory_update: { write: false, kind: "summary", summary: "", weight: 5, confidence: 0.7 }
    },
    event: {
      channel_type: event.channel_type,
      message: event.message,
      speaker: event.speaker,
      context: event.context || {}
    },
    bot,
    player,
    relationship,
    memories: memoryLines || "(none)",
    recent_chat: chatLines || "(none)"
  };
  return [
    "You are selecting and speaking for one WoW NPC bot.",
    "Return only strict JSON matching the contract. No markdown.",
    "Keep guild say under 180 chars and party say under 120 chars.",
    "Only write memory for durable facts/preferences/promises worth remembering.",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

class DirectorService {
  constructor(options) {
    this.store = options.store;
    this.config = options.config;
    this.logger = options.logger;
    this.complete = options.complete || complete;
  }

  async handleEvent(event) {
    const started = Date.now();
    const eventId = event.event_id || randomId("evt");
    const channel = event.channel_type === "party" ? "party" : "guild";
    const scope = defaultScope({ ...event, channel_type: channel });
    const selectedBot = selectBot(event);
    if (!selectedBot) {
      return { status: 400, body: { error: "no eligible bot", code: "NO_ELIGIBLE_BOT" } };
    }

    const botGuid = asInt(selectedBot.bot_guid);
    const speaker = event.speaker || {};
    const playerGuid = asInt(speaker.player_guid);
    let toolCalls = 0;
    const maxTools = this.config.maxToolCallsPerEvent || 6;
    const toolStart = Date.now();
    const canCall = () => toolCalls < maxTools && Date.now() - toolStart < (this.config.maxToolTimeMs || 2500);
    const call = async (name, fn) => {
      if (!canCall()) {
        return null;
      }
      toolCalls++;
      return await fn();
    };

    await call("upsert_bot", () => this.store.upsertBotProfile({
      ...selectedBot,
      enabled: true,
      bot_key: selectedBot.bot_key || `bot-${botGuid}`
    }));
    if (playerGuid && speaker.name) {
      await call("upsert_player", () => this.store.upsertPlayerProfile({
        player_guid: playerGuid,
        account_id: speaker.account_id,
        name: speaker.name,
        metadata: speaker.metadata || {}
      }));
    }
    await call("record_in", () => this.store.recordEvent({
      event_id: eventId,
      event_kind: "chat_in",
      channel_type: channel,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      bot_guid: null,
      player_guid: playerGuid,
      guild_id: event.guild_id,
      party_id: event.party_id,
      source: "mod-llm-npc-director",
      direction: "in",
      text: event.message,
      payload: { speaker_name: speaker.name, event_type: event.event_type }
    }));
    const relationship = playerGuid
      ? await call("relationship", () => this.store.touchRelationship({ bot_guid: botGuid, player_guid: playerGuid }))
      : null;
    const memoryResult = await call("search_memories", () => this.store.searchMemories({
      bot_guid: botGuid,
      player_guid: playerGuid,
      guild_id: event.guild_id,
      party_id: event.party_id,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      kinds: ["relationship", "preference", "fact", "promise", "summary"],
      limit: channel === "party" ? 6 : 4
    }));
    const recentResult = await call("recent_chat", () => this.store.getRecentChat({
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      channel_type: channel,
      limit: 12
    }));

    const botProfile = await this.store.getBotProfile({ bot_guid: botGuid });
    const playerProfile = playerGuid ? await this.store.getPlayerProfile({ player_guid: playerGuid }) : null;
    const memories = memoryResult && memoryResult.ok ? memoryResult.data.memories : [];
    const recentChat = recentResult && recentResult.ok ? recentResult.data.events : [];
    const prompt = capPrompt(buildPrompt({
      event: { ...event, channel_type: channel },
      bot: botProfile.ok ? botProfile.data : selectedBot,
      player: playerProfile && playerProfile.ok ? playerProfile.data : null,
      relationship: relationship && relationship.ok ? relationship.data : null,
      memories,
      recentChat
    }), this.config);

    const raw = await this.complete(prompt, this.config);
    const validated = validateDirectorResponse(parseModelJson(raw), { ...event, channel_type: channel }, selectedBot);
    const memoryWriteIds = [];
    const memoryUpdate = validateMemoryUpdate(validated.memory_update);
    if (memoryUpdate) {
      const write = await this.store.writeMemory({
        event_id: eventId,
        bot_guid: botGuid,
        player_guid: playerGuid,
        guild_id: event.guild_id,
        party_id: event.party_id,
        scope_type: playerGuid ? "bot_player" : scope.scope_type,
        scope_id: playerGuid ? `bot:${botGuid}/player:${playerGuid}` : scope.scope_id,
        ...memoryUpdate
      });
      if (write.ok) {
        memoryWriteIds.push(write.data.memory_id);
      }
    }

    const latencyMs = Date.now() - started;
    await this.store.recordEvent({
      parent_event_id: eventId,
      event_kind: "chat_out",
      channel_type: channel,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      bot_guid: botGuid,
      player_guid: playerGuid,
      guild_id: event.guild_id,
      party_id: event.party_id,
      source: "wow-llm-bridge",
      direction: "out",
      text: validated.say,
      intent: validated.intent,
      model: parseModelJson(raw),
      prompt_chars: prompt.length,
      output_chars: raw.length,
      latency_ms: latencyMs,
      payload: { memory_write_ids: memoryWriteIds }
    });
    const counts = await this.store.getCounts().catch(() => null);
    this.logger("info", "director_response", {
      eventId,
      channel,
      bot: botGuid,
      player: playerGuid,
      memoryCount: memories.length,
      memoryWrites: memoryWriteIds.length,
      toolCalls,
      latencyMs,
      counts
    });

    return {
      status: 200,
      body: {
        event_id: eventId,
        bot_guid: botGuid,
        channel_type: channel,
        say: validated.say,
        intent: validated.intent,
        target_guid: validated.target_guid,
        confidence: validated.confidence,
        memory_write_ids: memoryWriteIds,
        debug: {
          memory_count: memories.length,
          prompt_chars: prompt.length,
          latency_ms: latencyMs
        }
      }
    };
  }
}

module.exports = {
  DirectorService,
  parseModelJson,
  validateDirectorResponse,
  selectBot,
  buildPrompt
};
