CREATE TABLE IF NOT EXISTS bot_guild_invite_decisions (
  decision_id TEXT PRIMARY KEY,
  bot_guid INTEGER NOT NULL,
  inviter_guid INTEGER NOT NULL,
  guild_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'decline')),
  say TEXT NOT NULL DEFAULT '',
  likeability INTEGER NOT NULL DEFAULT 50 CHECK (likeability BETWEEN 0 AND 100),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_guild_invite_cache
  ON bot_guild_invite_decisions(bot_guid, inviter_guid, guild_id, expires_at);

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (2, 'bot_guild_invites');
