-- Day polls can ask people to rank the choices instead of picking one.
-- Existing polls stay 'pick'; a ranked answer is a JSON list of choice indexes, favourite first.
ALTER TABLE day_polls ADD COLUMN kind TEXT NOT NULL DEFAULT 'pick';
ALTER TABLE day_poll_votes ADD COLUMN ranking TEXT;
