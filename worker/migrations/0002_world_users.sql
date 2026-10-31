-- Each home world's player list (Foundry user id and name), so a website can let players pick
-- their Foundry user. One row per world: the whole list is replaced on every push.
-- GM and assistant GM users are never sent.
CREATE TABLE world_users (
  home_world_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  users TEXT NOT NULL
);
