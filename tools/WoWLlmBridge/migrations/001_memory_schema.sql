CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS bot_profiles (
  bot_guid INTEGER PRIMARY KEY,
  bot_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  race TEXT,
  class TEXT,
  gender TEXT,
  tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 4),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  temperament TEXT,
  speech_style TEXT,
  personality_seed TEXT NOT NULL DEFAULT '',
  likes_json TEXT NOT NULL DEFAULT '[]',
  dislikes_json TEXT NOT NULL DEFAULT '[]',
  boundaries_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS player_profiles (
  player_guid INTEGER PRIMARY KEY,
  account_id INTEGER,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  known_facts_json TEXT NOT NULL DEFAULT '{}',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bot_player_relationships (
  bot_guid INTEGER NOT NULL,
  player_guid INTEGER NOT NULL,
  relationship_summary TEXT NOT NULL DEFAULT '',
  affinity INTEGER NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -100 AND 100),
  trust INTEGER NOT NULL DEFAULT 0 CHECK (trust BETWEEN -100 AND 100),
  familiarity INTEGER NOT NULL DEFAULT 0 CHECK (familiarity BETWEEN 0 AND 100),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (bot_guid, player_guid),
  FOREIGN KEY (bot_guid) REFERENCES bot_profiles(bot_guid) ON DELETE CASCADE,
  FOREIGN KEY (player_guid) REFERENCES player_profiles(player_guid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  bot_guid INTEGER NOT NULL,
  player_guid INTEGER,
  guild_id INTEGER,
  party_id TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_event_id TEXT,
  weight INTEGER NOT NULL DEFAULT 5 CHECK (weight BETWEEN 1 AND 10),
  confidence REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  superseded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (bot_guid) REFERENCES bot_profiles(bot_guid) ON DELETE CASCADE,
  FOREIGN KEY (player_guid) REFERENCES player_profiles(player_guid) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  summary_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bot_guid INTEGER,
  player_guid INTEGER,
  guild_id INTEGER,
  party_id TEXT,
  channel_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_event_id TEXT,
  end_event_id TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_event_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS event_log (
  event_id TEXT PRIMARY KEY,
  parent_event_id TEXT,
  event_kind TEXT NOT NULL,
  channel_type TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bot_guid INTEGER,
  player_guid INTEGER,
  guild_id INTEGER,
  party_id TEXT,
  source TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'internal')),
  text TEXT,
  intent TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  model_json TEXT,
  prompt_chars INTEGER,
  output_chars INTEGER,
  latency_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tool_audit_log (
  audit_id TEXT PRIMARY KEY,
  event_id TEXT,
  caller TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  bot_guid INTEGER,
  player_guid INTEGER,
  request_json TEXT NOT NULL DEFAULT '{}',
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  row_count INTEGER,
  latency_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_profiles_enabled_tier ON bot_profiles(enabled, tier, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_player_profiles_account ON player_profiles(account_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_player_profiles_name ON player_profiles(normalized_name);
CREATE INDEX IF NOT EXISTS idx_relationships_player ON bot_player_relationships(player_guid, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_relationships_bot_seen ON bot_player_relationships(bot_guid, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_memories_bot_player_seen ON memories(bot_guid, player_guid, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_scope_seen ON memories(scope_type, scope_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_guild_seen ON memories(guild_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_party_seen ON memories(party_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_weight_seen ON memories(weight DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, bot_guid, player_guid);
CREATE INDEX IF NOT EXISTS idx_summaries_scope_event ON conversation_summaries(scope_type, scope_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_guild ON conversation_summaries(guild_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_party ON conversation_summaries(party_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_scope_created ON event_log(scope_type, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_bot_created ON event_log(bot_guid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_player_created ON event_log(player_guid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_guild_created ON event_log(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_party_created ON event_log(party_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_kind_created ON event_log(event_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_event ON tool_audit_log(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_tool_created ON tool_audit_log(tool_name, created_at DESC);

CREATE VIEW IF NOT EXISTS v_llm_bot_profiles AS
SELECT bot_guid, bot_key, name, race, class, tier, enabled, last_seen_at FROM bot_profiles;

CREATE VIEW IF NOT EXISTS v_llm_player_profiles AS
SELECT player_guid, account_id, name, first_seen_at, last_seen_at FROM player_profiles;

CREATE VIEW IF NOT EXISTS v_llm_relationships AS
SELECT bot_guid, player_guid, affinity, trust, familiarity, interaction_count, last_seen_at
FROM bot_player_relationships;

CREATE VIEW IF NOT EXISTS v_llm_memories AS
SELECT memory_id, bot_guid, player_guid, guild_id, party_id, scope_type, scope_id, kind,
       summary, weight, confidence, pinned, last_seen_at, expires_at
FROM memories
WHERE superseded_by IS NULL;

CREATE VIEW IF NOT EXISTS v_llm_recent_events AS
SELECT event_id, event_kind, channel_type, scope_type, scope_id, bot_guid, player_guid,
       guild_id, party_id, direction, intent, success, error_code, created_at
FROM event_log;

CREATE VIEW IF NOT EXISTS v_llm_conversation_summaries AS
SELECT summary_id, scope_type, scope_id, bot_guid, player_guid, guild_id, party_id,
       channel_type, summary, event_count, last_event_at
FROM conversation_summaries;

INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (1, 'memory_schema');
