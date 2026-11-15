-- Retention: every event carries the date it will be deleted, fixed when it is created.
ALTER TABLE events ADD COLUMN expires_at INTEGER;
-- Events created before this column existed get the default: 60 days after their last candidate day.
UPDATE events
   SET expires_at = (CAST(strftime('%s', json_extract(dates, '$[#-1]')) AS INTEGER) + 86400 * 61) * 1000
 WHERE expires_at IS NULL;
CREATE INDEX events_expires ON events (expires_at);

-- Batched release of anonymous answers.
--
-- The organizer never reads anon_answers live. They read events.survey_release, a summary that is
-- only rebuilt when at least a batch of rows are `pending` (new or changed since the last rebuild).
-- That way one person's answers never show up as a visible change on their own.
ALTER TABLE events ADD COLUMN survey_release TEXT;
-- 'a' = written and multiple-choice answers, 'm' = map pin. The two are batched separately.
ALTER TABLE anon_answers ADD COLUMN part TEXT NOT NULL DEFAULT 'a';
ALTER TABLE anon_answers ADD COLUMN pending INTEGER NOT NULL DEFAULT 1;

-- Pre-release rows were keyed with the session secret, which no longer keys answers (ANON_SECRET
-- does), so they could never be matched to their owner again.
DELETE FROM anon_answers;
