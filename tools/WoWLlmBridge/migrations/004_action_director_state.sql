CREATE TABLE IF NOT EXISTS bot_runtime_state (
  bot_guid INTEGER PRIMARY KEY,
  map_id INTEGER,
  zone_id INTEGER,
  area_id INTEGER,
  position_x REAL,
  position_y REAL,
  position_z REAL,
  level INTEGER,
  class TEXT,
  race TEXT,
  guild_id INTEGER,
  party_id TEXT,
  current_activity TEXT,
  current_goal TEXT,
  combat_state TEXT,
  target_guid INTEGER,
  leader_guid INTEGER,
  last_snapshot_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS player_runtime_snapshots (
  player_guid INTEGER PRIMARY KEY,
  account_id INTEGER,
  name TEXT NOT NULL,
  level INTEGER,
  class TEXT,
  race TEXT,
  guild_id INTEGER,
  guild_rank TEXT,
  map_id INTEGER,
  zone_id INTEGER,
  area_id INTEGER,
  gear_score INTEGER,
  equipped_summary_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bot_social_flags (
  flag_id TEXT PRIMARY KEY,
  bot_guid INTEGER NOT NULL,
  target_player_guid INTEGER,
  target_bot_guid INTEGER,
  guild_id INTEGER,
  flag_type TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 5 CHECK (severity BETWEEN 1 AND 10),
  reason TEXT NOT NULL,
  evidence_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bot_action_plans (
  action_plan_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  bot_guid INTEGER NOT NULL,
  speaker_player_guid INTEGER,
  channel_type TEXT,
  intent TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  rejection_reason TEXT,
  confidence REAL NOT NULL DEFAULT 0.0,
  ttl_ms INTEGER NOT NULL DEFAULT 4000,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS bot_action_results (
  action_result_id TEXT PRIMARY KEY,
  action_plan_id TEXT NOT NULL,
  bot_guid INTEGER NOT NULL,
  command TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  result_code TEXT,
  result_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bot_runtime_state_party ON bot_runtime_state(party_id, last_snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_runtime_state_activity ON bot_runtime_state(current_activity, combat_state, last_snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_runtime_snapshots_guild ON player_runtime_snapshots(guild_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_social_flags_bot_type ON bot_social_flags(bot_guid, flag_type, severity DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_social_flags_player ON bot_social_flags(target_player_guid, flag_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_action_plans_event ON bot_action_plans(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_action_plans_bot_created ON bot_action_plans(bot_guid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_action_results_plan ON bot_action_results(action_plan_id, created_at DESC);

CREATE VIEW IF NOT EXISTS v_llm_bot_runtime_state AS
SELECT bot_guid, map_id, zone_id, area_id, level, class, race, guild_id, party_id,
       current_activity, current_goal, combat_state, target_guid, leader_guid,
       last_snapshot_at
FROM bot_runtime_state;

CREATE VIEW IF NOT EXISTS v_llm_player_runtime_snapshots AS
SELECT player_guid, account_id, name, level, class, race, guild_id, guild_rank,
       map_id, zone_id, area_id, gear_score, last_seen_at
FROM player_runtime_snapshots;

CREATE VIEW IF NOT EXISTS v_llm_bot_social_flags AS
SELECT flag_id, bot_guid, target_player_guid, target_bot_guid, guild_id, flag_type,
       severity, reason, evidence_event_id, updated_at, expires_at
FROM bot_social_flags;

CREATE VIEW IF NOT EXISTS v_llm_bot_action_plans AS
SELECT action_plan_id, event_id, bot_guid, speaker_player_guid, channel_type, intent,
       approved, rejection_reason, confidence, ttl_ms, created_at
FROM bot_action_plans;

INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (4, 'action_director_state');
