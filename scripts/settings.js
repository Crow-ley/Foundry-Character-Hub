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
