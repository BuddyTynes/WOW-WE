"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SqliteCliDatabase, sqlLiteral } = require("./sqlite-cli");

const CHANNEL_TYPES = new Set(["guild", "party", "raid", "whisper", "say", "channel", "world", "system"]);
const MEMORY_KINDS = new Set([
  "relationship", "preference", "fact", "promise", "conflict", "achievement",
  "instruction", "summary", "system_note"
]);
const EVENT_KINDS = new Set([
  "chat_in", "chat_out", "intent_in", "intent_out", "memory_write",
  "summary_write", "tool_call", "tool_error", "model_error", "system"
]);
const INTENTS = new Set([
  "say_only", "follow_leader", "assist_target", "hold_position", "move_closer",
  "heal_priority", "avoid_combat", "need_help"
]);

function ok(data) {
  return { ok: true, error: null, data };
}

function fail(code, message) {
  return { ok: false, error: { code, message }, data: null };
}

function asInt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asFloat(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBool(value) {
  return value === true || value === 1 || value === "1";
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonText(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function rowToBot(row) {
  if (!row) {
    return null;
  }
  return {
    bot_guid: asInt(row.bot_guid),
    bot_key: row.bot_key,
    name: row.name,
    race: row.race,
    class: row.class,
    gender: row.gender,
    tier: asInt(row.tier),
    enabled: asBool(row.enabled),
    temperament: row.temperament,
    speech_style: row.speech_style,
    personality_seed: row.personality_seed || "",
    likes: parseJson(row.likes_json, []),
    dislikes: parseJson(row.dislikes_json, []),
    boundaries: parseJson(row.boundaries_json, []),
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToPlayer(row) {
  if (!row) {
    return null;
  }
  return {
    player_guid: asInt(row.player_guid),
    account_id: asInt(row.account_id),
    name: row.name,
    known_facts: parseJson(row.known_facts_json, {}),
    preferences: parseJson(row.preferences_json, {}),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToRelationship(row) {
  if (!row) {
    return null;
  }
  return {
    bot_guid: asInt(row.bot_guid),
    player_guid: asInt(row.player_guid),
    relationship_summary: row.relationship_summary || "",
    affinity: asInt(row.affinity) || 0,
    trust: asInt(row.trust) || 0,
    familiarity: asInt(row.familiarity) || 0,
    interaction_count: asInt(row.interaction_count) || 0,
    last_seen_at: row.last_seen_at
  };
}

function rowToMemory(row) {
  return {
    memory_id: row.memory_id,
    kind: row.kind,
    summary: row.summary,
    weight: asInt(row.weight),
    confidence: asFloat(row.confidence),
    last_seen_at: row.last_seen_at,
    score: asFloat(row.score) || 0
  };
}

class MemoryStore {
  constructor(options = {}) {
    this.db = options.db || new SqliteCliDatabase(options.dbPath || "./data/llm_memory.sqlite3");
    this.migrationsDir = options.migrationsDir || path.join(__dirname, "..", "migrations");
    this.ready = false;
    this.lastError = null;
  }

  async init() {
    await this.db.open();
    const files = (await fs.promises.readdir(this.migrationsDir))
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const sql = await fs.promises.readFile(path.join(this.migrationsDir, file), "utf8");
      await this.db.exec(sql);
    }
    this.ready = true;
    this.lastError = null;
  }

  async ensureReady() {
    if (this.ready) {
      return;
    }
    try {
      await this.init();
    } catch (error) {
      this.lastError = error;
      throw error;
    }
  }

  health() {
    return {
      ok: this.ready && !this.lastError,
      dbPath: this.db.dbPath,
      error: this.lastError ? this.lastError.message : null
    };
  }

  async getCounts() {
    await this.ensureReady();
    const row = await this.db.get(
      "SELECT (SELECT COUNT(*) FROM bot_profiles) AS bots, (SELECT COUNT(*) FROM player_profiles) AS players, (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM event_log) AS events;"
    );
    return {
      bots: asInt(row.bots) || 0,
      players: asInt(row.players) || 0,
      memories: asInt(row.memories) || 0,
      events: asInt(row.events) || 0
    };
  }

  async upsertBotProfile(input) {
    await this.ensureReady();
    const botGuid = asInt(input.bot_guid);
    if (!botGuid || !input.name) {
      return fail("invalid_request", "bot_guid and name are required");
    }
    const botKey = input.bot_key || normalizeName(input.name) || `bot-${botGuid}`;
    const existed = await this.db.get("SELECT bot_guid FROM bot_profiles WHERE bot_guid = ?;", [botGuid]);
    if (existed) {
      await this.db.exec(`
        UPDATE bot_profiles
        SET name = ${sqlLiteral(input.name)},
            tier = ${sqlLiteral(clamp(input.tier, 0, 4, 0))},
            enabled = ${sqlLiteral(input.enabled === false ? 0 : 1)},
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE bot_guid = ${sqlLiteral(botGuid)};
      `);
    } else {
      await this.db.exec(`
        INSERT INTO bot_profiles (
          bot_guid, bot_key, name, race, class, gender, tier, enabled, temperament,
          speech_style, personality_seed, likes_json, dislikes_json, boundaries_json,
          metadata_json, last_seen_at
        ) VALUES (
          ${sqlLiteral(botGuid)}, ${sqlLiteral(botKey)}, ${sqlLiteral(input.name)},
          ${sqlLiteral(input.race)}, ${sqlLiteral(input.class)}, ${sqlLiteral(input.gender)},
          ${sqlLiteral(clamp(input.tier, 0, 4, 0))}, ${sqlLiteral(input.enabled === false ? 0 : 1)},
          ${sqlLiteral(input.temperament)}, ${sqlLiteral(input.speech_style)},
          ${sqlLiteral(input.personality_seed || "")}, ${sqlLiteral(jsonText(input.likes, []))},
          ${sqlLiteral(jsonText(input.dislikes, []))}, ${sqlLiteral(jsonText(input.boundaries, []))},
          ${sqlLiteral(jsonText(input.metadata, {}))}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      `);
    }
    return ok({ bot_guid: botGuid, updated: true });
  }

  async getBotProfile(input) {
    await this.ensureReady();
    const row = input.bot_guid
      ? await this.db.get("SELECT * FROM bot_profiles WHERE bot_guid = ?;", [input.bot_guid])
      : await this.db.get("SELECT * FROM bot_profiles WHERE bot_key = ?;", [input.bot_key]);
    const bot = rowToBot(row);
    return bot ? ok(bot) : fail("not_found", "Bot profile not found");
  }

  async upsertPlayerProfile(input) {
    await this.ensureReady();
    const playerGuid = asInt(input.player_guid);
    if (!playerGuid || !input.name) {
      return fail("invalid_request", "player_guid and name are required");
    }
    const existed = await this.db.get("SELECT player_guid FROM player_profiles WHERE player_guid = ?;", [playerGuid]);
    if (existed) {
      await this.db.exec(`
        UPDATE player_profiles
        SET account_id = COALESCE(${sqlLiteral(asInt(input.account_id))}, account_id),
            name = ${sqlLiteral(input.name)},
            normalized_name = ${sqlLiteral(normalizeName(input.name))},
            metadata_json = ${sqlLiteral(jsonText(input.metadata, {}))},
            last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE player_guid = ${sqlLiteral(playerGuid)};
      `);
    } else {
      await this.db.exec(`
        INSERT INTO player_profiles (
          player_guid, account_id, name, normalized_name, metadata_json, last_seen_at
        ) VALUES (
          ${sqlLiteral(playerGuid)}, ${sqlLiteral(asInt(input.account_id))},
          ${sqlLiteral(input.name)}, ${sqlLiteral(normalizeName(input.name))},
          ${sqlLiteral(jsonText(input.metadata, {}))}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      `);
    }
    return ok({ player_guid: playerGuid, created: !existed, updated: Boolean(existed) });
  }

  async getPlayerProfile(input) {
    await this.ensureReady();
    let row = null;
    if (input.player_guid) {
      row = await this.db.get("SELECT * FROM player_profiles WHERE player_guid = ?;", [input.player_guid]);
    }
    if (!row && input.account_id) {
      row = await this.db.get("SELECT * FROM player_profiles WHERE account_id = ? ORDER BY last_seen_at DESC LIMIT 1;", [input.account_id]);
    }
    if (!row && input.name) {
      row = await this.db.get("SELECT * FROM player_profiles WHERE normalized_name = ? ORDER BY last_seen_at DESC LIMIT 1;", [normalizeName(input.name)]);
    }
    const player = rowToPlayer(row);
    return player ? ok(player) : fail("not_found", "Player profile not found");
  }

  async getRelationship(input) {
    await this.ensureReady();
    const botGuid = asInt(input.bot_guid);
    const playerGuid = asInt(input.player_guid);
    if (!botGuid || !playerGuid) {
      return fail("invalid_request", "bot_guid and player_guid are required");
    }
    let row = await this.db.get("SELECT * FROM bot_player_relationships WHERE bot_guid = ? AND player_guid = ?;", [botGuid, playerGuid]);
    if (!row && input.create_if_missing) {
      await this.db.exec(`
        INSERT OR IGNORE INTO bot_player_relationships (bot_guid, player_guid, last_seen_at)
        VALUES (${sqlLiteral(botGuid)}, ${sqlLiteral(playerGuid)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      row = await this.db.get("SELECT * FROM bot_player_relationships WHERE bot_guid = ? AND player_guid = ?;", [botGuid, playerGuid]);
    }
    const relationship = rowToRelationship(row);
    return relationship ? ok(relationship) : fail("not_found", "Relationship not found");
  }

  async touchRelationship(input) {
    const current = await this.getRelationship({ ...input, create_if_missing: true });
    if (!current.ok) {
      return current;
    }
    await this.db.exec(`
      UPDATE bot_player_relationships
      SET interaction_count = interaction_count + 1,
          familiarity = MIN(100, familiarity + 1),
          last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE bot_guid = ${sqlLiteral(input.bot_guid)} AND player_guid = ${sqlLiteral(input.player_guid)};
    `);
    return this.getRelationship(input);
  }

  async searchMemories(input) {
    await this.ensureReady();
    const limit = Math.min(12, Math.max(1, asInt(input.limit) || 5));
    const clauses = ["superseded_by IS NULL"];
    if (!input.include_expired) {
      clauses.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    }
    if (input.bot_guid) {
      clauses.push(`bot_guid = ${sqlLiteral(asInt(input.bot_guid))}`);
    }
    if (Array.isArray(input.kinds) && input.kinds.length > 0) {
      const kinds = input.kinds.filter((kind) => MEMORY_KINDS.has(kind)).map(sqlLiteral).join(", ");
      if (kinds) {
        clauses.push(`kind IN (${kinds})`);
      }
    }
    const scopeParts = [];
    if (input.player_guid) {
      scopeParts.push(`player_guid = ${sqlLiteral(asInt(input.player_guid))}`);
    }
    if (input.guild_id) {
      scopeParts.push(`guild_id = ${sqlLiteral(asInt(input.guild_id))}`);
    }
    if (input.party_id) {
      scopeParts.push(`party_id = ${sqlLiteral(input.party_id)}`);
    }
    if (input.scope_type && input.scope_id) {
      scopeParts.push(`(scope_type = ${sqlLiteral(input.scope_type)} AND scope_id = ${sqlLiteral(input.scope_id)})`);
    }
    if (scopeParts.length > 0) {
      clauses.push(`(${scopeParts.join(" OR ")})`);
    }
    const rows = await this.db.query(`
      SELECT memory_id, kind, summary, weight, confidence, last_seen_at,
        ((CASE WHEN player_guid = ${sqlLiteral(asInt(input.player_guid))} THEN 0.30 ELSE 0 END) +
         (CASE WHEN guild_id = ${sqlLiteral(asInt(input.guild_id))} THEN 0.20 ELSE 0 END) +
         (CASE WHEN party_id = ${sqlLiteral(input.party_id)} THEN 0.20 ELSE 0 END) +
         (weight / 20.0) + (confidence / 10.0)) AS score
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY score DESC, weight DESC, last_seen_at DESC
      LIMIT ${limit};
    `);
    return ok({ memories: rows.map(rowToMemory) });
  }

  async writeMemory(input) {
    await this.ensureReady();
    const summary = String(input.summary || "").trim();
    if (summary.length < 20 || summary.length > 500) {
      return fail("invalid_request", "summary must be 20 to 500 characters");
    }
    if (!MEMORY_KINDS.has(input.kind)) {
      return fail("invalid_request", "kind is not allowed");
    }
    const weight = clamp(input.weight, 1, 10, 5);
    const confidence = clamp(input.confidence, 0, 1, 0.7);
    const memoryId = input.memory_id || randomId("mem");
    await this.db.exec(`
      INSERT INTO memories (
        memory_id, bot_guid, player_guid, guild_id, party_id, scope_type, scope_id,
        kind, summary, evidence_event_id, weight, confidence, pinned, expires_at, metadata_json
      ) VALUES (
        ${sqlLiteral(memoryId)}, ${sqlLiteral(asInt(input.bot_guid))}, ${sqlLiteral(asInt(input.player_guid))},
        ${sqlLiteral(asInt(input.guild_id))}, ${sqlLiteral(input.party_id)}, ${sqlLiteral(input.scope_type)},
        ${sqlLiteral(input.scope_id)}, ${sqlLiteral(input.kind)}, ${sqlLiteral(summary)},
        ${sqlLiteral(input.event_id || input.evidence_event_id)}, ${sqlLiteral(weight)}, ${sqlLiteral(confidence)},
        ${sqlLiteral(input.pinned ? 1 : 0)}, ${sqlLiteral(input.expires_at)}, ${sqlLiteral(jsonText(input.metadata, {}))}
      );
    `);
    return ok({ memory_id: memoryId, created: true });
  }

  async recordEvent(input) {
    await this.ensureReady();
    if (!EVENT_KINDS.has(input.event_kind)) {
      return fail("invalid_request", "event_kind is not allowed");
    }
    if (input.channel_type && !CHANNEL_TYPES.has(input.channel_type)) {
      return fail("invalid_request", "channel_type is not allowed");
    }
    const eventId = input.event_id || randomId("evt");
    await this.db.exec(`
      INSERT OR IGNORE INTO event_log (
        event_id, parent_event_id, event_kind, channel_type, scope_type, scope_id,
        bot_guid, player_guid, guild_id, party_id, source, direction, text, intent,
        payload_json, model_json, prompt_chars, output_chars, latency_ms, success,
        error_code, error_message
      ) VALUES (
        ${sqlLiteral(eventId)}, ${sqlLiteral(input.parent_event_id)}, ${sqlLiteral(input.event_kind)},
        ${sqlLiteral(input.channel_type)}, ${sqlLiteral(input.scope_type || "system")},
        ${sqlLiteral(input.scope_id || "system")}, ${sqlLiteral(asInt(input.bot_guid))},
        ${sqlLiteral(asInt(input.player_guid))}, ${sqlLiteral(asInt(input.guild_id))},
        ${sqlLiteral(input.party_id)}, ${sqlLiteral(input.source || "wow-llm-bridge")},
        ${sqlLiteral(input.direction || "internal")}, ${sqlLiteral(input.text)}, ${sqlLiteral(input.intent)},
        ${sqlLiteral(jsonText(input.payload, {}))}, ${sqlLiteral(input.model ? jsonText(input.model, {}) : null)},
        ${sqlLiteral(asInt(input.prompt_chars))}, ${sqlLiteral(asInt(input.output_chars))},
        ${sqlLiteral(asInt(input.latency_ms))}, ${sqlLiteral(input.success === false ? 0 : 1)},
        ${sqlLiteral(input.error_code)}, ${sqlLiteral(input.error_message)}
      );
    `);
    return ok({ event_id: eventId, created: true });
  }

  async getRecentChat(input) {
    await this.ensureReady();
    const limit = Math.min(25, Math.max(1, asInt(input.limit) || 10));
    const rows = await this.db.query(`
      SELECT e.event_id, e.created_at, e.direction, e.player_guid, e.bot_guid,
             e.text, e.payload_json, p.name AS player_name, b.name AS bot_name
      FROM event_log e
      LEFT JOIN player_profiles p ON p.player_guid = e.player_guid
      LEFT JOIN bot_profiles b ON b.bot_guid = e.bot_guid
      WHERE e.scope_type = ? AND e.scope_id = ? AND e.channel_type = ?
        AND e.event_kind IN ('chat_in', 'chat_out')
      ORDER BY e.created_at DESC
      LIMIT ${limit};
    `, [input.scope_type, input.scope_id, input.channel_type]);
    return ok({
      events: rows.reverse().map((row) => {
        const payload = parseJson(row.payload_json, {});
        const speakerName = payload.speaker_name ||
          payload.bot_name ||
          payload.player_name ||
          row.bot_name ||
          row.player_name ||
          row.direction;
        return {
          event_id: row.event_id,
          created_at: row.created_at,
          direction: row.direction,
          player_guid: asInt(row.player_guid),
          bot_guid: asInt(row.bot_guid),
          speaker_name: speakerName,
          text: String(row.text || "").slice(0, 500)
        };
      })
    });
  }

  async writeConversationSummary(input) {
    await this.ensureReady();
    const summaryId = input.summary_id || randomId("sum");
    await this.db.exec(`
      INSERT INTO conversation_summaries (
        summary_id, scope_type, scope_id, bot_guid, player_guid, guild_id, party_id,
        channel_type, summary, start_event_id, end_event_id, event_count,
        token_estimate, last_event_at, metadata_json
      ) VALUES (
        ${sqlLiteral(summaryId)}, ${sqlLiteral(input.scope_type)}, ${sqlLiteral(input.scope_id)},
        ${sqlLiteral(asInt(input.bot_guid))}, ${sqlLiteral(asInt(input.player_guid))},
        ${sqlLiteral(asInt(input.guild_id))}, ${sqlLiteral(input.party_id)},
        ${sqlLiteral(input.channel_type)}, ${sqlLiteral(input.summary)},
        ${sqlLiteral(input.start_event_id)}, ${sqlLiteral(input.end_event_id)},
        ${sqlLiteral(asInt(input.event_count) || 0)}, ${sqlLiteral(asInt(input.token_estimate) || 0)},
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${sqlLiteral(jsonText(input.metadata, {}))}
      );
    `);
    return ok({ summary_id: summaryId, created: true });
  }
}

module.exports = {
  MemoryStore,
  CHANNEL_TYPES,
  MEMORY_KINDS,
  EVENT_KINDS,
  INTENTS,
  ok,
  fail,
  randomId,
  asInt
};
