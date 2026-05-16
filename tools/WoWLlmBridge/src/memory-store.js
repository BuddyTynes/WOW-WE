"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { SqliteCliDatabase, sqlLiteral } = require("./sqlite-cli");

const CHANNEL_TYPES = new Set(["guild", "party", "raid", "whisper", "say", "yell", "channel", "world", "system"]);
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
const SOCIAL_FLAG_TYPES = new Set([
  "kos", "disliked", "trusted", "protected", "rival", "owes_favor",
  "owes_revenge", "avoid"
]);
const ACTION_COMMANDS = new Set([
  "attack", "follow", "stay", "flee", "runaway", "max dps",
  "rti skull", "rti cross", "rti cc moon", "rti cc star", "rti cc diamond"
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

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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

function rowToBotGuildInviteDecision(row) {
  if (!row) {
    return null;
  }
  return {
    decision_id: row.decision_id,
    decision: row.decision,
    say: row.say || "",
    likeability: asInt(row.likeability) || 0,
    reason: row.reason || "",
    expires_at: row.expires_at,
    cached: true
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

function rowToSpiceLine(row, exactChance) {
  const exactSafe = asBool(row.exact_safe);
  return {
    line_hash: row.line_hash,
    message: row.message,
    speaker: row.speaker || "",
    channel_type: row.channel_type,
    channel_name: row.channel_name || "",
    event_type: row.event_type,
    quality_score: asInt(row.quality_score) || 0,
    exact_safe: exactSafe,
    allow_exact: exactSafe && Math.random() * 100 < exactChance,
    tags: parseJson(row.tags_json, [])
  };
}

function rowToBotRuntimeState(row) {
  if (!row) {
    return null;
  }
  return {
    bot_guid: asInt(row.bot_guid),
    map_id: asInt(row.map_id),
    zone_id: asInt(row.zone_id),
    area_id: asInt(row.area_id),
    position_x: asFloat(row.position_x),
    position_y: asFloat(row.position_y),
    position_z: asFloat(row.position_z),
    level: asInt(row.level),
    class: row.class,
    race: row.race,
    guild_id: asInt(row.guild_id),
    party_id: row.party_id,
    current_activity: row.current_activity,
    current_goal: row.current_goal,
    combat_state: row.combat_state,
    target_guid: asInt(row.target_guid),
    leader_guid: asInt(row.leader_guid),
    last_snapshot_at: row.last_snapshot_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToPlayerRuntimeSnapshot(row) {
  if (!row) {
    return null;
  }
  return {
    player_guid: asInt(row.player_guid),
    account_id: asInt(row.account_id),
    name: row.name,
    level: asInt(row.level),
    class: row.class,
    race: row.race,
    guild_id: asInt(row.guild_id),
    guild_rank: row.guild_rank,
    map_id: asInt(row.map_id),
    zone_id: asInt(row.zone_id),
    area_id: asInt(row.area_id),
    gear_score: asInt(row.gear_score),
    equipped_summary: parseJson(row.equipped_summary_json, {}),
    last_seen_at: row.last_seen_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToSocialFlag(row) {
  if (!row) {
    return null;
  }
  return {
    flag_id: row.flag_id,
    bot_guid: asInt(row.bot_guid),
    target_player_guid: asInt(row.target_player_guid),
    target_bot_guid: asInt(row.target_bot_guid),
    guild_id: asInt(row.guild_id),
    flag_type: row.flag_type,
    severity: asInt(row.severity),
    reason: row.reason,
    evidence_event_id: row.evidence_event_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToActionPlan(row) {
  if (!row) {
    return null;
  }
  const plan = parseJson(row.plan_json, {});
  return {
    action_plan_id: row.action_plan_id,
    event_id: row.event_id,
    bot_guid: asInt(row.bot_guid),
    speaker_player_guid: asInt(row.speaker_player_guid),
    channel_type: row.channel_type,
    intent: row.intent,
    plan,
    approved: asBool(row.approved),
    rejection_reason: row.rejection_reason,
    confidence: asFloat(row.confidence),
    ttl_ms: asInt(row.ttl_ms),
    created_at: row.created_at
  };
}

class MemoryStore {
  constructor(options = {}) {
    this.db = options.db || new SqliteCliDatabase(options.dbPath || "./data/llm_memory.sqlite3");
    this.migrationsDir = options.migrationsDir || path.join(__dirname, "..", "migrations");
    this.seedsDir = options.seedsDir || path.join(__dirname, "..", "seeds");
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
    await this.importBundledSpiceSeeds();
    this.ready = true;
    this.lastError = null;
  }

  async importBundledSpiceSeeds() {
    let files = [];
    try {
      files = (await fs.promises.readdir(this.seedsDir))
        .filter((file) => /^spice_.*\.seed\.jsonl$/.test(file))
        .sort();
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const file of files) {
      await this.importSpiceSeedFile(path.join(this.seedsDir, file), file);
    }
  }

  async importSpiceSeedFile(seedPath, seedName = path.basename(seedPath)) {
    const seedText = await fs.promises.readFile(seedPath, "utf8");
    const seedHash = sha256(seedText);
    const existing = await this.db.get("SELECT seed_hash FROM spice_chat_seed_imports WHERE seed_hash = ?;", [seedHash]);
    if (existing) {
      return ok({ seed_hash: seedHash, imported: false, line_count: 0 });
    }
    const records = seedText.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const chunks = [];
    for (let i = 0; i < records.length; i += 20) {
      chunks.push(records.slice(i, i + 20));
    }
    for (const chunk of chunks) {
      const values = chunk.map((record) => `(
          ${sqlLiteral(record.line_hash)}, ${sqlLiteral(record.source_hash)}, ${sqlLiteral(record.source_file)},
          ${sqlLiteral(record.source_table)}, ${sqlLiteral(record.source_key)}, ${sqlLiteral(record.message)},
          ${sqlLiteral(record.speaker)}, ${sqlLiteral(record.channel_type)}, ${sqlLiteral(record.channel_name)},
          ${sqlLiteral(record.event_type)}, ${sqlLiteral(asInt(record.event_timestamp))},
          ${sqlLiteral(clamp(record.quality_score, 0, 100, 50))}, ${sqlLiteral(record.exact_safe ? 1 : 0)},
          ${sqlLiteral(jsonText(record.tags, []))}, ${sqlLiteral(jsonText(record.metadata, {}))}
        )`).join(",");
      await this.db.exec(`
        INSERT OR REPLACE INTO spice_chat_lines (
          line_hash, source_hash, source_file, source_table, source_key, message,
          speaker, channel_type, channel_name, event_type, event_timestamp,
          quality_score, exact_safe, tags_json, metadata_json
        ) VALUES ${values};
      `);
    }
    await this.db.exec(`
      INSERT OR IGNORE INTO spice_chat_seed_imports(seed_hash, seed_name, line_count)
      VALUES (${sqlLiteral(seedHash)}, ${sqlLiteral(seedName)}, ${sqlLiteral(records.length)});
    `);
    return ok({ seed_hash: seedHash, imported: true, line_count: records.length });
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
      "SELECT (SELECT COUNT(*) FROM bot_profiles) AS bots, (SELECT COUNT(*) FROM player_profiles) AS players, (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM event_log) AS events, (SELECT COUNT(*) FROM spice_chat_lines) AS spice_lines, (SELECT COUNT(*) FROM bot_action_plans) AS action_plans, (SELECT COUNT(*) FROM bot_action_results) AS action_results;"
    );
    return {
      bots: asInt(row.bots) || 0,
      players: asInt(row.players) || 0,
      memories: asInt(row.memories) || 0,
      events: asInt(row.events) || 0,
      spice_lines: asInt(row.spice_lines) || 0,
      action_plans: asInt(row.action_plans) || 0,
      action_results: asInt(row.action_results) || 0
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

  async decideBotGuildInvite(input) {
    await this.ensureReady();
    const bot = input.bot || {};
    const inviter = input.inviter || {};
    const guild = input.guild || {};
    const botGuid = asInt(bot.guid || bot.bot_guid);
    const inviterGuid = asInt(inviter.guid || inviter.player_guid);
    const guildId = asInt(guild.id || guild.guild_id);

    if (!botGuid || !inviterGuid || !guildId) {
      return fail("invalid_request", "bot.guid, inviter.guid, and guild.id are required");
    }

    const cached = rowToBotGuildInviteDecision(await this.db.get(`
      SELECT *
      FROM bot_guild_invite_decisions
      WHERE bot_guid = ? AND inviter_guid = ? AND guild_id = ?
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ORDER BY updated_at DESC
      LIMIT 1;
    `, [botGuid, inviterGuid, guildId]));
    if (cached) {
      await this.recordEvent({
        event_kind: "system",
        channel_type: "system",
        scope_type: "bot_player",
        scope_id: `bot:${botGuid}/player:${inviterGuid}`,
        bot_guid: botGuid,
        player_guid: inviterGuid,
        guild_id: guildId,
        source: "bot-guild-invite",
        direction: "internal",
        intent: cached.decision,
        text: cached.say,
        payload: { cached: true, likeability: cached.likeability, reason: cached.reason }
      });
      return ok(cached);
    }

    await this.upsertBotProfile({
      bot_guid: botGuid,
      name: bot.name || `Bot ${botGuid}`,
      race: bot.race,
      class: bot.class,
      tier: bot.tier || 2,
      enabled: true,
      metadata: {
        level: asInt(bot.level),
        current_guild_id: asInt(bot.current_guild_id),
        current_guild_name: bot.current_guild_name || ""
      }
    });
    await this.upsertPlayerProfile({
      player_guid: inviterGuid,
      account_id: asInt(inviter.account_id),
      name: inviter.name || `Player ${inviterGuid}`,
      metadata: {
        race: inviter.race,
        class: inviter.class,
        level: asInt(inviter.level)
      }
    });

    const existingRelationship = await this.getRelationship({ bot_guid: botGuid, player_guid: inviterGuid });
    await this.touchRelationship({ bot_guid: botGuid, player_guid: inviterGuid });
    const defaultLikeability = clamp(input.default_likeability, 0, 100, 50);
    const affinity = existingRelationship.ok ? asInt(existingRelationship.data.affinity) : null;
    const likeability = affinity === null
      ? defaultLikeability
      : Math.round((Math.min(100, Math.max(-100, affinity)) + 100) / 2);
    const roll = Math.floor(Math.random() * 100) + 1;
    const accepted = roll <= likeability;
    const decision = accepted ? "accept" : "decline";
    const botName = bot.name || "The bot";
    const guildName = guild.name || "the guild";
    const say = accepted
      ? `Sure, ${guildName} sounds interesting.`
      : `Not right now. Ask me again later.`;
    const ttlSeconds = Math.max(60, Math.min(86400, asInt(input.cache_ttl_seconds) || 3600));
    const decisionId = randomId("bgi");
    const reason = `likeability ${likeability}, roll ${roll}`;

    await this.db.exec(`
      INSERT INTO bot_guild_invite_decisions (
        decision_id, bot_guid, inviter_guid, guild_id, decision, say,
        likeability, reason, expires_at
      ) VALUES (
        ${sqlLiteral(decisionId)}, ${sqlLiteral(botGuid)}, ${sqlLiteral(inviterGuid)},
        ${sqlLiteral(guildId)}, ${sqlLiteral(decision)}, ${sqlLiteral(say)},
        ${sqlLiteral(likeability)}, ${sqlLiteral(reason)},
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${ttlSeconds} seconds')
      );
    `);

    await this.recordEvent({
      event_kind: "system",
      channel_type: "system",
      scope_type: "bot_player",
      scope_id: `bot:${botGuid}/player:${inviterGuid}`,
      bot_guid: botGuid,
      player_guid: inviterGuid,
      guild_id: guildId,
      source: "bot-guild-invite",
      direction: "internal",
      intent: decision,
      text: `${botName} ${accepted ? "accepted" : "declined"} guild invite to ${guildName}.`,
      payload: { cached: false, likeability, roll, reason }
    });

    return ok({
      decision_id: decisionId,
      decision,
      say,
      likeability,
      reason,
      expires_at: null,
      cached: false
    });
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

  async getChatInspiration(input = {}) {
    await this.ensureReady();
    const limit = Math.min(20, Math.max(0, asInt(input.limit) || 6));
    if (limit === 0) {
      return ok({ lines: [] });
    }
    const minQuality = clamp(input.min_quality, 0, 100, 50);
    const exactChance = clamp(input.exact_chance, 0, 100, 15);
    const exactSafeOnly = asBool(input.exact_safe_only);
    const channel = CHANNEL_TYPES.has(input.channel_type) ? input.channel_type : "channel";
    const channels = channel === "world" || channel === "channel"
      ? ["world", "channel"]
      : [channel, "channel", "world"];
    const quotedChannels = channels.map(sqlLiteral).join(",");
    const exactSafeFilter = exactSafeOnly ? "AND exact_safe = 1" : "";
    let rows = await this.db.query(`
      SELECT line_hash, message, speaker, channel_type, channel_name, event_type,
             quality_score, exact_safe, tags_json
      FROM spice_chat_lines
      WHERE quality_score >= ${sqlLiteral(minQuality)}
        AND channel_type IN (${quotedChannels})
        ${exactSafeFilter}
      ORDER BY (quality_score + (abs(random()) % 25)) DESC
      LIMIT ${limit};
    `);
    if (rows.length === 0) {
      rows = await this.db.query(`
        SELECT line_hash, message, speaker, channel_type, channel_name, event_type,
               quality_score, exact_safe, tags_json
        FROM spice_chat_lines
        WHERE quality_score >= ${sqlLiteral(minQuality)}
          ${exactSafeFilter}
        ORDER BY (quality_score + (abs(random()) % 25)) DESC
        LIMIT ${limit};
      `);
    }
    const hashes = rows.map((row) => sqlLiteral(row.line_hash)).join(",");
    if (hashes) {
      await this.db.exec(`
        UPDATE spice_chat_lines
        SET use_count = use_count + 1,
            last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE line_hash IN (${hashes});
      `);
    }
    return ok({ lines: rows.map((row) => rowToSpiceLine(row, exactChance)) });
  }

  async upsertRuntimeSnapshot(input = {}) {
    await this.ensureReady();
    const bots = [];
    if (input.bot) {
      bots.push(input.bot);
    }
    if (Array.isArray(input.bots)) {
      bots.push(...input.bots);
    }
    const players = [];
    if (input.player) {
      players.push(input.player);
    }
    if (input.speaker) {
      players.push(input.speaker);
    }
    if (Array.isArray(input.players)) {
      players.push(...input.players);
    }
    const botResults = [];
    for (const bot of bots) {
      const result = await this.upsertBotRuntimeState({
        ...bot,
        party_id: bot.party_id || input.party_id || input.party?.party_id || input.party?.id,
        leader_guid: bot.leader_guid || input.party?.leader_guid || input.party?.leaderGuid,
        metadata: {
          ...(bot.metadata || {}),
          snapshot_metadata: input.metadata || {}
        }
      });
      if (!result.ok) {
        return result;
      }
      botResults.push(result.data);
    }
    const playerResults = [];
    for (const player of players) {
      const result = await this.upsertPlayerRuntimeSnapshot({
        ...player,
        party_id: player.party_id || input.party_id || input.party?.party_id || input.party?.id,
        metadata: {
          ...(player.metadata || {}),
          snapshot_metadata: input.metadata || {}
        }
      });
      if (!result.ok) {
        return result;
      }
      playerResults.push(result.data);
    }
    if (botResults.length === 0 && playerResults.length === 0) {
      return fail("invalid_request", "at least one bot or player snapshot is required");
    }
    return ok({ bots: botResults, players: playerResults });
  }

  async upsertBotRuntimeState(input) {
    await this.ensureReady();
    const botGuid = asInt(input.bot_guid || input.guid);
    if (!botGuid) {
      return fail("invalid_request", "bot_guid is required");
    }
    if (input.name) {
      await this.upsertBotProfile({
        bot_guid: botGuid,
        name: input.name,
        race: input.race,
        class: input.class,
        tier: input.tier,
        enabled: input.enabled !== false,
        metadata: input.profile_metadata || {}
      });
    }
    const lastSnapshotAt = input.last_snapshot_at || input.last_seen_at || new Date().toISOString();
    await this.db.exec(`
      INSERT OR REPLACE INTO bot_runtime_state (
        bot_guid, map_id, zone_id, area_id, position_x, position_y, position_z,
        level, class, race, guild_id, party_id, current_activity, current_goal,
        combat_state, target_guid, leader_guid, last_snapshot_at, metadata_json
      ) VALUES (
        ${sqlLiteral(botGuid)}, ${sqlLiteral(asInt(input.map_id))}, ${sqlLiteral(asInt(input.zone_id))},
        ${sqlLiteral(asInt(input.area_id))}, ${sqlLiteral(asFloat(input.position_x ?? input.x))},
        ${sqlLiteral(asFloat(input.position_y ?? input.y))}, ${sqlLiteral(asFloat(input.position_z ?? input.z))},
        ${sqlLiteral(asInt(input.level))}, ${sqlLiteral(input.class)}, ${sqlLiteral(input.race)},
        ${sqlLiteral(asInt(input.guild_id))}, ${sqlLiteral(input.party_id)}, ${sqlLiteral(input.current_activity)},
        ${sqlLiteral(input.current_goal)}, ${sqlLiteral(input.combat_state)}, ${sqlLiteral(asInt(input.target_guid))},
        ${sqlLiteral(asInt(input.leader_guid))}, ${sqlLiteral(lastSnapshotAt)},
        ${sqlLiteral(jsonText(input.metadata, {}))}
      );
    `);
    const row = await this.db.get("SELECT * FROM bot_runtime_state WHERE bot_guid = ?;", [botGuid]);
    return ok(rowToBotRuntimeState(row));
  }

  async getBotRuntimeState(input) {
    await this.ensureReady();
    const botGuid = asInt(input.bot_guid || input.guid);
    if (!botGuid) {
      return fail("invalid_request", "bot_guid is required");
    }
    const row = await this.db.get("SELECT * FROM bot_runtime_state WHERE bot_guid = ?;", [botGuid]);
    const state = rowToBotRuntimeState(row);
    return state ? ok(state) : fail("not_found", "Bot runtime state not found");
  }

  async upsertPlayerRuntimeSnapshot(input) {
    await this.ensureReady();
    const playerGuid = asInt(input.player_guid || input.guid);
    if (!playerGuid || !input.name) {
      return fail("invalid_request", "player_guid and name are required");
    }
    await this.upsertPlayerProfile({
      player_guid: playerGuid,
      account_id: asInt(input.account_id),
      name: input.name,
      metadata: input.profile_metadata || {}
    });
    const lastSeenAt = input.last_seen_at || input.last_snapshot_at || new Date().toISOString();
    await this.db.exec(`
      INSERT OR REPLACE INTO player_runtime_snapshots (
        player_guid, account_id, name, level, class, race, guild_id, guild_rank,
        map_id, zone_id, area_id, gear_score, equipped_summary_json, last_seen_at,
        metadata_json
      ) VALUES (
        ${sqlLiteral(playerGuid)}, ${sqlLiteral(asInt(input.account_id))}, ${sqlLiteral(input.name)},
        ${sqlLiteral(asInt(input.level))}, ${sqlLiteral(input.class)}, ${sqlLiteral(input.race)},
        ${sqlLiteral(asInt(input.guild_id))}, ${sqlLiteral(input.guild_rank)},
        ${sqlLiteral(asInt(input.map_id))}, ${sqlLiteral(asInt(input.zone_id))},
        ${sqlLiteral(asInt(input.area_id))}, ${sqlLiteral(asInt(input.gear_score))},
        ${sqlLiteral(jsonText(input.equipped_summary || input.gear_summary, {}))},
        ${sqlLiteral(lastSeenAt)}, ${sqlLiteral(jsonText(input.metadata, {}))}
      );
    `);
    const row = await this.db.get("SELECT * FROM player_runtime_snapshots WHERE player_guid = ?;", [playerGuid]);
    return ok(rowToPlayerRuntimeSnapshot(row));
  }

  async getPlayerRuntimeSnapshot(input) {
    await this.ensureReady();
    const playerGuid = asInt(input.player_guid || input.guid);
    if (!playerGuid) {
      return fail("invalid_request", "player_guid is required");
    }
    const row = await this.db.get("SELECT * FROM player_runtime_snapshots WHERE player_guid = ?;", [playerGuid]);
    const snapshot = rowToPlayerRuntimeSnapshot(row);
    return snapshot ? ok(snapshot) : fail("not_found", "Player runtime snapshot not found");
  }

  async upsertSocialFlag(input) {
    await this.ensureReady();
    const botGuid = asInt(input.bot_guid);
    const flagType = String(input.flag_type || "").trim().toLowerCase();
    const reason = String(input.reason || "").trim();
    if (!botGuid || !SOCIAL_FLAG_TYPES.has(flagType) || reason.length < 3) {
      return fail("invalid_request", "bot_guid, allowed flag_type, and reason are required");
    }
    if (!asInt(input.target_player_guid) && !asInt(input.target_bot_guid) && !asInt(input.guild_id)) {
      return fail("invalid_request", "one target_player_guid, target_bot_guid, or guild_id is required");
    }
    const flagId = input.flag_id || randomId("flag");
    const severity = clamp(input.severity, 1, 10, 5);
    await this.db.exec(`
      INSERT OR REPLACE INTO bot_social_flags (
        flag_id, bot_guid, target_player_guid, target_bot_guid, guild_id, flag_type,
        severity, reason, evidence_event_id, expires_at, metadata_json
      ) VALUES (
        ${sqlLiteral(flagId)}, ${sqlLiteral(botGuid)}, ${sqlLiteral(asInt(input.target_player_guid))},
        ${sqlLiteral(asInt(input.target_bot_guid))}, ${sqlLiteral(asInt(input.guild_id))},
        ${sqlLiteral(flagType)}, ${sqlLiteral(severity)}, ${sqlLiteral(reason.slice(0, 500))},
        ${sqlLiteral(input.evidence_event_id || input.event_id)}, ${sqlLiteral(input.expires_at)},
        ${sqlLiteral(jsonText(input.metadata, {}))}
      );
    `);
    const row = await this.db.get("SELECT * FROM bot_social_flags WHERE flag_id = ?;", [flagId]);
    return ok(rowToSocialFlag(row));
  }

  async getSocialFlags(input = {}) {
    await this.ensureReady();
    const clauses = ["(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"];
    if (input.bot_guid) {
      clauses.push(`bot_guid = ${sqlLiteral(asInt(input.bot_guid))}`);
    }
    if (input.target_player_guid) {
      clauses.push(`target_player_guid = ${sqlLiteral(asInt(input.target_player_guid))}`);
    }
    if (input.target_bot_guid) {
      clauses.push(`target_bot_guid = ${sqlLiteral(asInt(input.target_bot_guid))}`);
    }
    if (input.guild_id) {
      clauses.push(`guild_id = ${sqlLiteral(asInt(input.guild_id))}`);
    }
    if (input.flag_type && SOCIAL_FLAG_TYPES.has(input.flag_type)) {
      clauses.push(`flag_type = ${sqlLiteral(input.flag_type)}`);
    }
    const limit = Math.min(50, Math.max(1, asInt(input.limit) || 12));
    const rows = await this.db.query(`
      SELECT *
      FROM bot_social_flags
      WHERE ${clauses.join(" AND ")}
      ORDER BY severity DESC, updated_at DESC
      LIMIT ${limit};
    `);
    return ok({ flags: rows.map(rowToSocialFlag) });
  }

  async recordActionPlan(input) {
    await this.ensureReady();
    const actionPlanId = input.action_plan_id || randomId("ap");
    const eventId = input.event_id || randomId("evt");
    const botGuid = asInt(input.bot_guid);
    if (!botGuid || !input.intent) {
      return fail("invalid_request", "bot_guid and intent are required");
    }
    const plan = {
      action_plan_id: actionPlanId,
      event_id: eventId,
      bot_guid: botGuid,
      speaker_player_guid: asInt(input.speaker_player_guid),
      channel_type: input.channel_type,
      intent: input.intent,
      say: input.say || "",
      commands: Array.isArray(input.commands) ? input.commands : [],
      approved: Boolean(input.approved),
      rejection_reason: input.rejection_reason || null,
      confidence: clamp(input.confidence, 0, 1, 0),
      ttl_ms: Math.round(clamp(input.ttl_ms, 250, 30000, 4000))
    };
    await this.db.exec(`
      INSERT OR REPLACE INTO bot_action_plans (
        action_plan_id, event_id, bot_guid, speaker_player_guid, channel_type,
        intent, plan_json, approved, rejection_reason, confidence, ttl_ms
      ) VALUES (
        ${sqlLiteral(actionPlanId)}, ${sqlLiteral(eventId)}, ${sqlLiteral(botGuid)},
        ${sqlLiteral(plan.speaker_player_guid)}, ${sqlLiteral(input.channel_type)},
        ${sqlLiteral(plan.intent)}, ${sqlLiteral(jsonText(plan, {}))},
        ${sqlLiteral(plan.approved ? 1 : 0)}, ${sqlLiteral(plan.rejection_reason)},
        ${sqlLiteral(plan.confidence)}, ${sqlLiteral(plan.ttl_ms)}
      );
    `);
    const row = await this.db.get("SELECT * FROM bot_action_plans WHERE action_plan_id = ?;", [actionPlanId]);
    return ok(rowToActionPlan(row));
  }

  async recordActionResult(input) {
    await this.ensureReady();
    const actionPlanId = String(input.action_plan_id || "").trim();
    const botGuid = asInt(input.bot_guid);
    const command = String(input.command || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!actionPlanId || !botGuid || !ACTION_COMMANDS.has(command)) {
      return fail("invalid_request", "action_plan_id, bot_guid, and allowed command are required");
    }
    const resultId = input.action_result_id || randomId("ar");
    await this.db.exec(`
      INSERT INTO bot_action_results (
        action_result_id, action_plan_id, bot_guid, command, success, result_code,
        result_message, metadata_json
      ) VALUES (
        ${sqlLiteral(resultId)}, ${sqlLiteral(actionPlanId)}, ${sqlLiteral(botGuid)},
        ${sqlLiteral(command)}, ${sqlLiteral(input.success === false ? 0 : 1)},
        ${sqlLiteral(input.result_code)}, ${sqlLiteral(input.result_message)},
        ${sqlLiteral(jsonText(input.metadata, {}))}
      );
    `);
    await this.recordEvent({
      parent_event_id: actionPlanId,
      event_kind: "system",
      channel_type: "system",
      scope_type: "action_plan",
      scope_id: actionPlanId,
      bot_guid: botGuid,
      source: "action-director",
      direction: "internal",
      text: input.result_message,
      intent: "action_result",
      success: input.success !== false,
      error_code: input.success === false ? input.result_code || "action_failed" : null,
      error_message: input.success === false ? input.result_message : null,
      payload: { action_result_id: resultId, command }
    });
    return ok({
      action_result_id: resultId,
      action_plan_id: actionPlanId,
      bot_guid: botGuid,
      command,
      success: input.success !== false
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
  SOCIAL_FLAG_TYPES,
  ACTION_COMMANDS,
  ok,
  fail,
  randomId,
  asInt
};
