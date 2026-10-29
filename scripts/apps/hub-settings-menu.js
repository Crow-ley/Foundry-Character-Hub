import { MODULE_ID, ROLES, SETTINGS } from "../constants.js";
import { ensureHomeWorldId, getApiKey, getSetting, normalizeWorkerUrl, setApiKey, setSetting } from "../settings.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM-only window for the world role, Worker URL, and API key. */
export class HubSettingsMenu extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-config`,
    tag: "form",
    classes: [MODULE_ID],
    window: {
      title: "CHARHUB.Menu.Title",
      icon: "fa-solid fa-tower-broadcast",
      contentClasses: ["standard-form"]
    },
    position: { width: 520 },
    form: {
      handler: HubSettingsMenu.#onSubmit,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings-menu.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const role = getSetting(SETTINGS.WORLD_ROLE);
    const roleHints = {
      [ROLES.UNSET]: "CHARHUB.Role.UnsetHint",
      [ROLES.HOME]: "CHARHUB.Role.HomeHint",
      [ROLES.HUB]: "CHARHUB.Role.HubHint"
    };
    return Object.assign(context, {
      role,
      roleLabel: `CHARHUB.Role.${role}`,
      roleHint: roleHints[role],
      roleChoices: {
        [ROLES.UNSET]: "CHARHUB.Role.unset",
        [ROLES.HOME]: "CHARHUB.Role.home",
        [ROLES.HUB]: "CHARHUB.Role.hub"
      },
      homeWorldId: getSetting(SETTINGS.HOME_WORLD_ID),
      workerUrl: getSetting(SETTINGS.WORKER_URL),
      apiKey: getApiKey(),
      apiKeyHint: role === ROLES.HOME ? "CHARHUB.Settings.ApiKeyHintHome" : "CHARHUB.Settings.ApiKeyHint",
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "CHARHUB.Menu.Save" }]
    });
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const workerUrl = normalizeWorkerUrl(data.workerUrl);
    if (workerUrl === null) {
      ui.notifications.error("CHARHUB.Notify.BadWorkerUrl", { localize: true });
      throw new Error("Invalid Worker URL");
    }

    const oldRole = getSetting(SETTINGS.WORLD_ROLE);
    const newRole = Object.values(ROLES).includes(data.role) ? data.role : ROLES.UNSET;

    await setSetting(SETTINGS.WORKER_URL, workerUrl);
    await setApiKey(newRole, String(data.apiKey ?? "").trim());
    await setSetting(SETTINGS.WORLD_ROLE, newRole);
    await ensureHomeWorldId();
    ui.notifications.info("CHARHUB.Notify.Saved", { localize: true });

    // Each role sets up different hooks at startup, so a role change needs a reload.
    if (newRole !== oldRole) {
      const SettingsConfig = foundry.applications.settings?.SettingsConfig ?? globalThis.SettingsConfig;
      await SettingsConfig?.reloadConfirm?.({ world: true });
    }
  }
}
