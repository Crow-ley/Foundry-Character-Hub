import { MODULE_ID, ROLES } from "./constants.js";
import { ensureHomeWorldId, getWorldRole, registerSettings } from "./settings.js";
import { registerHomeSync } from "./home/sync.js";
import { registerHomeSyncUI } from "./home/sync-ui.js";

Hooks.once("init", () => {
  registerSettings();
});

// World settings can be read from setup on, so role-specific hooks are added here.
Hooks.once("setup", () => {
  registerHomeSync();
  registerHomeSyncUI();
});

Hooks.once("ready", async () => {
  await ensureHomeWorldId();

  const role = getWorldRole();
  if (role === ROLES.UNSET && game.user.isGM) {
    ui.notifications.warn("CHARHUB.Notify.RoleUnset", { localize: true });
  }
  console.log(`${MODULE_ID} | Ready. World role: ${role}`);
});
