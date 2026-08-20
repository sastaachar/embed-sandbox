CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  config          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  project_id      TEXT NOT NULL,
  path            TEXT NOT NULL,
  config          TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (project_id, path),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_project ON pages (project_id, path);
