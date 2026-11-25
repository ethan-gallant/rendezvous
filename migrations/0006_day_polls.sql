-- Lock: the organizer can freeze availability, so the set of respondents stops changing.
-- Existing events start unlocked.
ALTER TABLE events ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- Day polls: a follow-up question about one candidate day ("Co-work day?", "Drinks + dinner?"),
-- answered only by the people who are free that day. Existing events simply have none.
CREATE TABLE day_polls (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  day        TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  options    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX day_polls_event ON day_polls (event_id, created_at);

-- One row per person per poll. Unlike questionnaire answers these are named on purpose: the
-- organizer is counting heads. No timestamps are kept.
CREATE TABLE day_poll_votes (
  poll_id  TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  choice   INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_key)
) WITHOUT ROWID;
CREATE INDEX day_poll_votes_event ON day_poll_votes (event_id, user_key);
