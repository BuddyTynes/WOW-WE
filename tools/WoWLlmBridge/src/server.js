"use strict";

const http = require("node:http");
const { loadConfig } = require("./config");
const { logEvent } = require("./logger");
const { complete, flattenMessages, capPrompt, checkBackend, CircuitBreaker } = require("./provider");
const { RequestQueue } = require("./queue");
const { MemoryStore } = require("./memory-store");
const { DirectorService } = require("./director");

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded) {
    return;
  }

  res.writeHead(status, {
    "content-type": "application/json"
  });
  res.end(JSON.stringify(payload));
}

function sendOllamaText(res, body, text) {
  const payload = {
    model: body.model || body.configModel,
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: text
    },
    response: text,
    done: true
  };

  if (body.stream) {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(`${JSON.stringify(payload)}\n`);
    return;
  }

  sendJson(res, 200, payload);
}

function requestMetadata(req, body) {
  return {
    eventId: req.headers["x-event-id"] || body.event_id || body.eventId || cryptoRandomId(),
    channel: req.headers["x-wow-channel"] || body.channel || body.options && body.options.channel || "unknown",
    bot: req.headers["x-wow-bot"] || body.bot || body.bot_id || body.options && body.options.bot || null,
    player: req.headers["x-wow-player"] || body.player || body.player_id || body.options && body.options.player || null
  };
}

