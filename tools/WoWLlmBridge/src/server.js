"use strict";

const http = require("node:http");
const { loadConfig } = require("./config");
const { logEvent } = require("./logger");
const { complete, flattenMessages, capPrompt, checkBackend, CircuitBreaker, requiresApiKey } = require("./provider");
const { RequestQueue } = require("./queue");
const { MemoryStore } = require("./memory-store");
const { DirectorService } = require("./director");
const { ActionDirectorService } = require("./action-director");

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
    deathCharacter: fields.death_character || "",
    deathCause: fields.death_cause || "",
    deathLocation: fields.death_location || "",
    deathLevel: Number.parseInt(fields.death_level || "0", 10) || null,
    deathFaction: fields.death_faction || "",
    deathGuild: fields.death_guild || "",
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
      const chatLine = raw.match(/^([A-Za-z][A-Za-z0-9 _'-]{1,31})\s*:\s*([^\r\n]{2,240})$/);
      if (chatLine) {
        return {
          intent: "say_only",
          bot: chatLine[1].trim(),
          message: chatLine[2].trim()
        };
      }
      if (!/[\r\n]/.test(raw) && raw.length >= 2 && raw.length <= 240 && !/^(schema|return only|analysis|reasoning|tool_call)\b/i.test(raw)) {
        return {
          intent: "say_only",
          message: raw
        };
      }
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
    const aliases = [bot.toLowerCase()];
    if (bot.toLowerCase() === "zartorg") {
      aliases.push("zar");
    }
    for (const name of aliases) {
      const addressedAtStart = message === name || message.startsWith(`${name},`) || message.startsWith(`${name}:`) || message.startsWith(`${name} `) || message.startsWith(`yo ${name} `);
      if (addressedAtStart) {
        return bot;
      }
    }
  }
  for (const bot of parsed.bots || []) {
    const aliases = [bot.toLowerCase()];
    if (bot.toLowerCase() === "zartorg") {
      aliases.push("zar");
    }
    for (const name of aliases) {
      const commandMention = new RegExp(`\\b${name}\\b.*\\b(call|answer|tell|come|move|help|remember|sheep|sap|fear|mark|run|commit)\\b|\\b(call|answer|tell|come|move|help|remember|sheep|sap|fear|mark|run|commit)\\b.*\\b${name}\\b`, "i").test(message);
      if (commandMention) {
        return bot;
      }
    }
  }
  return "";
}

function hasMarkOrTacticalCall(text) {
  const value = String(text || "");
  return /\b(skull|moon|star|diamond|purple|sheep|sap|fear|runner|caster|mark|cc|commit)\b|\bx\b(?![a-z])|\b(kill|focus)\s+(skull|x|moon|star|diamond|purple|runner|caster)\b|\b(skull|x|moon|star|diamond|purple|runner|caster)\s+(first|second|next|after|dies|kill|focus)\b|\brun\s+(out|away|back|now)\b/i.test(value);
}

function asksAboutRecentCall(text) {
  return /\b(who|what|which|after|next|said|called|marked|kill|sheep|sap|fear|run|commit)\b/i.test(String(text || ""));
}

function isRelevantRecentContext(parsed, chat) {
  const text = String(chat.text || "");
  if (!text.trim()) {
    return false;
  }
  if (hasMarkOrTacticalCall(text) && asksAboutRecentCall(parsed.message)) {
    return true;
  }
  if (chat.direction === "out") {
    return true;
  }
  const botNames = new Set((parsed.bots || []).map((bot) => bot.toLowerCase()));
  return botNames.has(String(chat.speaker_name || "").toLowerCase());
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
  const stopwords = new Set(["the", "then", "you", "got", "don", "dont", "not", "that", "what", "who", "said", "also", "are", "was", "were", "for", "and"]);
  const contentTokens = (text) => new Set(text.split(" ").filter((token) => token.length > 2 && !stopwords.has(token)));
  const contentWords = (text) => text.split(" ").filter((token) => token.length > 2 && !stopwords.has(token));
  const ngrams = (text, size) => {
    const words = contentWords(text);
    const out = new Set();
    for (let index = 0; index <= words.length - size; index++) {
      out.add(words.slice(index, index + size).join(" "));
    }
    return out;
  };
  const replyTokens = contentTokens(reply);
  const replyPhrases = ngrams(reply, 4);
  return recentChat
    .filter((chat) => chat.direction === "out")
    .some((chat) => {
      const recent = normalizeForCompare(chat.text);
      if (recent.length <= 8 || reply === recent || reply.includes(recent) || recent.includes(reply)) {
        return recent.length > 8;
      }
      const recentPhrases = ngrams(recent, 4);
      for (const phrase of replyPhrases) {
        if (recentPhrases.has(phrase)) {
          return true;
        }
      }
      const recentTokens = contentTokens(recent);
      if (replyTokens.size < 3 || recentTokens.size < 3) {
        return false;
      }
      let overlap = 0;
      for (const token of replyTokens) {
        if (recentTokens.has(token)) {
          overlap++;
        }
      }
      return overlap / Math.min(replyTokens.size, recentTokens.size) >= 0.68;
    });
}

function truncateChatLine(value, maxLength) {
  const text = String(value || "")
    .replace(/\u00e2\u0080\u00a6/g, "...")
    .replace(/\u2026/g, "...")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[*_`~]/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) {
    return text;
  }
  const clipped = text.slice(0, maxLength + 1);
  const punctuation = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("!"), clipped.lastIndexOf("?"));
  if (punctuation > Math.max(45, Math.floor(maxLength * 0.45))) {
    return clipped.slice(0, punctuation + 1).trim();
  }
  const lastSpace = clipped.lastIndexOf(" ");
  const out = (lastSpace > Math.max(40, Math.floor(maxLength * 0.65))
    ? clipped.slice(0, lastSpace)
    : clipped.slice(0, maxLength)).trim();
  return out.replace(/\b(and|but|or|to|not|don'?t|with|about|some|the|a)$/i, "").trim();
}

function isMovementRequest(message) {
  return /\b(come to me|come here|get over here|teleport to me|tp to me|summon|follow me|join me)\b/i.test(message);
}

function isCorrectionOrStopRequest(message) {
  return /\b(stop|quit|drop it|shut up|dead|died|gone|forever|wrong|not true|actually)\b/i.test(message);
}

function isQuestion(message) {
  const text = String(message || "").trim();
  return text.endsWith("?") ||
    /^(who|what|where|when|why|how|do|does|did|can|could|would|should|is|are|am)\b/i.test(text) ||
    /\b(who|what|where|when|why|how)\b.{0,80}\b(was|is|did|do|said|called|asked|kill|sheep|sap|order|dinner|snack|name)\b/i.test(text);
}

function isExplicitRememberRequest(message) {
  return /\bremember(?:\s+that)?\b/i.test(String(message || ""));
}

function looksLikeMemoryAck(message) {
  return /^(got it|i'?ll remember|i will remember|yeah,? i remember|noted|saved that|remembered)\b/i.test(String(message || "").trim());
}

function looksLikeTacticalDodge(message, parsed, context = {}) {
  if (!context.tacticalAnswer) {
    return false;
  }
  const reply = normalizeForCompare(message);
  if (!reply) {
    return true;
  }
  if (/\b(you call|what s the call|what is the call|marks are unreliable|not swapping|tunnel is ridiculous)\b/i.test(message)) {
    return true;
  }
  const answer = normalizeForCompare(context.tacticalAnswer);
  const needsX = answer.includes(" x ") || answer.startsWith("x ");
  const needsSkull = answer.includes("skull");
  const needsMoon = answer.includes("moon");
  const needsPurple = answer.includes("purple") || answer.includes("fear");
  if (needsX && !/\bx\b|healer/.test(reply)) {
    return true;
  }
  if (needsSkull && !reply.includes("skull")) {
    return true;
  }
  if (needsMoon && !/moon|sheep/.test(reply)) {
    return true;
  }
  if (needsPurple && !/purple|fear/.test(reply)) {
    return true;
  }
  return false;
}

function looksLikeBanterDodge(message, parsed) {
  const playerMessage = String(parsed.message || "");
  if (!/\b(sticky|sushi|posture|wet cardboard|sippy|juice box|training wheels|trash|clown|keyboard|desk|argues|specimen|loses arguments|microwave|beeps|fire back|swing back|swing harder|insult|make this stupid|quit being polite|too clean|hr approved|start swinging|swing like idiots)\b/i.test(playerMessage)) {
    return false;
  }
  return /\b(you'?re still on that|you'?re right|focus on the raid|focus on the pull|maintain order|sense of humor|just sayin|just saying|be polite|bunch of toddlers|just pull,? or don'?t|not that hard|get this show on the road|spontaneously combust|see if you can actually swing back|not impressed|embarrassing the guild|juvenile antics|actual strategy|excuse me,? i have actual strategy|hr approved|get yourself a ban|going to get yourself a ban|don'?t be rude)\b/i.test(String(message || ""));
}

function isOneUsefulRequest(text) {
  return /\b(one useful|useful thing|useful line|one line)\b/i.test(String(text || ""));
}

function isShortAnswerRequest(text) {
  return /\b(no lecture|no packet|packet dump|ted talk|don'?t recap|dont recap|dump the whole|whole bible|whole textbook|textbook|only|just answer|that slice|that part|one thing|one line|short version)\b/i.test(String(text || ""));
}

function looksLikeOverusedOpening(message, recentChat = [], selectedBot = "") {
  const opening = String(message || "").trim().match(/^([A-Za-z']+)/);
  if (!opening) {
    return false;
  }
  const word = opening[1].toLowerCase();
  if (!["seriously", "honestly"].includes(word)) {
    return false;
  }
  return (recentChat || [])
    .filter((chat) => chat.direction === "out")
    .filter((chat) => !selectedBot || String(chat.speaker_name || "").toLowerCase() === String(selectedBot).toLowerCase())
    .some((chat) => String(chat.text || "").trim().toLowerCase().startsWith(`${word}`));
}

function looksLikeLazyOpening(message) {
  return /^(seriously|honestly)[?,.!]?\s/i.test(String(message || "").trim());
}

function stripLazyOpening(message) {
  const raw = String(message || "").trim();
  const stripped = raw.replace(/^(seriously|honestly)[?,.!]?\s+/i, "").trim();
  if (stripped === raw) {
    return raw;
  }
  if (!stripped) {
    return stripped;
  }
  return stripped[0].toUpperCase() + stripped.slice(1);
}

function looksIncompleteOrTruncated(message, maxLength) {
  const text = String(message || "").trim();
  if (/\b(a|an|the|and|but|or|to|with|about|of|for|in|on|clean|proper|total|complete)$/i.test(text)) {
    return true;
  }
  if (text.length < Math.floor(maxLength * 0.82)) {
    return false;
  }
  if (/[.!?]"?$/.test(text)) {
    return false;
  }
  return true;
}

function isTransientMemoryText(text) {
  return /\b(now|right now|today|tonight|this pull|next pull|that pull|this mob|that mob|target|skull|x target|moon|star|low health|oom|out of mana|cooldown|cd|bag full|inventory|vendor|repair|summon|portal|teleport|tp|follow|come here|come to me|where are you)\b/i.test(String(text || ""));
}

function isDurableAttribute(attribute) {
  const attr = normalizeForCompare(attribute);
  if (!attr) {
    return false;
  }
  return /\b(irl name|real name|real life name|name|favorite|favourite|birthday|pronoun|timezone|time zone|schedule|sleep schedule|main|alt|class|spec|profession|discord|battle tag|battletag|nickname|guild role|snack|food|drink|order|taco order|gas station snack|dinner)\b/.test(attr);
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

  if (/\bwhat\b.*\bsnack\b/.test(text)) {
    attrs.push("snack", "gas station snack", "favorite snack");
  }
  if (/\bwhat\b.*\border\b/.test(text)) {
    attrs.push("order", "taco order", "food order");
  }
  if (/\bwhat\b.*\b(dinner|eat|eating|food)\b/.test(text)) {
    attrs.push("dinner", "food", "snack");
  }
  if (/\bwhat\b.*\b(sleep schedule|schedule)\b/.test(text) || /\bsleep schedule\b/.test(text)) {
    attrs.push("sleep schedule", "schedule");
  }

  return [...new Set(attrs.filter(Boolean))];
}

function answerFromMemories(parsed, context = {}) {
  if (!isQuestion(parsed.message)) {
    return "";
  }
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

      const snackOrder = summary.match(new RegExp(`\\b${escaped}\\s+(?:is|was)\\s+([^.!?]{1,100})`, "i"));
      if (snackOrder) {
        return `Your ${attr} is ${snackOrder[1].trim()}.`;
      }
    }
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

function formatSpiceLine(line) {
  if (!line || !line.message) {
    return "";
  }
  const mode = line.allow_exact ? "copy-ok" : "style-only";
  const speaker = line.speaker ? `${line.speaker}: ` : "";
  return `- [${line.channel_type}/${mode}] ${speaker}${line.message}`;
}

function buildRecentContextHint(parsed, recentChat) {
  const message = String(parsed.message || "");
  const broadContext = /\b(did you hear|did you catch|who said|what was|actual choice|choice again|confession|flex)\b/i.test(message);
  const needsContext = broadContext || /\b(that|this|he|she|they|them|it|above|earlier|before|previous|last|said|called|asked|reply|response|few messages|skull|x|moon|star|diamond|sheep|sap|fear|runner|caster|kill|after|next|run|commit)\b/i.test(message);
  if (!needsContext) {
    return "";
  }
  const relevant = (recentChat || [])
    .filter((chat) => String(chat.text || "").trim())
    .filter((chat) => broadContext || isRelevantRecentContext(parsed, chat))
    .slice(-8)
    .map(formatRecentChat)
    .filter(Boolean);
  if (relevant.length === 0) {
    return "";
  }
  return `Context clues for the player's current message:\n${relevant.join("\n")}`;
}

function recentAnswerFromContext(parsed, recentChat) {
  const message = String(parsed.message || "");
  const asksUseful = isOneUsefulRequest(message);
  if (!asksUseful && !/\b(did you hear|did you catch|who said|what was|actual choice|choice again|what were|two options|options|confession|flex|recap|disaster|disasters|juggling)\b/i.test(message)) {
    return "";
  }
  if (asksUseful) {
    const contextLines = [
      ...(recentChat || [])
        .filter((chat) => chat.direction === "in")
        .filter((chat) => String(chat.text || "").trim())
        .filter((chat) => normalizeForCompare(chat.text) !== normalizeForCompare(message))
        .slice(-4)
        .map((chat) => String(chat.text || "")),
      message
    ].join(" ");
    if (/\bquest item|quest items|sell something important|vendor something important|something important\b/i.test(contextLines)) {
      return "Do not sell anything important; dump gray junk first and check anything with quest text.";
    }
    if (/\bmouse|double click|clicks\b/i.test(contextLines)) {
      return "The mouse is double-clicking; swap it or raise debounce before blaming the game.";
    }
    if (/\bbag|bags|inventory|vendor\b/i.test(contextLines)) {
      return "Bags are full; vendor gray junk before the next pull.";
    }
    if (/\blag|router|ping\b/i.test(contextLines)) {
      return "Lag or router is the suspect; restart the router or stop queueing risky pulls.";
    }
    if (/\bpathing|runner|ran away|runback\b/i.test(contextLines)) {
      return "Pathing is the problem; slow the pull and finish runners before they leave.";
    }
  }
  if (/\b(recap|disaster|disasters|juggling)\b/i.test(message)) {
    const ownLines = (recentChat || [])
      .filter((chat) => chat.direction === "in")
      .filter((chat) => String(chat.speaker_name || "") === parsed.speaker)
      .filter((chat) => normalizeForCompare(chat.text) !== normalizeForCompare(message))
      .slice(-2)
      .map((chat) => String(chat.text || "").replace(/\s+/g, " ").trim());
    const otherLines = (recentChat || [])
      .filter((chat) => chat.direction === "in")
      .filter((chat) => String(chat.text || "").trim())
      .filter((chat) => String(chat.speaker_name || "") !== parsed.speaker)
      .slice(-3)
      .map((chat) => `${chat.speaker_name || "someone"} said ${String(chat.text || "").replace(/\s+/g, " ").trim()}`);
    const summary = [...ownLines, ...otherLines].filter(Boolean).join("; ");
    return summary ? `${summary}. Answer that recent detail first.` : "";
  }
  const botNames = new Set((parsed.bots || []).map((bot) => bot.toLowerCase()));
  const queryTokens = [...contentTokenSet(message)]
    .filter((token) => !botNames.has(token) && !["hear", "catch", "said", "what", "was", "actual", "choice", "again", "confession", "flex"].includes(token));
  const candidates = (recentChat || [])
    .filter((chat) => chat.direction === "in")
    .filter((chat) => String(chat.text || "").trim())
    .filter((chat) => normalizeForCompare(chat.text) !== normalizeForCompare(message));
  if (/\bmy\b/i.test(message)) {
    const ownCandidates = candidates.filter((chat) => String(chat.speaker_name || "") === parsed.speaker);
    let ownBest = null;
    let ownScore = 0;
    for (const chat of ownCandidates) {
      const tokens = contentTokenSet(chat.text);
      let score = 0;
      for (const token of queryTokens) {
        if (tokens.has(token)) {
          score++;
        }
      }
      if (score > ownScore) {
        ownBest = chat;
        ownScore = score;
      }
    }
    if (ownBest && ownScore > 0) {
      const text = String(ownBest.text || "").replace(/\s+/g, " ").trim();
      return `${parsed.speaker} said "${text.slice(0, 180)}". Answer that recent detail first.`;
    }
  }
  let best = null;
  let bestScore = 0;
  for (const chat of candidates) {
    const text = String(chat.text || "");
    const tokens = contentTokenSet(text);
    let score = 0;
    for (const token of queryTokens) {
      if (tokens.has(token)) {
        score++;
      }
    }
    if (score > bestScore) {
      best = chat;
      bestScore = score;
    }
  }
  if (!best || bestScore === 0) {
    return "";
  }
  const speaker = best.speaker_name || "someone";
  const text = String(best.text || "").replace(/\s+/g, " ").trim();
  const choice = text.match(/\bshould i\s+(.{3,90}?)\s+or\s+(.{3,90})(?:[?.!]|$)/i);
  if (choice) {
    return `${speaker} asked whether to ${choice[1].trim()} or ${choice[2].trim()}. Answer that recent detail first.`;
  }
  return `${speaker} said "${text.slice(0, 180)}". Answer that recent detail first.`;
}

function buildTacticalContext(parsed, recentChat) {
  if (isMovementRequest(parsed.message)) {
    return "";
  }
  const current = String(parsed.message || "");
  const lines = [
    ...((recentChat || [])
      .filter((chat) => hasMarkOrTacticalCall(chat.text))
      .slice(-5)
      .map(formatRecentChat)
      .filter(Boolean)),
    `${parsed.speaker || "speaker"}: ${current}`
  ].filter((line) => hasMarkOrTacticalCall(line));
  if (lines.length === 0) {
    return "";
  }
  return `TACTICAL_CONTEXT:\n${lines.join("\n")}\nIf skull and x are kill targets, skull is first and x is usually after skull. Moon/star/diamond with sheep/sap/fear are crowd control unless the player says otherwise.`;
}

function tacticalAnswerFromContext(parsed, recentChat) {
  const message = String(parsed.message || "");
  if (isMovementRequest(message)) {
    return "";
  }
  const asksTacticalFromRecent = /\b(kill|sheep|sap|fear|skull|x|moon|star|diamond|purple|freecast|called|said)\b/i.test(message);
  if (!hasMarkOrTacticalCall(message) && !asksTacticalFromRecent) {
    return "";
  }
  const tacticalLines = [
    ...((recentChat || [])
      .filter((chat) => hasMarkOrTacticalCall(chat.text))
      .slice(-6)
      .map(formatRecentChat)
      .filter(Boolean)),
    `${parsed.speaker || "speaker"}: ${message}`
  ].join("\n");
  const lower = tacticalLines.toLowerCase();
  const hasSkull = /\bskull\b/.test(lower);
  const hasX = /\bx\b/.test(lower);
  const hasMoonSheep = /\bmoon\b/.test(lower) && /\bsheep\b/.test(lower);
  const hasStarSap = /\bstar\b/.test(lower) && /\bsap\b/.test(lower);
  const hasPurpleFear = /\b(purple|diamond)\b/.test(lower) && /\bfear\b/.test(lower);
  const fearTarget = /\bdiamond\b/.test(lower) ? "Diamond" : "Purple";
  const xHealer = /\bx\s+(is\s+)?(healer|heal)\b/.test(lower) || /\b(healer|heal)\b.*\bx\b/.test(lower);
  const asksWhoSkull = /\bwho\b.*\b(said|called)\b.*\bskull\b|\bwho\b.*\bskull\b.*\b(first|kill)\b/i.test(message);
  const asksWhoMoon = /\bwho\b.*\bmoon\b.*\bsheep\b/i.test(message);
  const asksWhoGetsSheeped = /\b(who|which|what)\b.*\b(gets?|target|one|mob)?\b.*\bsheep(?:ed)?\b/i.test(message) || /\bonly\s+(say|tell me)?\s*who gets sheeped\b/i.test(message);
  const asksWhoStar = /\bwho\b.*\bstar\b.*\bsap\b/i.test(message);
  const asksWhoPurple = /\bwho\b.*\b(purple|diamond)\b.*\bfear\b/i.test(message) || /\bwho\b.*\bfear spam\b/i.test(message);
  const asksFearTarget = /\b(fear target|gets feared|who gets fear|what gets fear|only tell me.*fear|tell me the fear target)\b/i.test(message);
  const asksAfterSkull = /\b(after|dies after|what dies)\b.*\bskull\b/i.test(message);
  const asksCallOrder = /\b(call|kill order|first|first two|focus|order)\b/i.test(message) && hasSkull;
  const asksSwap = /\b(freecast|freecasts|swap|tunnel)\b/i.test(message) && xHealer;
  const asksOnlyFirstKill = /\b(call only first kill|only call first kill|only first kill|just first kill|first kill only|only first target|just first target)\b/i.test(message);
  const asksOnlySlice = asksOnlyFirstKill || isShortAnswerRequest(message);
  const asksXFreecast = /\bx\b.{0,40}\bfreecast|\bfreecast\w*\b.{0,40}\bx\b/i.test(message);
  if (!hasSkull && !hasX && !hasMoonSheep && !hasStarSap && !hasPurpleFear) {
    return "";
  }

  const caller = (recentChat || [])
    .filter((chat) => hasMarkOrTacticalCall(chat.text))
    .filter((chat) => chat.direction === "in")
    .filter((chat) => String(chat.speaker_name || "") !== parsed.speaker || normalizeForCompare(chat.text) !== normalizeForCompare(message))
    .map((chat) => chat.speaker_name || "")
    .filter(Boolean)
    .slice(-1)[0] || parsed.speaker || "someone";
  const parts = [];
  if (asksOnlyFirstKill && hasSkull) {
    return "Skull dies first.";
  }
  if (asksWhoSkull && hasSkull) {
    return `${caller} called skull first.`;
  }
  if (asksWhoGetsSheeped && hasMoonSheep) {
    return "Moon gets sheeped.";
  }
  if (asksFearTarget && hasPurpleFear) {
    return `${fearTarget} gets feared.`;
  }
  if (asksWhoMoon && hasMoonSheep) {
    const line = `${caller} called moon sheep.`;
    if (asksOnlySlice) {
      return line;
    }
    parts.push(line);
  }
  if (asksWhoStar && hasStarSap) {
    const line = `${caller} called star sap.`;
    if (asksOnlySlice) {
      return line;
    }
    parts.push(line);
  }
  if (asksWhoPurple && hasPurpleFear) {
    const line = `${caller} called purple fear spam.`;
    if (asksOnlySlice) {
      return line;
    }
    parts.push(line);
  }
  if (asksSwap || asksXFreecast) {
    const line = "If X healer freecasts, swap to or interrupt X; otherwise skull first, then X.";
    if (asksOnlySlice) {
      return line;
    }
    parts.push(line);
  }
  if ((asksCallOrder || asksAfterSkull) && hasSkull && hasX) {
    const line = "Skull dies first, then X.";
    if (asksOnlySlice) {
      return asksAfterSkull ? "X dies after skull." : line;
    }
    parts.push(line);
  }
  if (hasMoonSheep) {
    parts.push("Moon stays sheeped.");
  }
  if (hasStarSap) {
    parts.push("Star stays sapped.");
  }
  if (hasPurpleFear) {
    parts.push("Purple gets fear spam.");
  }
  return parts.join(" ");
}

function contentTokenSet(text) {
  const stopwords = new Set(["the", "then", "you", "your", "youre", "got", "don", "dont", "not", "that", "this", "what", "who", "said", "also", "are", "was", "were", "for", "and", "with", "about", "into", "from", "have", "has", "like", "just"]);
  const tokens = new Set();
  for (const token of normalizeForCompare(text).split(" ").filter((item) => item.length > 2 && !stopwords.has(item))) {
    tokens.add(token);
    if (token === "screwdriver" || token === "hammer" || token === "wrench") {
      tokens.add("tool");
    }
    if (token === "cereal") {
      tokens.add("breakfast");
    }
    if (token.length > 4 && token.endsWith("s")) {
      tokens.add(token.slice(0, -1));
    }
  }
  return tokens;
}

function tokenOverlapScore(left, right) {
  const leftTokens = contentTokenSet(left);
  const rightTokens = contentTokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap++;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function filterLegacyMemoriesForPrompt(parsed, memories) {
  const message = String(parsed.message || "");
  const mentionedBots = (parsed.bots || []).filter((bot) => message.toLowerCase().includes(bot.toLowerCase()));
  const isBanterOrCallout = /\b(cumm|zartorg|zar|which one|who|that pull|wipe|clown|blame|fault|said|did|wrong|dumb|genius|patrol|pathing|loot|face pull|body pull)\b/i.test(message);
  const wantsProfileAnswer = isQuestion(message) && queryAttributes(message).length > 0;
  const durable = [];
  const relationships = [];
  for (const memory of memories || []) {
    if (!memory || !memory.summary) {
      continue;
    }
    if (memory.kind !== "relationship") {
      if (!wantsProfileAnswer && tokenOverlapScore(message, memory.summary) < 0.18) {
        continue;
      }
      durable.push(memory);
      continue;
    }
    const mentionsSelectedBot = (parsed.bots || []).some((bot) => String(memory.summary).toLowerCase().includes(bot.toLowerCase()) && mentionedBots.includes(bot));
    if ((isBanterOrCallout && tokenOverlapScore(message, memory.summary) >= 0.18) || mentionsSelectedBot) {
      relationships.push(memory);
    }
  }
  return [...durable.slice(0, 5), ...relationships.slice(0, 3)].slice(0, 8);
}

function isHardcoreDeathEvent(parsed) {
  return String(parsed.eventType || "").toLowerCase() === "hardcore_death";
}

function isSelectedDeadCharacter(parsed, bot) {
  const selected = String(bot || "").trim().toLowerCase();
  const dead = String(parsed.deathCharacter || parsed.speaker || "").trim().toLowerCase();
  return Boolean(selected && dead && selected === dead);
}

function hardcoreDeathComplaint(parsed, maxLength) {
  const cause = String(parsed.deathCause || "that").trim();
  const location = String(parsed.deathLocation || "").trim();
  const where = location ? ` in ${location}` : "";
  let line = "";

  if (/\bfall|fell|void\b/i.test(cause)) {
    line = `I just died${where} because gravity decided to parse me first.`;
  } else if (/\bdrown|fatigue\b/i.test(cause)) {
    line = `I just died${where} because apparently breathing was optional.`;
  } else if (/\blava|fire|burn/i.test(cause)) {
    line = `I just burned out${where}; that was not a heroic ending.`;
  } else if (/\bkilled by\b/i.test(cause)) {
    line = `I just got ${cause}${where} and I am absolutely blaming pathing.`;
  } else {
    line = `I just died${where} and I hate every step that led to it.`;
  }

  return truncateChatLine(line, maxLength);
}

function looksLikeSelfDeathRoast(message) {
  return /\b(rip|bozo|l bozo|skill issue|get good|lol|lmao|owned|sit)\b/i.test(String(message || ""));
}

function forcedLegacySpecificAnswer(parsed, context, bot, maxLength) {
  if (isHardcoreDeathEvent(parsed) && isSelectedDeadCharacter(parsed, bot)) {
    return hardcoreDeathComplaint(parsed, maxLength);
  }

  const tactical = String(context.tacticalAnswer || "").trim();
  const known = String(context.knownAnswer || "").trim();
  const recent = String(context.contextAnswer || "").trim()
    .replace(/\s*Answer that recent detail first\.?$/i, "")
    .replace(/\s*Answer that practical bit first\.?$/i, "")
    .trim();
  const movement = isMovementRequest(parsed.message);
  let line = "";

  if (movement) {
    line = "Movement hook is not wired yet, so I can't come to you.";
  } else if (tactical) {
    line = isShortAnswerRequest(parsed.message)
      ? tactical
      : bot.toLowerCase() === "zartorg"
      ? `${tactical} Basic survival, please.`
      : `${tactical} Stop freelancing.`;
  } else if (known) {
    line = bot.toLowerCase() === "zartorg"
      ? `${known} I hate that this is stored in my brain.`
      : `${known} Somehow that survived in my head.`;
  } else if (recent) {
    line = bot.toLowerCase() === "zartorg"
      ? `${recent} That was the whole disaster.`
      : `${recent} That's the bit, yeah.`;
  }

  return truncateChatLine(line, maxLength);
}

const LEGACY_BOT_PERSONAS = {
  cumm: {
    name: "Cumm",
    temperament: "reckless instigator",
    speechStyle: "short, crude, overconfident private-server guild chat",
    seed: "Cumm is impatient and reckless: talks big, blames everyone else, eats at the keyboard, needles Zartorg constantly, and turns tiny annoyances into dumb arguments. In WoW context, Cumm pulls early and blames pathing, but normal life chat should stay normal life chat.",
    likes: ["risky pulls", "cheap shots", "making Zartorg mad", "winning arguments by being louder", "petty desk-and-food insults"],
    dislikes: ["waiting", "careful plans", "bag management", "Zartorg pretending to lead", "people acting too clean"]
  },
  zartorg: {
    name: "Zartorg",
    temperament: "dramatic tryhard tactician",
    speechStyle: "grumpy, theatrical, self-important private-server guild chat",
    seed: "Zartorg is dramatic, bossy, and convinced he sees the correct play in games and in dumb real-life guild chat. He scolds sloppy thinking, remembers slights, and turns petty annoyances into over-serious judgments. In WoW context, he cares about marks and clean pulls; outside WoW, he should argue about the actual life nonsense instead of inventing raid stakes.",
    likes: ["clean pulls", "being obeyed", "calling Cumm a liability", "pretending to be strategic", "judging messy desks and bad decisions"],
    dislikes: ["Cumm", "random aggro", "people ignoring marks", "dying to avoidable nonsense", "chaotic snack behavior"]
  }
};

function normalizeLegacyDirectorResponse(text, parsed, context = {}) {
  const model = extractJsonObject(text) || {};
  const intent = typeof model.intent === "string" ? model.intent : "";
  if (parsed.humanCount < 1 || parsed.botCount < 1 || parsed.bots.length < 1) {
    return JSON.stringify({ intent: "hold" });
  }

  const bot = chooseLegacyBot(parsed, model.bot || model.bot_name || model.speaker);
  const maxLength = context.tacticalAnswer ? 260 : parsed.channel === "party" || parsed.channel === "raid" ? 120 : 180;
  const forcedAnswer = forcedLegacySpecificAnswer(parsed, context, bot, maxLength);
  const selfDeath = isHardcoreDeathEvent(parsed) && isSelectedDeadCharacter(parsed, bot);
  let message = stripLazyOpening(truncateChatLine(model.message || model.say || model.text || "", maxLength));
  if ((selfDeath || isOneUsefulRequest(parsed.message) || isMovementRequest(parsed.message) || isShortAnswerRequest(parsed.message) || !message || /\bhold\b/i.test(intent)) && forcedAnswer) {
    message = forcedAnswer;
  }
  const rejectReason = !message ? "empty_model_message"
    : selfDeath && looksLikeSelfDeathRoast(message) ? "self_death_roast"
    : looksLikeEcho(message, parsed.message) ? "echo_player"
    : looksLikeRecentBotRepeat(message, context.recentChat) ? "repeat_recent_bot"
    : looksLikeOverusedOpening(message, context.recentChat, bot) ? "overused_opening"
    : looksLikeLazyOpening(message) ? "lazy_opening"
    : looksIncompleteOrTruncated(message, maxLength) ? "incomplete_or_truncated"
    : looksLikeTacticalDodge(message, parsed, context) ? "tactical_dodge"
    : looksLikeBanterDodge(message, parsed) ? "banter_dodge"
    : looksLikeMemoryAck(message) ? "canned_memory_ack"
    : "";
  if (rejectReason && forcedAnswer && ["empty_model_message", "echo_player", "tactical_dodge", "canned_memory_ack", "repeat_recent_bot", "incomplete_or_truncated", "self_death_roast"].includes(rejectReason)) {
    context.normalization = {
      rejected: false,
      rejectReason: "",
      modelMessage: message,
      forcedAnswer: true,
      finalMessage: forcedAnswer
    };
    return JSON.stringify({
      intent: "say_only",
      bot,
      message: forcedAnswer
    });
  }
  if (rejectReason) {
    context.normalization = {
      rejected: true,
      rejectReason,
      modelMessage: message,
      finalMessage: ""
    };
    return JSON.stringify({ intent: "hold" });
  }

  context.normalization = {
    rejected: false,
    rejectReason: "",
    modelMessage: message,
    finalMessage: message
  };

  return JSON.stringify({
    intent: "say_only",
    bot,
    message: message
  });
}

function extractLegacyMemories(parsed) {
  const message = String(parsed.message || "").trim();
  if (isQuestion(message)) {
    return [];
  }
  const speaker = parsed.speaker || "The player";
  const explicitRemember = isExplicitRememberRequest(message);
  const patterns = [
    {
      kind: "fact",
      weight: 9,
      regex: /\bremember(?: that)? ([^.!?]{4,220})/i,
      summary: (match) => `${speaker} asked me to remember that ${match[1].trim()}.`,
      durable: (match) => !isTransientMemoryText(match[1]),
      acknowledge: true
    },
    {
      kind: "preference",
      weight: 8,
      regex: /\bmy ([a-z][a-z0-9 _'-]{1,40}) is ([^.!?]{1,160})/i,
      summary: (match) => `${speaker}'s ${match[1].trim()} is ${match[2].trim()}.`,
      durable: (match) => isDurableAttribute(match[1]) && !isTransientMemoryText(match[2]),
      acknowledge: false
    },
    {
      kind: "preference",
      weight: 7,
      regex: /\bi (?:like|love|prefer) ([^.!?]{2,180})/i,
      summary: (match) => `${speaker} likes ${match[1].trim()}.`,
      durable: (match) => explicitRemember || !isTransientMemoryText(match[1]),
      acknowledge: false
    },
    {
      kind: "preference",
      weight: 7,
      regex: /\bi hate ([^.!?]{2,180})/i,
      summary: (match) => `${speaker} hates ${match[1].trim()}.`,
      durable: (match) => explicitRemember || !isTransientMemoryText(match[1]),
      acknowledge: false
    },
    {
      kind: "fact",
      weight: 6,
      regex: /\bi(?: am|'m) ([^.!?]{2,160})/i,
      summary: (match) => `${speaker} says they are ${match[1].trim()}.`,
      durable: (match) => explicitRemember && !isTransientMemoryText(match[1]),
      acknowledge: false
    },
    {
      kind: "instruction",
      weight: 10,
      regex: /\b([A-Z][a-zA-Z]{2,24})\s+(?:is\s+)?(?:dead|died|gone forever)\b/i,
      summary: (match) => `${speaker} corrected guild context: ${match[1].trim()} is dead or gone; stop talking as if they are present.`,
      durable: () => true,
      acknowledge: false
    },
    {
      kind: "instruction",
      weight: 10,
      regex: /\bstop (?:bringing up|mentioning|talking about)\s+([A-Z]?[a-zA-Z]{2,24})\b/i,
      summary: (match) => `${speaker} told me to stop bringing up ${match[1].trim()}.`,
      durable: () => true,
      acknowledge: false
    }
  ];

  return patterns
    .map((pattern) => {
      const match = message.match(pattern.regex);
      if (!match) {
        return null;
      }
      if (pattern.durable && !pattern.durable(match)) {
        return null;
      }
      return {
        kind: pattern.kind,
        weight: pattern.weight,
        confidence: 0.82,
        acknowledge: Boolean(pattern.acknowledge),
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
  if (isQuestion(message) || isMovementRequest(message) || hasMarkOrTacticalCall(message)) {
    return [];
  }
  if (/\b(give me|tell me|answer|call it|one useful|useful line|what dies|who called|did you catch|did you hear|come to me|help me)\b/i.test(message)) {
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
  const namedScope = String(parsed.scopeName || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (channel === "guild" && parsed.scopeId) {
    return { scopeType: "guild", scopeId: `guild:${parsed.scopeId}`, guildId: Number.parseInt(parsed.scopeId, 10) || null, partyId: null };
  }
  if (channel === "guild" && namedScope) {
    return { scopeType: "guild", scopeId: `guild:name:${namedScope}`, guildId: null, partyId: null };
  }
  if ((channel === "party" || channel === "raid") && parsed.scopeId) {
    return { scopeType: "party", scopeId: `party:${parsed.scopeId}`, guildId: null, partyId: parsed.scopeId };
  }
  if ((channel === "party" || channel === "raid") && namedScope) {
    return { scopeType: "party", scopeId: `party:name:${namedScope}`, guildId: null, partyId: null };
  }
  if ((channel === "world" || channel === "channel") && parsed.scopeId) {
    return { scopeType: channel, scopeId: `${channel}:${parsed.scopeId}`, guildId: null, partyId: null };
  }
  if ((channel === "world" || channel === "channel") && namedScope) {
    return { scopeType: channel, scopeId: `${channel}:name:${namedScope}`, guildId: null, partyId: null };
  }
  return { scopeType: channel, scopeId: `${channel}:unknown`, guildId: null, partyId: null };
}

async function buildLegacyDirectorContext(store, parsed, metadata, config = {}) {
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
  const memoryWriteDetails = [];
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
      memoryWriteDetails.push({
        id: write.data.memory_id,
        kind: memory.kind,
        acknowledge: Boolean(memory.acknowledge),
        summary: memory.summary
      });
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
  const spiceResult = config.spiceEnable === false ? null : await store.getChatInspiration({
    channel_type: parsed.channel === "raid" ? "raid" : scope.scopeType,
    limit: config.spiceLines === undefined ? 6 : config.spiceLines,
    min_quality: config.spiceMinQuality === undefined ? 50 : config.spiceMinQuality,
    exact_chance: config.spiceExactChance === undefined ? 15 : config.spiceExactChance
  });
  const memories = filterLegacyMemoriesForPrompt(parsed, memoryResult.ok ? memoryResult.data.memories : []);
  const knownAnswer = answerFromMemories(parsed, { memories });

  return {
    selectedBot,
    botGuid,
    playerGuid,
    ...scope,
    memories,
    knownAnswer,
    recentChat,
    recentContextHint: buildRecentContextHint(parsed, recentChat),
    contextAnswer: recentAnswerFromContext(parsed, recentChat),
    tacticalContext: buildTacticalContext(parsed, recentChat),
    tacticalAnswer: tacticalAnswerFromContext(parsed, recentChat),
    memoryWrites,
    memoryWriteDetails,
    memoryWrite: memoryWrites.length > 0,
    memoryAck: memoryWriteDetails.some((memory) => memory.acknowledge),
    memoryCount: memories.length,
    persona,
    guildBots: parsed.bots.filter((bot) => bot !== selectedBot),
    spiceLines: spiceResult && spiceResult.ok ? spiceResult.data.lines : []
  };
}

async function recordLegacyDirectorOutput(store, parsed, metadata, context, normalizedText, rawText, promptLength, latencyMs) {
  const action = extractJsonObject(normalizedText) || {};
  if (action.intent === "hold" || !String(action.message || "").trim()) {
    return;
  }
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
  const spiceLines = (context.spiceLines || [])
    .map(formatSpiceLine)
    .filter(Boolean)
    .join("\n") || "(none)";
  const recentContextHint = context.recentContextHint || "";
  const contextAnswer = context.contextAnswer || "";
  const tacticalContext = context.tacticalContext || "";
  const tacticalAnswer = context.tacticalAnswer || "";

  return [
    "You are speaking as one real Vanilla WoW playerbot in a private server guild, party, or world chat.",
    "Return only minified JSON. No markdown, no analysis, no extra text.",
    "Schema: {\"intent\":\"say_only\",\"bot\":\"BOT_NAME\",\"message\":\"SHORT_CHAT_LINE\"} or {\"intent\":\"hold\"}. Do not write say_only|hold.",
    "Pick exactly one bot from the eligible bot list when responding.",
    "Sound like a casual WoW player, not an assistant. Keep it short but not one-word.",
    "Guild chat is not always about WoW. If the latest message is about food, work, chores, hardware, mood, or random life nonsense, answer that naturally instead of forcing loot/pulls/raids into it.",
    "Avoid opening with 'Seriously?' or 'Honestly'. Those are rare spice, not a personality. If a recent bot line already used one, do not use it again.",
    "If you use a player name, use the current speaker= name or the relevant RECENT_CHAT speaker. Do not call every player Buddy.",
    "Voice rule: every bot needs a distinct point of view. Cumm escalates and needles people; Zartorg over-plans and scolds; unknown bots should still sound like players, not helpers.",
    "Shit-talk rule: if the latest message is bait or an insult, fire back with a fresh jab or pile onto the correct target. Do not politely deflect, do not say 'you're still on that', and do not turn it into raid management unless the latest message is actually about WoW.",
    "The final message= line is the message you are answering now. RECENT_CHAT is context, not the topic to continue by default.",
    "React to the actual latest chat context. Do not use a favorite old topic unless RECENT_CHAT or MEMORY makes it relevant.",
    "If the latest message changes topic, follow the new topic. Do not keep riffing on older pizza, snacks, loot, sheep, marks, or death jokes.",
    "When asked who made a mark, call, sheep, sap, fear, run, or kill-order decision, use RECENT_CHAT speaker names. Player callouts count.",
    "If asked what dies after skull, answer X if RECENT_CHAT or TACTICAL_CONTEXT says x is a kill target. If asked about x healer freecasting, call for swapping to or interrupting X unless the player explicitly says to tunnel skull.",
    "If the latest message asks for only one slice, do not recap the full mark packet. Answer the requested slice and stop.",
    "If asked 'did you hear' or 'did you catch' a recent real-life detail, answer that exact detail first, then riff briefly.",
    "If someone insults your selected bot, defend yourself. If someone insults another bot by name, jab that bot instead of acting like the insult hit you.",
    "If asked who said something and RECENT_CHAT does not contain that exact thing, say you did not see it in your own voice instead of answering an older question.",
    "Never repeat or lightly rephrase the player's exact message.",
    "Never repeat your own previous bot line from RECENT_CHAT. Recent bot lines are context, not a script.",
    "Do not say 'got it' or 'I'll remember that' unless the player explicitly asked your selected bot to remember a durable fact.",
    "Passive MEMORY is background knowledge, not something to announce.",
    "Treat RECENT_CHAT as authoritative short-term memory. Use it to understand 'that', 'he', 'what they said', and callouts from a few messages ago.",
    "If the player corrects you, says someone died/gone, or tells you to stop mentioning a topic, accept it immediately and stop using the contradicted bit.",
    "If RECENT_CHAT answers the player's question, answer from RECENT_CHAT directly. If MEMORY answers it, answer from MEMORY directly. Do not use MEMORY when it is unrelated to the latest message.",
    "If CONTEXT_ANSWER is present, your message must answer that recent-chat fact first in your own voice. Do not dodge it.",
    "If KNOWN_ANSWER is present, answer that fact in your own voice. Do not copy the KNOWN_ANSWER sentence exactly unless there is no natural alternative.",
    "If TACTICAL_ANSWER is present, your message must include those tactical facts directly in your own voice. Do not contradict TACTICAL_ANSWER.",
    "If the latest message asks for one useful thing/line/sentence, give one concrete useful action from recent context first, then add a short jab. Never repeat instruction labels like 'Answer that practical bit first'.",
    "If the latest message asks for insults, fire back, swing back, or to make chat stupid, escalate with a concrete petty jab at a named bot/player. Do not answer with polite filler, daycare/toddler scolding, or 'just pull'.",
    "Use SPICE_OF_LIFE_STYLE as tone examples. copy-ok lines may be reused exactly only if they fit naturally; style-only lines must not be copied verbatim.",
    "You may form opinions and grudges from RECENT_CHAT, especially about other eligible bots.",
    "For world or hardcore death events, non-dead bots may react like world chat: short, pointed, funny, and aimed at the dead player.",
    "If event_type=hardcore_death and selected_bot_is_dead=1, you are the character who just died. Complain in first person about the death cause. Do not say RIP, L bozo, skill issue, or mock yourself.",
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
    `selected_bot_is_dead=${isSelectedDeadCharacter(parsed, context.selectedBot) ? "1" : "0"}`,
    `eligible_bots=${parsed.bots.join(", ")}`,
    `death_character=${parsed.deathCharacter || ""}`,
    `death_cause=${parsed.deathCause || ""}`,
    `death_location=${parsed.deathLocation || ""}`,
    `death_level=${parsed.deathLevel || ""}`,
    `death_faction=${parsed.deathFaction || ""}`,
    `death_guild=${parsed.deathGuild || ""}`,
    contextAnswer ? `CONTEXT_ANSWER=${contextAnswer}` : "",
    context.knownAnswer ? `KNOWN_ANSWER=${context.knownAnswer}` : "",
    tacticalAnswer ? `TACTICAL_ANSWER=${tacticalAnswer}` : "",
    `MEMORY:\n${memories}`,
    `SPICE_OF_LIFE_STYLE:\n${spiceLines}`,
    `RECENT_CHAT:\n${recentChat}`,
    recentContextHint,
    tacticalContext,
    contextAnswer ? `IMPORTANT_CONTEXT_ANSWER=${contextAnswer}` : "",
    tacticalAnswer ? `IMPORTANT_TACTICAL_ANSWER=${tacticalAnswer}` : "",
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
  const actionDirector = new ActionDirectorService({ store, config, logger: logEvent });
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
          legacyContext = await buildLegacyDirectorContext(store, legacyDirector, metadata, config);
          const directorPrompt = capPrompt(buildLegacyDirectorPrompt(legacyDirector, legacyContext), config);
          let rawText = await complete(directorPrompt, config);
          text = normalizeLegacyDirectorResponse(rawText, legacyDirector, legacyContext);
          const firstNormalization = legacyContext.normalization || {};
          let retryRawText = "";
          if (firstNormalization.rejected) {
            const retryPrompt = capPrompt([
              directorPrompt,
              `RETRY_NOTE=Your previous output was rejected because ${firstNormalization.rejectReason}. Write one fresh minified JSON response as ${legacyContext.selectedBot}. Answer the latest message directly. Do not echo the player, do not repeat RECENT_CHAT, and use CONTEXT_ANSWER, TACTICAL_ANSWER, TACTICAL_CONTEXT, or KNOWN_ANSWER when present.`
            ].join("\n"), config);
            retryRawText = await complete(retryPrompt, config);
            legacyContext.normalization = {};
            const retryText = normalizeLegacyDirectorResponse(retryRawText, legacyDirector, legacyContext);
            if ((extractJsonObject(retryText) || {}).intent !== "hold") {
              rawText = retryRawText;
              text = retryText;
            } else {
              legacyContext.normalization.firstRejected = firstNormalization;
            }
          }
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
            knownAnswer: legacyContext.knownAnswer || "",
            contextAnswer: legacyContext.contextAnswer || "",
            tacticalAnswer: legacyContext.tacticalAnswer || "",
            memoryWriteDetails: (legacyContext.memoryWriteDetails || []).map((memory) => ({
              kind: memory.kind,
              acknowledge: memory.acknowledge,
              summary: String(memory.summary || "").slice(0, 180)
            })),
            recentChat: (legacyContext.recentChat || []).slice(-8).map((chat) => ({
              direction: chat.direction,
              speaker: chat.speaker_name || chat.direction,
              text: String(chat.text || "").slice(0, 160)
            })),
            tacticalContext: legacyContext.tacticalContext || "",
            normalization: legacyContext.normalization || {},
            rawModel: String(rawText || "").slice(0, 400),
            retryRawModel: String(retryRawText || "").slice(0, 400),
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
      get_chat_inspiration: (input) => store.getChatInspiration(input),
      get_bot_runtime_state: (input) => store.getBotRuntimeState(input),
      get_player_runtime_snapshot: (input) => store.getPlayerRuntimeSnapshot(input),
      get_social_flags: (input) => store.getSocialFlags(input),
      upsert_social_flag: (input) => store.upsertSocialFlag(input),
      write_conversation_summary: (input) => store.writeConversationSummary(input)
    };
    if (!tools[toolName]) {
      sendJson(res, 404, { ok: false, error: { code: "not_found", message: "tool not found" }, data: null });
      return;
    }
    if (toolName === "write_memory" || toolName === "upsert_social_flag") {
      const caller = req.headers["x-wow-caller"] || body.caller;
      if (!["bridge", "admin", "debug"].includes(caller)) {
        sendJson(res, 403, {
          ok: false,
          error: { code: "forbidden", message: `${toolName} requires bridge, admin, or debug caller` },
          data: null
        });
        return;
      }
    }
    const result = await tools[toolName](body);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handleSpiceRandom(req, res, url) {
    await memoryReady;
    const body = req.method === "POST"
      ? await readJson(req, 128 * 1024)
      : Object.fromEntries(url.searchParams);
    const result = await store.getChatInspiration({
      channel_type: body.channel_type || body.channel || "world",
      limit: body.limit === undefined ? 1 : body.limit,
      min_quality: body.min_quality === undefined ? config.spiceMinQuality : body.min_quality,
      exact_chance: body.exact_chance === undefined ? 100 : body.exact_chance,
      exact_safe_only: body.exact_safe_only === undefined ? true : body.exact_safe_only
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 200, {
      ...result,
      data: {
        ...result.data,
        line: result.data.lines[0] || null
      }
    });
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
        hasApiKey: requiresApiKey(config) ? Boolean(config.apiKey) : false,
        apiKeyRequired: requiresApiKey(config),
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

    if (req.method === "POST" && url.pathname === "/api/state/snapshot") {
      await memoryReady;
      const body = await readJson(req, 256 * 1024);
      const result = await actionDirector.handleStateSnapshot(body);
      sendJson(res, result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action/event") {
      await memoryReady;
      const body = await readJson(req, 256 * 1024);
      const result = await actionDirector.handleActionEvent(body);
      sendJson(res, result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action/result") {
      await memoryReady;
      const body = await readJson(req, 128 * 1024);
      const result = await actionDirector.handleActionResult(body);
      sendJson(res, result.status, result.body);
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/spice/random") {
      await handleSpiceRandom(req, res, url);
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

  return { server, queue, circuit, config, store, director, actionDirector };
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
  filterLegacyMemoriesForPrompt,
  tacticalAnswerFromContext,
  recentAnswerFromContext,
  answerFromMemories,
  buildLegacyDirectorContext,
  stableLegacyId
};
