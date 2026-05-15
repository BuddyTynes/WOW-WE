CREATE TABLE IF NOT EXISTS spice_chat_lines (
  line_hash TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  message TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT '',
  channel_type TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  event_timestamp INTEGER,
  quality_score INTEGER NOT NULL DEFAULT 50 CHECK (quality_score BETWEEN 0 AND 100),
  exact_safe INTEGER NOT NULL DEFAULT 0 CHECK (exact_safe IN (0, 1)),
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS spice_chat_seed_imports (
  seed_hash TEXT PRIMARY KEY,
  seed_name TEXT NOT NULL,
  line_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_spice_chat_channel_quality
  ON spice_chat_lines(channel_type, quality_score DESC, exact_safe);

CREATE INDEX IF NOT EXISTS idx_spice_chat_quality
  ON spice_chat_lines(quality_score DESC, exact_safe);

INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (3, 'spice_chat_pool');
