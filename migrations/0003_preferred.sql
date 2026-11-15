-- Dates the organizer would prefer, shown to participants while they answer. JSON array, subset of events.dates.
ALTER TABLE events ADD COLUMN preferred TEXT NOT NULL DEFAULT '[]';
