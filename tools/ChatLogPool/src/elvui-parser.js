"use strict";

const crypto = require("node:crypto");

const PLAYER_CHAT_EVENTS = new Set([
  "CHAT_MSG_CHANNEL",
  "CHAT_MSG_SAY",
  "CHAT_MSG_YELL",
  "CHAT_MSG_TEXT_EMOTE",
  "CHAT_MSG_EMOTE",
  "CHAT_MSG_WHISPER",
  "CHAT_MSG_WHISPER_INFORM",
  "CHAT_MSG_BN_WHISPER",
  "CHAT_MSG_BN_WHISPER_INFORM",
  "CHAT_MSG_PARTY",
  "CHAT_MSG_PARTY_LEADER",
  "CHAT_MSG_RAID",
  "CHAT_MSG_RAID_LEADER",
  "CHAT_MSG_RAID_WARNING",
  "CHAT_MSG_GUILD"
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function decodeLuaString(value) {
  const raw = String(value || "");
  const body = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return body.replace(/\\([\\"])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\(\d{1,3})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)));
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      const lineEnd = text.indexOf("\n", i + 2);
      i = lineEnd === -1 ? text.length : lineEnd;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findNamedTable(text, tableName) {
  const pattern = new RegExp(`\\["${tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\s*=\\s*\\{`, "m");
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const openIndex = text.indexOf("{", match.index);
  const closeIndex = findMatchingBrace(text, openIndex);
  if (closeIndex === -1) {
    return null;
  }
  return {
    start: openIndex,
    end: closeIndex,
    body: text.slice(openIndex + 1, closeIndex)
  };
}

function findEntryBlocks(body) {
  const entries = [];
  let index = 0;
  let ordinal = 1;
  while (index < body.length) {
    const openIndex = body.indexOf("{", index);
    if (openIndex === -1) {
      break;
    }
    const closeIndex = findMatchingBrace(body, openIndex);
    if (closeIndex === -1) {
      break;
    }
    const prefix = body.slice(Math.max(0, openIndex - 96), openIndex);
    const suffix = body.slice(closeIndex + 1, Math.min(body.length, closeIndex + 64));
    const keyMatch = prefix.match(/\["([^"]+)"\]\s*=\s*$/);
    const ordinalMatch = suffix.match(/--\s*\[(\d+)\]/);
    entries.push({
      key: keyMatch ? keyMatch[1] : ordinalMatch ? ordinalMatch[1] : String(ordinal),
      body: body.slice(openIndex + 1, closeIndex)
    });
    ordinal++;
    index = closeIndex + 1;
  }
  return entries;
}

function parseLuaEntry(entryBody) {
  const fields = {};
  const linePattern = /^\s*(?:\[(\d+)\]\s*=\s*)?("(?:\\.|[^"\\])*")\s*,?\s*(?:--\s*\[(\d+)\])?/;
  const numberPattern = /^\s*(?:\[(\d+)\]\s*=\s*)?(-?\d+(?:\.\d+)?)\s*,?\s*(?:--\s*\[(\d+)\])?/;
  for (const line of String(entryBody || "").split(/\r?\n/)) {
    const stringMatch = line.match(linePattern);
    if (stringMatch) {
      const key = stringMatch[1] || stringMatch[3];
      if (key) {
        fields[key] = decodeLuaString(stringMatch[2]);
      }
      continue;
    }
    const numberMatch = line.match(numberPattern);
    if (numberMatch) {
      const key = numberMatch[1] || numberMatch[3];
      if (key) {
        fields[key] = Number.parseFloat(numberMatch[2]);
      }
    }
  }
  return fields;
}

function normalizeChannel(eventType, channelName) {
  if (eventType === "CHAT_MSG_GUILD") {
    return "guild";
  }
  if (eventType === "CHAT_MSG_PARTY" || eventType === "CHAT_MSG_PARTY_LEADER") {
    return "party";
  }
  if (eventType === "CHAT_MSG_RAID" || eventType === "CHAT_MSG_RAID_LEADER" || eventType === "CHAT_MSG_RAID_WARNING") {
    return "raid";
  }
  if (eventType === "CHAT_MSG_WHISPER" || eventType === "CHAT_MSG_WHISPER_INFORM" ||
      eventType === "CHAT_MSG_BN_WHISPER" || eventType === "CHAT_MSG_BN_WHISPER_INFORM") {
    return "whisper";
  }
  if (eventType === "CHAT_MSG_SAY" || eventType === "CHAT_MSG_EMOTE" || eventType === "CHAT_MSG_TEXT_EMOTE") {
    return "say";
  }
  if (eventType === "CHAT_MSG_YELL") {
    return "yell";
  }
  const normalized = String(channelName || "").toLowerCase();
  if (normalized.includes("world")) {
    return "world";
  }
  return "channel";
}

function stripWowMarkup(message) {
  return String(message || "")
    .replace(/\|H[^|]+\|h\[([^\]]+)\]\|h/g, "$1")
    .replace(/\|T[^|]+\|t/g, "")
    .replace(/\|c[0-9a-fA-F]{8}/g, "")
    .replace(/\|r/g, "")
    .replace(/\{[A-Za-z]+\}/g, "")
    .replace(/\[[^\]]+\]\s+has come online\./gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rejectReason(message, eventType) {
  if (!PLAYER_CHAT_EVENTS.has(eventType)) {
    return "not_player_chat";
  }
  if (!message || message.length < 2) {
    return "empty";
  }
  if (message.length > 220) {
    return "too_long";
  }
  if (/^\/[a-z]/i.test(message)) {
    return "command";
  }
  if (/(https?:\/\/|www\.|discord\.gg|twitch\.tv|\.com\/)/i.test(message)) {
    return "url";
  }
  if (/\b(wts|wtb|lfm|lfg|boost|selling)\b/i.test(message) && message.length > 120) {
    return "listing_spam";
  }
  return "";
}

function qualityScore(message, eventType) {
  let score = 55;
  const length = message.length;
  if (length >= 8 && length <= 90) {
    score += 20;
  } else if (length <= 140) {
    score += 10;
  }
  if (/[?!]/.test(message)) {
    score += 5;
  }
  if (/\b(lol|haha|lmao|rip|grats|gz|bruh|nah|yeah|yep|nope)\b/i.test(message)) {
    score += 8;
  }
  const letters = message.replace(/[^a-z]/gi, "");
  const caps = letters.replace(/[^A-Z]/g, "");
  if (letters.length > 8 && caps.length / letters.length > 0.65) {
    score -= 18;
  }
  if (eventType.includes("WHISPER")) {
    score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

function tagsFor(message, eventType, channelType) {
  const tags = [channelType];
  if (eventType.includes("WHISPER")) {
    tags.push("whisper");
  }
  if (/\?/.test(message)) {
    tags.push("question");
  }
  if (/\b(lol|haha|lmao|rofl)\b/i.test(message)) {
    tags.push("joke");
  }
  if (/\b(rip|dead|died|wipe)\b/i.test(message)) {
    tags.push("death");
  }
  if (/\b(grats|gz|congrats)\b/i.test(message)) {
    tags.push("grats");
  }
  return [...new Set(tags)];
}

function toRecord({ fields, sourceTable, sourceKey, sourceFileHash }) {
  const eventType = String(fields["50"] || fields["20"] || "").trim();
  const cleaned = stripWowMarkup(fields["1"]);
  const reason = rejectReason(cleaned, eventType);
  if (reason) {
    return { rejected: true, reason };
  }
  const speaker = stripWowMarkup(fields["2"] || fields["52"] || "");
  const channelName = stripWowMarkup(fields["9"] || fields["4"] || "");
  const channelType = normalizeChannel(eventType, channelName);
  const timestamp = Number.isFinite(fields["51"]) ? Math.trunc(fields["51"]) :
    /^\d+(?:\.\d+)?$/.test(sourceKey) ? Math.trunc(Number.parseFloat(sourceKey)) : null;
  const quality = qualityScore(cleaned, eventType);
  const exactSafe = quality >= 72 &&
    cleaned.length <= 120 &&
    !eventType.includes("WHISPER") &&
    !/[@#]|[0-9]{4,}/.test(cleaned);
  const sourceHash = sha256([
    sourceFileHash,
    sourceTable,
    sourceKey,
    eventType,
    timestamp || "",
    speaker,
    cleaned
  ].join("\u001f"));
  return {
    rejected: false,
    record: {
      line_hash: sha256([eventType, channelType, speaker.toLowerCase(), cleaned.toLowerCase()].join("\u001f")),
      source_hash: sourceHash,
      source_file: sourceFileHash,
      source_table: sourceTable,
      source_key: String(sourceKey),
      message: cleaned,
      speaker,
      channel_type: channelType,
      channel_name: channelName,
      event_type: eventType,
      event_timestamp: timestamp,
      quality_score: quality,
      exact_safe: exactSafe,
      tags: tagsFor(cleaned, eventType, channelType),
      metadata: { imported_from: "elvui_saved_variables" }
    }
  };
}

function parseElvuiChat(text, options = {}) {
  const sourceFileHash = options.sourceFileHash || sha256(options.sourceFile || "unknown");
  const records = [];
  const rejected = {};
  for (const sourceTable of ["ChatHistoryLog", "ChatLog"]) {
    const table = findNamedTable(text, sourceTable);
    if (!table) {
      continue;
    }
    for (const entry of findEntryBlocks(table.body)) {
      const parsed = toRecord({
        fields: parseLuaEntry(entry.body),
        sourceTable,
        sourceKey: entry.key,
        sourceFileHash
      });
      if (parsed.rejected) {
        rejected[parsed.reason] = (rejected[parsed.reason] || 0) + 1;
      } else {
        records.push(parsed.record);
      }
    }
  }
  return { records, rejected };
}

module.exports = {
  PLAYER_CHAT_EVENTS,
  parseElvuiChat,
  stripWowMarkup,
  normalizeChannel,
  sha256
};
