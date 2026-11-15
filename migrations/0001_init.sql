CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('days', 'times')),
  tz            TEXT NOT NULL,
  dates         TEXT NOT NULL,              -- JSON array of YYYY-MM-DD, sorted
  start_min     INTEGER,                    -- kind = 'times' only: minutes after midnight
  end_min       INTEGER,
  slot_min      INTEGER,
  domains       TEXT NOT NULL DEFAULT '[]', -- JSON array of Google Workspace domains; empty = anyone
  allow_guests  INTEGER NOT NULL DEFAULT 0,
  hide_results  INTEGER NOT NULL DEFAULT 0,
  owner_sub     TEXT NOT NULL,
  owner_name    TEXT NOT NULL,
  owner_email   TEXT NOT NULL,
  owner_picture TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX events_owner ON events (owner_sub, created_at DESC);

CREATE TABLE responses (
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_key   TEXT NOT NULL,                 -- 'u:<google sub>' or 'g:<hash of guest token>'
  rid        TEXT NOT NULL,                 -- opaque per-response id that is safe to show other participants
  name       TEXT NOT NULL,
  email      TEXT,
  picture    TEXT,
  slots      TEXT NOT NULL,                 -- one '0'/'1' per slot, in grid order
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_key)
);

CREATE INDEX responses_user ON responses (user_key);
