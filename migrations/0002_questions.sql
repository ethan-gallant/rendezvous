-- Optional follow-up questionnaire shown after someone has given their availability.
ALTER TABLE events ADD COLUMN questions TEXT NOT NULL DEFAULT '[]';        -- JSON [{ id, type, prompt, options? }]
ALTER TABLE events ADD COLUMN anon_answers INTEGER NOT NULL DEFAULT 1;     -- 1 = organizer sees totals, not names
ALTER TABLE responses ADD COLUMN answers TEXT NOT NULL DEFAULT '{}';       -- JSON { questionId: index | [indexes] | text }
