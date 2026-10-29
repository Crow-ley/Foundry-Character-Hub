import { MODULE_ID, ROLES } from "./constants.js";
import { ensureHomeWorldId, getWorldRole, registerSettings } from "./settings.js";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", async () => {
  await ensureHomeWorldId();

  const role = getWorldRole();
  if (role === ROLES.UNSET && game.user.isGM) {
    ui.notifications.warn("CHARHUB.Notify.RoleUnset", { localize: true });
  }
  console.log(`${MODULE_ID} | Ready. World role: ${role}`);
});