function parseLegacyDirectorPrompt(prompt) {
  const fields = {};
  for (const line of String(prompt || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  const bots = String(fields.eligible_bots || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 5);

  return {
    eventId: fields.event_id || "",
    eventType: fields.event_type || "chat",
    channel: fields.channel || "guild",
    scopeId: fields.scope_id || "",
    scopeName: fields.scope_name || "",
    speaker: fields.speaker || "",
    speakerGuid: Number.parseInt(fields.speaker_guid || "0", 10) || null,
    speakerLevel: Number.parseInt(fields.speaker_level || "0", 10) || null,
    speakerClass: Number.parseInt(fields.speaker_class || "0", 10) || null,
    message: fields.message || "",
    humanCount: Number.parseInt(fields.human_members_online || "0", 10) || 0,
    botCount: Number.parseInt(fields.bot_members_online || "0", 10) || bots.length,
    bots
  };
}

function isLegacyDirectorRequest(req, body, prompt) {
  const userAgent = String(req.headers["user-agent"] || "");
  return userAgent.includes("mod-llm-npc-director") ||
    body.model === "wow-llm-director" ||
    String(prompt || "").startsWith("Compact WoW chat event for the LLM NPC director.");
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function chooseLegacyBot(parsed, requested) {
  const addressed = addressedLegacyBot(parsed);
  if (addressed) {
    return addressed;
  }
  if (requested && parsed.bots.includes(requested)) {
    return requested;
  }
  if (parsed.bots.length > 1) {
    const personaBots = parsed.bots.filter((bot) => LEGACY_BOT_PERSONAS[bot.toLowerCase()]);
    const pool = personaBots.length > 0 ? personaBots : parsed.bots;
    const seed = stableLegacyId(`${parsed.eventId || ""}:${parsed.speaker || ""}:${parsed.message || ""}`);
    return pool[seed % pool.length];
  }
  return parsed.bots[0] || "";
}

function addressedLegacyBot(parsed) {
  const message = String(parsed.message || "").trim().toLowerCase();
  if (!message) {
    return "";
  }
  for (const bot of parsed.bots || []) {
    const name = bot.toLowerCase();
    if (message === name || message.startsWith(`${name},`) || message.startsWith(`${name}:`) || message.startsWith(`${name} `)) {
      return bot;
    }
  }
  return "";
}

function stableLegacyId(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 100000000 + (hash >>> 0) % 1900000000;
}

function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeEcho(message, playerMessage) {
  const reply = normalizeForCompare(message);
  const input = normalizeForCompare(playerMessage);
  return reply.length > 8 && input.length > 8 && (reply === input || reply.includes(input) || input.includes(reply));
}

function looksLikeRecentBotRepeat(message, recentChat = []) {
  const reply = normalizeForCompare(message);
  if (reply.length < 8) {
    return false;
  }
  return recentChat
    .filter((chat) => chat.direction === "out")
    .some((chat) => {
      const recent = normalizeForCompare(chat.text);
      return recent.length > 8 && (reply === recent || reply.includes(recent) || recent.includes(reply));
    });
}

function truncateChatLine(value, maxLength) {
  const text = String(value || "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) {
    return text;
  }
  const clipped = text.slice(0, maxLength + 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > Math.max(40, Math.floor(maxLength * 0.65))
    ? clipped.slice(0, lastSpace)
    : clipped.slice(0, maxLength)).trim();
}

function isMovementRequest(message) {
  return /\b(come to me|come here|get over here|teleport to me|tp to me|summon|follow me|join me)\b/i.test(message);
}

function isCorrectionOrStopRequest(message) {
  return /\b(stop|quit|drop it|shut up|dead|died|gone|forever|wrong|not true|actually)\b/i.test(message);
}

function isQuestion(message) {
  const text = String(message || "").trim();
  return text.endsWith("?") || /^(who|what|where|when|why|how|do|does|did|can|could|would|should|is|are|am)\b/i.test(text);
}

function queryAttributes(message) {
  const text = String(message || "").toLowerCase().replace(/\s+/g, " ").trim();
  const attrs = [];
  if (/\b(irl|real(?: life)?) name\b/.test(text) || (/\bname\b/.test(text) && /\birl\b/.test(text))) {
    attrs.push("irl name", "real name", "real life name", "name");
  }

  const myMatch = text.match(/\bwhat(?:'s| is| was)? my ([a-z][a-z0-9 _'-]{1,40})\b/);
  if (myMatch) {
    attrs.push(myMatch[1].trim());
  }

  const colorMatch = text.match(/\bwhat color is my ([a-z][a-z0-9 _'-]{1,40})\b/);
  if (colorMatch) {
    attrs.push(`${colorMatch[1].trim()} color`, `color of ${colorMatch[1].trim()}`);
  }

  return [...new Set(attrs.filter(Boolean))];
}

function answerFromMemories(parsed, context = {}) {
  const attrs = queryAttributes(parsed.message);
  if (attrs.length === 0) {
    return "";
  }

  const speaker = normalizeForCompare(parsed.speaker);
  for (const memory of context.memories || []) {
    const summary = String(memory.summary || "");
    const normalized = normalizeForCompare(summary);
    if (speaker && !normalized.includes(speaker)) {
      continue;
    }

    for (const attr of attrs) {
      const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const direct = summary.match(new RegExp(`\\b${escaped}\\s+is\\s+([^.!?]{1,80})`, "i"));
      if (direct) {
        return `Your ${attr} is ${direct[1].trim()}.`;
      }

      const remembered = summary.match(new RegExp(`remember that\\s+(?:my\\s+)?${escaped}\\s+is\\s+([^.!?]{1,80})`, "i"));
      if (remembered) {
        return `Your ${attr} is ${remembered[1].trim()}.`;
      }
    }
  }

  if (/\b(remember|what|who|name|color|favourite|favorite)\b/i.test(parsed.message)) {
    return "I don't know that yet.";
  }

  return "";
}

function formatRecentChat(chat) {
  const speaker = String(chat.speaker_name || chat.direction || "unknown")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  const text = String(chat.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (!text) {
    return null;
  }
  return `${speaker}: ${text}`;
}

function buildRecentContextHint(parsed, recentChat) {
  const message = String(parsed.message || "");
  const needsContext = /\b(that|this|he|she|they|them|it|above|earlier|before|previous|last|said|called|asked|reply|response|few messages)\b/i.test(message);
  if (!needsContext) {
    return "";
  }
  const botNames = new Set((parsed.bots || []).map((bot) => bot.toLowerCase()));
  const relevant = (recentChat || [])
    .filter((chat) => String(chat.text || "").trim())
    .filter((chat) => chat.direction === "out" || botNames.has(String(chat.speaker_name || "").toLowerCase()))
    .slice(-6)
    .map(formatRecentChat)
    .filter(Boolean);
  if (relevant.length === 0) {
    return "";
  }
  return `Context clues for the player's current message:\n${relevant.join("\n")}`;
}

const LEGACY_BOT_PERSONAS = {
  cumm: {
    name: "Cumm",
    temperament: "reckless instigator",
    speechStyle: "short, crude, overconfident Vanilla WoW guild chat",
    seed: "Cumm is impatient and reckless: pulls early, talks big, blames pathing, hoards junk loot, and thinks every wipe is someone else's fault. Cumm needles Zartorg constantly but still backs him up.",
    likes: ["risky pulls", "cheap shots", "making Zartorg mad", "winning arguments by being louder"],
    dislikes: ["waiting", "careful plans", "bag management", "Zartorg pretending to lead"]
  },
  zartorg: {
    name: "Zartorg",
    temperament: "dramatic tryhard tactician",
    speechStyle: "grumpy, theatrical, self-important Vanilla WoW guild chat",
    seed: "Zartorg acts like a raid leader trapped in a leveling bot: dramatic, bossy, convinced he sees the correct play, and furious when Cumm improvises. Zartorg remembers slights and turns everything into a lecture.",
    likes: ["clean pulls", "being obeyed", "calling Cumm a liability", "pretending to be strategic"],
    dislikes: ["Cumm", "random aggro", "people ignoring marks", "dying to avoidable nonsense"]
  }
};

function fallbackLegacyMessage(parsed, context = {}) {
  if (context.memoryWrite && !isQuestion(parsed.message)) {
    return { message: "Got it, I'll remember that.", reason: "memory_write" };
  }
  const memoryAnswer = answerFromMemories(parsed, context);
  if (memoryAnswer) {
    return {
      message: memoryAnswer,
      reason: memoryAnswer.includes("don't know") ? "missing_memory_answer" : "memory_answer"
    };
  }
  if (isCorrectionOrStopRequest(parsed.message)) {
    return { message: "Yeah, fair. Dropping it.", reason: "correction_or_stop" };
  }
  if (isMovementRequest(parsed.message)) {
    return { message: "I hear you. I can talk here, but movement orders still need the bot command hook.", reason: "movement_request" };
  }
  if (context.memoryWrite) {
    return { message: "Got it, I'll remember that.", reason: "memory_write" };
  }
  if (context.memoryCount > 0 && /\b(remember|what|who|where|when|why|how|favorite|favourite)\b/i.test(parsed.message)) {
    return { message: "I remember some bits, but not that answer.", reason: "memory_query_without_answer" };
  }
  return { message: "I'm here. What's the move?", reason: "generic" };
}

function normalizeLegacyDirectorResponse(text, parsed, context = {}) {
  const model = extractJsonObject(text) || {};
  const intent = typeof model.intent === "string" ? model.intent : "";
  if (parsed.humanCount < 1 || parsed.botCount < 1 || parsed.bots.length < 1) {
    return JSON.stringify({ intent: "hold" });
  }

  const deterministicMemoryAnswer = answerFromMemories(parsed, context);
  if (intent === "hold" && !context.memoryWrite && !deterministicMemoryAnswer) {
    return JSON.stringify({ intent: "hold" });
  }

  const bot = chooseLegacyBot(parsed, model.bot || model.bot_name || model.speaker);
  const maxLength = parsed.channel === "party" || parsed.channel === "raid" ? 120 : 180;
  const message = truncateChatLine(model.message || model.say || model.text || "", maxLength);
  const modelLooksWrong = Boolean(deterministicMemoryAnswer) || !message || looksLikeEcho(message, parsed.message) || looksLikeRecentBotRepeat(message, context.recentChat) ||
    (isQuestion(parsed.message) && /^(got it|i'?ll remember|yeah,? i remember)/i.test(message));
  const fallback = modelLooksWrong ? fallbackLegacyMessage(parsed, context) : null;
  const safeMessage = fallback
    ? fallback.message
    : message;
  context.normalization = {
    usedFallback: Boolean(fallback),
    fallbackReason: fallback ? fallback.reason : "",
    modelMessage: message,
    finalMessage: safeMessage
  };

  return JSON.stringify({
    intent: "say_only",
    bot,
    message: truncateChatLine(safeMessage, maxLength)
  });
}

function extractLegacyMemories(parsed) {
  const message = String(parsed.message || "").trim();
  if (isQuestion(message)) {
    return [];
  }
  const speaker = parsed.speaker || "The player";
  const patterns = [
    {
      kind: "fact",
      weight: 9,
      regex: /\bremember(?: that)? ([^.!?]{4,220})/i,
      summary: (match) => `${speaker} asked me to remember that ${match[1].trim()}.`
    },
    {
      kind: "preference",
      weight: 8,
      regex: /\bmy ([a-z][a-z0-9 _'-]{1,40}) is ([^.!?]{1,160})/i,
      summary: (match) => `${speaker}'s ${match[1].trim()} is ${match[2].trim()}.`
    },
    {
      kind: "preference",
      weight: 7,
      regex: /\bi (?:like|love|prefer) ([^.!?]{2,180})/i,
      summary: (match) => `${speaker} likes ${match[1].trim()}.`
    },
    {
      kind: "preference",
      weight: 7,
      regex: /\bi hate ([^.!?]{2,180})/i,
      summary: (match) => `${speaker} hates ${match[1].trim()}.`
    },
    {
      kind: "fact",
      weight: 6,
      regex: /\bi(?: am|'m) ([^.!?]{2,160})/i,
      summary: (match) => `${speaker} says they are ${match[1].trim()}.`
    },
    {
      kind: "instruction",
      weight: 10,
      regex: /\b([A-Z][a-zA-Z]{2,24})\s+(?:is\s+)?(?:dead|died|gone forever)\b/i,
      summary: (match) => `${speaker} corrected guild context: ${match[1].trim()} is dead or gone; stop talking as if they are present.`
    },
    {
      kind: "instruction",
      weight: 10,
      regex: /\bstop (?:bringing up|mentioning|talking about)\s+([A-Z]?[a-zA-Z]{2,24})\b/i,
      summary: (match) => `${speaker} told me to stop bringing up ${match[1].trim()}.`
    }
  ];

  return patterns
    .map((pattern) => {
      const match = message.match(pattern.regex);
      if (!match) {
        return null;
      }
      return {
        kind: pattern.kind,
        weight: pattern.weight,
        confidence: 0.82,
        summary: pattern.summary(match).replace(/\s+/g, " ").trim().replace(/^(.{1,19})$/, "$1 in game chats.")
      };
    })
    .filter((memory, index, memories) => memory && memories.findIndex((item) => item && item.summary === memory.summary) === index);
}

function extractLegacyContextMemories(parsed, recentChat) {
  const message = String(parsed.message || "").replace(/\s+/g, " ").trim();
  if (!message) {
    return [];
  }
  if (queryAttributes(message).length > 0) {
    return [];
  }

  const isCallout = /\b(that|what|thing|said|called|earlier|before|previous|agree|disagree|right|wrong|dumb|smart|funny|based|annoying|liked|hated)\b/i.test(message);
  if (!isCallout) {
    return [];
  }

  const botNames = new Set((parsed.bots || []).map((bot) => bot.toLowerCase()));
  const mentionedBots = (parsed.bots || []).filter((bot) => message.toLowerCase().includes(bot.toLowerCase()));
  const candidates = (recentChat || [])
    .filter((chat) => chat.direction === "out")
    .filter((chat) => String(chat.text || "").trim())
    .filter((chat) => {
      const speaker = String(chat.speaker_name || "").toLowerCase();
      return botNames.has(speaker) || mentionedBots.some((bot) => speaker === bot.toLowerCase());
    });
  const target = mentionedBots.length > 0
    ? candidates.reverse().find((chat) => mentionedBots.some((bot) => String(chat.speaker_name || "").toLowerCase() === bot.toLowerCase()))
    : candidates[candidates.length - 1];
  if (!target) {
    return [];
  }

  const botName = target.speaker_name || "a guild bot";
  return [{
    kind: "relationship",
    weight: 5,
    confidence: 0.72,
    summary: `${parsed.speaker || "A player"} reacted to ${botName}'s recent chat "${String(target.text).slice(0, 140)}" by saying "${message.slice(0, 140)}".`
  }];
}

function extractLegacyWorldEventMemories(parsed) {
  const eventType = String(parsed.eventType || "").toLowerCase();
  const message = String(parsed.message || "").replace(/\s+/g, " ").trim();
  if (!message || !/\b(death|died|dead|hardcore|hc)\b/i.test(`${eventType} ${message}`)) {
    return [];
  }
  return [{
    kind: "system_note",
    weight: 6,
    confidence: 0.82,
    summary: `World event observed in ${parsed.scopeName || parsed.channel}: ${message.slice(0, 220)}.`
  }];
}

function legacyScope(parsed) {
  const channel = parsed.channel === "raid" ? "party" : parsed.channel || "guild";
  if (channel === "guild" && parsed.scopeId) {
    return { scopeType: "guild", scopeId: `guild:${parsed.scopeId}`, guildId: Number.parseInt(parsed.scopeId, 10) || null, partyId: null };
  }
  if ((channel === "party" || channel === "raid") && parsed.scopeId) {
    return { scopeType: "party", scopeId: `party:${parsed.scopeId}`, guildId: null, partyId: parsed.scopeId };
  }
  if ((channel === "world" || channel === "channel") && parsed.scopeId) {
    return { scopeType: channel, scopeId: `${channel}:${parsed.scopeId}`, guildId: null, partyId: null };
  }
  return { scopeType: channel, scopeId: `${channel}:unknown`, guildId: null, partyId: null };
}

async function buildLegacyDirectorContext(store, parsed, metadata) {
  const selectedBot = chooseLegacyBot(parsed);
  const persona = LEGACY_BOT_PERSONAS[selectedBot.toLowerCase()] || null;
  const botGuid = stableLegacyId(`legacy-bot:${selectedBot.toLowerCase()}`);
  const playerGuid = parsed.speakerGuid || stableLegacyId(`legacy-player:${String(parsed.speaker).toLowerCase()}`);
  const scope = legacyScope(parsed);

  await store.upsertBotProfile({
    bot_guid: botGuid,
    bot_key: `legacy:${selectedBot.toLowerCase()}`,
    name: selectedBot,
    tier: 2,
    enabled: true,
    temperament: persona ? persona.temperament : "guildmate",
    speech_style: persona ? persona.speechStyle : "casual vanilla wow player",
    personality_seed: persona ? persona.seed : `${selectedBot} is a guild bot who remembers regular players and keeps replies brief.`,
    likes: persona ? persona.likes : [],
    dislikes: persona ? persona.dislikes : []
  });
  if (parsed.speaker) {
    await store.upsertPlayerProfile({
      player_guid: playerGuid,
      name: parsed.speaker,
      metadata: {
        level: parsed.speakerLevel,
        class: parsed.speakerClass
      }
    });
    await store.touchRelationship({ bot_guid: botGuid, player_guid: playerGuid });
  }

  await store.recordEvent({
    event_id: metadata.eventId,
    event_kind: "chat_in",
    channel_type: parsed.channel === "raid" ? "raid" : scope.scopeType,
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    bot_guid: null,
    player_guid: playerGuid,
    guild_id: scope.guildId,
    party_id: scope.partyId,
    source: "mod-llm-npc-director-legacy",
    direction: "in",
    text: parsed.message,
    payload: { speaker_name: parsed.speaker, bot_names: parsed.bots }
  });

  const recentResult = await store.getRecentChat({
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    channel_type: parsed.channel === "raid" ? "raid" : scope.scopeType,
    limit: 18
  });
  const recentChat = recentResult.ok ? recentResult.data.events : [];

  const memoryWrites = [];
  for (const memory of [...extractLegacyMemories(parsed), ...extractLegacyContextMemories(parsed, recentChat), ...extractLegacyWorldEventMemories(parsed)]) {
    const write = await store.writeMemory({
      event_id: metadata.eventId,
      bot_guid: botGuid,
      player_guid: playerGuid,
      guild_id: scope.guildId,
      party_id: scope.partyId,
      scope_type: "bot_player",
      scope_id: `bot:${botGuid}/player:${playerGuid}`,
      kind: memory.kind,
      summary: memory.summary,
      weight: memory.weight,
      confidence: memory.confidence,
      metadata: { source: "legacy-director-heuristic" }
    });
    if (write.ok) {
      memoryWrites.push(write.data.memory_id);
    }
  }

  const memoryResult = await store.searchMemories({
    bot_guid: botGuid,
    player_guid: playerGuid,
    guild_id: scope.guildId,
    party_id: scope.partyId,
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    kinds: ["relationship", "preference", "fact", "promise", "summary", "instruction"],
    limit: 8
  });

  return {
    selectedBot,
    botGuid,
    playerGuid,
    ...scope,
    memories: memoryResult.ok ? memoryResult.data.memories : [],
    recentChat,
    recentContextHint: buildRecentContextHint(parsed, recentChat),
    memoryWrites,
    memoryWrite: memoryWrites.length > 0,
    memoryCount: memoryResult.ok ? memoryResult.data.memories.length : 0,
    persona,
    guildBots: parsed.bots.filter((bot) => bot !== selectedBot)
  };
}

async function recordLegacyDirectorOutput(store, parsed, metadata, context, normalizedText, rawText, promptLength, latencyMs) {
  const action = extractJsonObject(normalizedText) || {};
  await store.recordEvent({
    parent_event_id: metadata.eventId,
    event_kind: "chat_out",
    channel_type: parsed.channel === "raid" ? "raid" : context.scopeType,
    scope_type: context.scopeType,
    scope_id: context.scopeId,
    bot_guid: context.botGuid,
    player_guid: context.playerGuid,
    guild_id: context.guildId,
    party_id: context.partyId,
    source: "wow-llm-bridge-legacy-director",
    direction: "out",
    text: action.message || "",
    intent: action.intent || "say_only",
    model: extractJsonObject(rawText),
    prompt_chars: promptLength,
    output_chars: String(rawText || "").length,
    latency_ms: latencyMs,
    payload: {
      speaker_name: context.selectedBot,
      bot_name: context.selectedBot,
      memory_write_ids: context.memoryWrites || []
    }
  });

  const text = String(action.message || "");
  for (const otherBot of context.guildBots || []) {
    if (!text.toLowerCase().includes(otherBot.toLowerCase())) {
      continue;
    }
    const otherGuid = stableLegacyId(`legacy-bot:${otherBot.toLowerCase()}`);
    const summary = `${context.selectedBot} said about ${otherBot}: "${text.slice(0, 160)}"`;
    await store.writeMemory({
      event_id: metadata.eventId,
      bot_guid: context.botGuid,
      player_guid: otherGuid,
      guild_id: context.guildId,
      party_id: context.partyId,
      scope_type: "bot_player",
      scope_id: `bot:${context.botGuid}/bot:${otherGuid}`,
      kind: "relationship",
      summary,
      weight: 4,
      confidence: 0.65,
      metadata: { source: "legacy-director-bot-bot-chat", other_bot: otherBot }
    });
  }
}

function buildLegacyDirectorPrompt(parsed, context = {}) {
  const persona = context.persona;
  const memories = (context.memories || [])
    .map((memory) => `- ${memory.summary}`)
    .join("\n") || "(none)";
  const recentChat = (context.recentChat || [])
    .map(formatRecentChat)
    .filter(Boolean)
    .join("\n") || "(none)";
  const recentContextHint = context.recentContextHint || "";

  return [
    "You are speaking as one real Vanilla WoW playerbot in a private server guild, party, or world chat.",
    "Return only minified JSON. No markdown, no analysis, no extra text.",
    "Schema: {\"intent\":\"say_only|hold\",\"bot\":\"BOT_NAME\",\"message\":\"SHORT_CHAT_LINE\"}",
    "Pick exactly one bot from the eligible bot list when responding.",
    "Sound like a casual WoW player, not an assistant. Keep it short but not one-word.",
    "Never repeat or lightly rephrase the player's exact message.",
    "Never repeat your own previous bot line from RECENT_CHAT. Recent bot lines are context, not a script.",
    "Treat RECENT_CHAT as authoritative short-term memory. Use it to understand 'that', 'he', 'what they said', and callouts from a few messages ago.",
    "If the player corrects you, says someone died/gone, or tells you to stop mentioning a topic, accept it immediately and stop using the contradicted bit.",
    "If RECENT_CHAT answers the player's question, answer from RECENT_CHAT directly. If MEMORY answers it, answer from MEMORY directly.",
    "You may form opinions and grudges from RECENT_CHAT, especially about other eligible bots.",
    "For world or hardcore death events, react like world chat: short, pointed, funny, and aimed at the dead player.",
    "Do not ask trivia questions. Do not explain rules. Do not claim you executed game commands.",
    "If the player asks you to move, teleport, follow, or come to them, say the movement command hook is not wired yet.",
    persona ? `You are ${persona.name}: ${persona.seed}` : "",
    persona ? `Your speech style: ${persona.speechStyle}.` : "",
    context.guildBots && context.guildBots.length > 0 ? `Other guild bots online: ${context.guildBots.join(", ")}. You may jab, argue with, or disagree with them by name.` : "",
    `event_type=${parsed.eventType || "chat"}`,
    `channel=${parsed.channel}`,
    `guild_or_group=${parsed.scopeName || parsed.scopeId}`,
    `speaker=${parsed.speaker}`,
    `selected_bot=${context.selectedBot || ""}`,
    `eligible_bots=${parsed.bots.join(", ")}`,
    `MEMORY:\n${memories}`,
    `RECENT_CHAT:\n${recentChat}`,
    recentContextHint,
    `message=${parsed.message}`
  ].join("\n");
}

function cryptoRandomId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createBridge(config = loadConfig()) {
  const queue = new RequestQueue(config, logEvent);
  const circuit = new CircuitBreaker(config);
  const store = new MemoryStore({ dbPath: config.memoryDbPath });
  const director = new DirectorService({ store, config, logger: logEvent });
  const startedAt = new Date();
  const memoryReady = store.ensureReady().catch((error) => {
    logEvent("error", "memory_migration_error", {
      error: error.message,
      dbPath: config.memoryDbPath
    });
  });

  async function handleCompletion(req, res) {
    const body = await readJson(req, config.maxPromptChars * 2);
    if (body && body.event_type && Array.isArray(body.eligible_bots) && body.message) {
      await memoryReady;
      const result = await director.handleEvent(body);
      sendJson(res, result.status, result.body);
      return;
    }

    body.configModel = config.model;
    const rawPrompt = req.url === "/api/chat"
      ? flattenMessages(body.messages, body.prompt)
      : String(body.prompt || "");
    const prompt = capPrompt(rawPrompt, config);
    const metadata = requestMetadata(req, body);
    const legacyDirector = isLegacyDirectorRequest(req, body, prompt)
      ? parseLegacyDirectorPrompt(prompt)
      : null;

    const task = async ({ queuedMs }) => {
      circuit.beforeRequest();
      const start = Date.now();
      try {
        let text;
        let legacyContext = null;
        if (legacyDirector) {
          await memoryReady;
          legacyContext = await buildLegacyDirectorContext(store, legacyDirector, metadata);
          const directorPrompt = capPrompt(buildLegacyDirectorPrompt(legacyDirector, legacyContext), config);
          const rawText = await complete(directorPrompt, config);
          text = normalizeLegacyDirectorResponse(rawText, legacyDirector, legacyContext);
          await recordLegacyDirectorOutput(store, legacyDirector, metadata, legacyContext, text, rawText, directorPrompt.length, Date.now() - start);
          logEvent("info", "legacy_director_debug", {
            eventId: metadata.eventId,
            channel: legacyDirector.channel,
            player: legacyDirector.speaker,
            selectedBot: legacyContext.selectedBot,
            scopeType: legacyContext.scopeType,
            scopeId: legacyContext.scopeId,
            memorySummaries: (legacyContext.memories || []).map((memory) => ({
              kind: memory.kind,
              weight: memory.weight,
              pinned: Boolean(memory.pinned),
              summary: String(memory.summary || "").slice(0, 180)
            })),
            memoryWrites: legacyContext.memoryWrites || [],
            recentChat: (legacyContext.recentChat || []).slice(-8).map((chat) => ({
              direction: chat.direction,
              speaker: chat.speaker_name || chat.direction,
              text: String(chat.text || "").slice(0, 160)
            })),
            normalization: legacyContext.normalization || {},
            rawModel: String(rawText || "").slice(0, 400),
            normalized: String(text || "").slice(0, 240)
          });
        } else {
          text = await complete(prompt, config);
        }
        circuit.recordSuccess();
        logEvent("info", "llm_complete", {
          eventId: metadata.eventId,
          channel: metadata.channel,
          bot: metadata.bot,
          player: metadata.player,
          promptChars: prompt.length,
          promptTruncated: rawPrompt.length > prompt.length,
          queuedMs,
          latencyMs: Date.now() - start,
          outputChars: text.length,
          parseStatus: text ? "ok" : "empty",
          intent: legacyDirector ? extractJsonObject(text)?.intent || null : body.intent || null,
          legacyDirector: Boolean(legacyDirector),
          memoryCount: legacyContext ? legacyContext.memoryCount : Array.isArray(body.memories) ? body.memories.length : 0,
          memoryWrites: legacyContext ? legacyContext.memoryWrites.length : 0
        });
        return text;
      } catch (error) {
        circuit.recordFailure(error);
        logEvent("error", "llm_error", {
          eventId: metadata.eventId,
          channel: metadata.channel,
          bot: metadata.bot,
          player: metadata.player,
          promptChars: prompt.length,
          queuedMs,
          latencyMs: Date.now() - start,
          error: error.message,
          code: error.code || null
        });
        throw error;
      }
    };

    const text = await queue.enqueue(metadata, task);
    sendOllamaText(res, body, text);
  }

  async function handleMemoryApi(req, res, toolName) {
    await memoryReady;
    const body = await readJson(req, 128 * 1024);
    const tools = {
      get_bot_profile: (input) => store.getBotProfile(input),
      get_player_profile: (input) => store.getPlayerProfile(input),
      upsert_player_profile: (input) => store.upsertPlayerProfile(input),
      get_relationship: (input) => store.getRelationship(input),
      search_memories: (input) => store.searchMemories(input),
      write_memory: (input) => store.writeMemory(input),
      record_event: (input) => store.recordEvent(input),
      get_recent_chat: (input) => store.getRecentChat(input),
      write_conversation_summary: (input) => store.writeConversationSummary(input)
    };
    if (!tools[toolName]) {
      sendJson(res, 404, { ok: false, error: { code: "not_found", message: "tool not found" }, data: null });
      return;
    }
    if (toolName === "write_memory") {
      const caller = req.headers["x-wow-caller"] || body.caller;
      if (!["bridge", "admin", "debug"].includes(caller)) {
        sendJson(res, 403, {
          ok: false,
          error: { code: "forbidden", message: "write_memory requires bridge, admin, or debug caller" },
          data: null
        });
        return;
      }
    }
    const result = await tools[toolName](body);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api/version")) {
      sendJson(res, 200, { version: "wow-llm-bridge-0.2.0" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      let backend = { checked: false };
      if (url.searchParams.get("probe") === "1") {
        backend = await checkBackend(config).catch((error) => ({
          ok: false,
          checked: true,
          error: error.message,
          code: error.code || null
        }));
      }

      const memoryHealth = store.health();
      sendJson(res, circuit.isOpen() || !memoryHealth.ok ? 503 : 200, {
        ok: !circuit.isOpen() && store.health().ok,
        provider: config.provider,
        model: config.model,
        hasApiKey: Boolean(config.apiKey),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        queue: queue.stats(),
        circuit: circuit.stats(),
        backend,
        memory: {
          ...memoryHealth,
          counts: memoryHealth.ok ? await store.getCounts().catch(() => null) : null
        },
        caps: {
          timeoutMs: config.timeoutMs,
          maxPromptChars: config.maxPromptChars,
          maxTokens: config.maxTokens,
          maxOutputChars: config.maxOutputChars,
          maxQueueAgeMs: config.maxQueueAgeMs
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tags") {
      sendJson(res, 200, {
        models: [
          {
            name: config.model,
            model: config.model,
            modified_at: new Date().toISOString(),
            size: 1,
            digest: "hosted-api"
          }
        ]
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/api/generate")) {
      await handleCompletion(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/director/event") {
      await memoryReady;
      const body = await readJson(req, 128 * 1024);
      const result = await director.handleEvent(body);
      sendJson(res, result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/bot-guild-invite/decision") {
      await memoryReady;
      const body = await readJson(req, 128 * 1024);
      const result = await store.decideBotGuildInvite(body);
      sendJson(res, result.ok ? 200 : 400, result.ok ? result.data : result);
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/memory/")) {
      await handleMemoryApi(req, res, url.pathname.slice("/api/memory/".length));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      const status = error.code === "QUEUE_FULL" || error.code === "STALE_REQUEST" ? 503 : 500;
      sendJson(res, status, {
        error: error.message || "unknown error",
        code: error.code || null
      });
    });
  });

  return { server, queue, circuit, config, store, director };
}

function start(config = loadConfig()) {
  const bridge = createBridge(config);
  bridge.server.listen(config.port, () => {
    logEvent("info", "bridge_listen", {
      url: `http://localhost:${config.port}`,
      provider: config.provider,
      model: config.model,
      maxConcurrent: config.maxConcurrent,
      maxQueueSize: config.maxQueueSize,
      timeoutMs: config.timeoutMs
    });
  });
  return bridge;
}

if (require.main === module) {
  start();
}

module.exports = {
  createBridge,
  start,
  parseLegacyDirectorPrompt,
  normalizeLegacyDirectorResponse,
  buildLegacyDirectorPrompt,
  extractLegacyMemories,
  extractLegacyContextMemories,
  extractLegacyWorldEventMemories,
  buildLegacyDirectorContext,
  stableLegacyId
};
