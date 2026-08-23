-- Advisory edit lock: an agent editing over MCP announces itself so the published
-- page and the builder can warn. Expiry is computed at read time from lock_at.
ALTER TABLE projects ADD COLUMN lock_holder TEXT;
ALTER TABLE projects ADD COLUMN lock_note TEXT;
ALTER TABLE projects ADD COLUMN lock_at INTEGER;
