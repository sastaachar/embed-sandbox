-- Design-time connection to the cluster. The secret lives here, never in
-- projects.config, because config is public and is inlined into every page.
ALTER TABLE projects ADD COLUMN conn_host TEXT;
ALTER TABLE projects ADD COLUMN conn_username TEXT;
ALTER TABLE projects ADD COLUMN conn_secret TEXT;
ALTER TABLE projects ADD COLUMN conn_secret_type TEXT;
ALTER TABLE projects ADD COLUMN conn_verified_at INTEGER;
