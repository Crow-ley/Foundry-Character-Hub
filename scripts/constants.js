export const MODULE_ID = "character-hub";

/** Bumped whenever the shape of snapshots or change requests changes. */
export const SCHEMA_VERSION = 1;

export const ROLES = Object.freeze({
  UNSET: "unset",
  HOME: "home",
  HUB: "hub"
});

export const SETTINGS = Object.freeze({
  WORLD_ROLE: "worldRole",
  HOME_WORLD_ID: "homeWorldId",
  WORKER_URL: "workerUrl",
  API_KEY: "apiKey"
});
