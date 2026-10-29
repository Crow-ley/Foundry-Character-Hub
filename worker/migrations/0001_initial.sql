-- Worlds that may use this Worker. Keys are stored only as SHA-256 hashes.
CREATE TABLE worlds (
  world_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('home', 'hub')),
  name TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  key_rotated_at TEXT
);

-- One row per character. `data` is the full actor.toObject() JSON, stored as sent.
CREATE TABLE snapshots (
  home_world_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  system_version TEXT,
  actor_name TEXT,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (home_world_id, actor_id)
);

CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('update', 'create')),
  home_world_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  submitted_by TEXT,
  submitted_by_id TEXT,
  submitted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'partial')),
  diff TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT
);

CREATE INDEX change_requests_world_status ON change_requests (home_world_id, status);
CREATE INDEX change_requests_actor ON change_requests (home_world_id, actor_id);
