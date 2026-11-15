-- Anonymous questionnaire answers live apart from the people who gave them.
--
-- Nothing in this table identifies a person: no user id, name, email or timestamp, and
-- WITHOUT ROWID means rows are stored in key order, not arrival order, so they cannot be
-- lined up against `responses` by position. `key` is HMAC(server secret, event id | user key):
-- the Worker can find a person's own row again when they come back to edit, but the mapping
-- cannot be reversed or recomputed from the database alone.
--
-- A person has up to two rows under unrelated keys: one for their written and multiple-choice
-- answers, one for their map pin. A pin can hint at who someone is, so it is never stored in the
-- same row as what they said.
CREATE TABLE anon_answers (
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  answers  TEXT NOT NULL,
  PRIMARY KEY (event_id, key)
) WITHOUT ROWID;

-- Answers recorded against a named row for an anonymous event (pre-release data only) are dropped
-- rather than left linkable.
UPDATE responses SET answers = '{}' WHERE event_id IN (SELECT id FROM events WHERE anon_answers = 1);
