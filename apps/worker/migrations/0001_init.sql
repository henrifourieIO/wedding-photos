CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  host_sub TEXT NOT NULL,
  name TEXT NOT NULL,
  starts_at TEXT,
  cover_key TEXT,
  join_code TEXT NOT NULL UNIQUE,
  reveal_mode TEXT NOT NULL DEFAULT 'instant',
  reveal_at TEXT,
  video_max_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE guests (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  cookie_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  r2_key TEXT,
  stream_uid TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  hidden INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  duration_s REAL,
  taken_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_join_code ON events(join_code);
CREATE INDEX idx_media_event_gallery ON media(event_id, status, hidden, created_at);
