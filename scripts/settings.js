import { MODULE_ID, ROLES, SETTINGS } from "./constants.js";
import { HubSettingsMenu } from "./apps/hub-settings-menu.js";

/** Register all world settings and the configuration menu. Called during init. */
export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "config", {
    name: "CHARHUB.Menu.Name",
    label: "CHARHUB.Menu.Label",
    hint: "CHARHUB.Menu.Hint",
    icon: "fa-solid fa-tower-broadcast",
    type: HubSettingsMenu,
    restricted: true
  });

  // All settings are edited through the menu above, so none show in the main settings list.
  game.settings.register(MODULE_ID, SETTINGS.WORLD_ROLE, {
    scope: "world",
    config: false,
    type: String,
    choices: {
      [ROLES.UNSET]: "CHARHUB.Role.unset",
      [ROLES.HOME]: "CHARHUB.Role.home",
      [ROLES.HUB]: "CHARHUB.Role.hub"
    },
    default: ROLES.UNSET
  });

  game.settings.register(MODULE_ID, SETTINGS.HOME_WORLD_ID, {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.WORKER_URL, {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.API_KEY, {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.HOME_API_KEY, {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  // { lastSyncAt, actors: { [actorId]: { version, syncedAt, sourceTime } } }
  game.settings.register(MODULE_ID, SETTINGS.SYNC_STATE, {
    scope: "world",
    config: false,
    type: Object,
    default: { lastSyncAt: null, actors: {} }
  });

  // { sent, version, syncedAt }: `sent` is the player list last sent, as JSON text.
  // Kept apart from syncState so a user-list send and a character push never overwrite each other's record.
  game.settings.register(MODULE_ID, SETTINGS.USERS_STATE, {
    scope: "world",
    config: false,
    type: Object,
    default: { sent: null, version: null, syncedAt: null }
  });
}

/** The key this client should send to the Worker, based on the world's role. */
export function getApiKey() {
  const role = getWorldRole();
  if (role === ROLES.HOME) return getSetting(SETTINGS.HOME_API_KEY);
  if (role === ROLES.HUB) return getSetting(SETTINGS.API_KEY);
  return "";
}

/**
 * Save the key where its role keeps it. A home key never goes into the shared world setting,
 * and switching a world to home clears any key left there.
 */
export async function setApiKey(role, key) {
  if (role === ROLES.HOME) {
    await setSetting(SETTINGS.HOME_API_KEY, key);
    if (getSetting(SETTINGS.API_KEY)) await setSetting(SETTINGS.API_KEY, "");
  } else if (role === ROLES.HUB) {
    await setSetting(SETTINGS.API_KEY, key);
  }
}

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function getWorldRole() {
  return getSetting(SETTINGS.WORLD_ROLE);
}

/**
 * Give a home world its permanent ID if it does not have one yet.
 * Only the active GM writes it, so two GMs connecting at once cannot create two IDs.
 */
export async function ensureHomeWorldId() {
  if (getWorldRole() !== ROLES.HOME) return;
  if (getSetting(SETTINGS.HOME_WORLD_ID)) return;
  if (game.user !== game.users.activeGM) return;
  await setSetting(SETTINGS.HOME_WORLD_ID, foundry.utils.randomID(16));
}

/** Accept https URLs, or plain http only for local Worker testing. Returns the cleaned URL or null. */
export function normalizeWorkerUrl(value) {
  const url = String(value ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocal)) return url;
  return null;
}
