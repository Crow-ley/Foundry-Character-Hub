import { MODULE_ID, ROLES, SETTINGS } from "../constants.js";
import { HubApiError, WorkerClient } from "../api.js";
import { ensureHomeWorldId, getApiKey, getSetting, normalizeWorkerUrl, setApiKey, setSetting } from "../settings.js";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

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
    },
    actions: {
      registerWorld: HubSettingsMenu.#onRegisterWorld,
      testConnection: HubSettingsMenu.#onTestConnection
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
      hasRole: role !== ROLES.UNSET,
      homeWorldId: getSetting(SETTINGS.HOME_WORLD_ID),
      workerUrl: getSetting(SETTINGS.WORKER_URL),
      apiKey: getApiKey(),
      apiKeyHint: role === ROLES.HOME ? "CHARHUB.Settings.ApiKeyHintHome" : "CHARHUB.Settings.ApiKeyHint",
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "CHARHUB.Menu.Save" }]
    });
  }

  /** The Worker URL as currently typed, checked. Shows an error and returns null if invalid. */
  #formWorkerUrl() {
    const url = normalizeWorkerUrl(this.element.querySelector("[name=workerUrl]")?.value);
    if (!url) {
      ui.notifications.error("CHARHUB.Notify.BadWorkerUrl", { localize: true });
      return null;
    }
    return url;
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

  /**
   * Ask for the admin key, register this world with the Worker, and save the key it returns.
   * The admin key is used for this one request and never stored.
   */
  static async #onRegisterWorld() {
    const role = getSetting(SETTINGS.WORLD_ROLE);
    const url = this.#formWorkerUrl();
    if (!url) return;
    await ensureHomeWorldId();
    const worldId = role === ROLES.HOME ? getSetting(SETTINGS.HOME_WORLD_ID) : "hub";
    if (!worldId) return ui.notifications.error("CHARHUB.Error.NoHomeWorldId", { localize: true });

    const adminKey = await DialogV2.prompt({
      window: { title: "CHARHUB.Register.Title", icon: "fa-solid fa-key" },
      content: `<p>${game.i18n.localize("CHARHUB.Register.Explain")}</p>
        <p class="hint">${game.i18n.localize("CHARHUB.Register.Rotate")}</p>
        <div class="form-group">
          <label>${game.i18n.localize("CHARHUB.Register.AdminKey")}</label>
          <div class="form-fields"><input type="password" name="adminKey" autocomplete="off" autofocus></div>
        </div>`,
      ok: {
        label: "CHARHUB.Register.Confirm",
        icon: "fa-solid fa-key",
        callback: (event, button) => button.form.elements.adminKey.value.trim()
      },
      rejectClose: false
    });
    if (!adminKey) return;

    try {
      const result = await new WorkerClient({ url }).request("POST", "/v1/worlds", {
        key: adminKey,
        json: { role, worldId, name: game.world.title }
      });
      await setSetting(SETTINGS.WORKER_URL, url);
      await setApiKey(role, result.key);
      ui.notifications.info(game.i18n.format("CHARHUB.Register.Done", { world: game.world.title }));
      this.render();
    } catch (err) {
      ui.notifications.error(game.i18n.format("CHARHUB.Register.Failed", { error: err.message }));
    }
  }

  /** Check the typed URL and key against the Worker without saving them. */
  static async #onTestConnection() {
    const url = this.#formWorkerUrl();
    if (!url) return;
    const key = this.element.querySelector("[name=apiKey]")?.value.trim();
    try {
      const me = await new WorkerClient({ url, key }).request("GET", "/v1/me");
      const role = getSetting(SETTINGS.WORLD_ROLE);
      const expectedId = role === ROLES.HOME ? getSetting(SETTINGS.HOME_WORLD_ID) : null;
      if (me.role !== role || (expectedId && me.worldId !== expectedId)) {
        ui.notifications.warn(game.i18n.format("CHARHUB.Test.Mismatch", { role: me.role, worldId: me.worldId }));
      } else {
        ui.notifications.info(game.i18n.format("CHARHUB.Test.Ok", { role: me.role, worldId: me.worldId }));
      }
    } catch (err) {
      const message = err instanceof HubApiError ? err.message : String(err);
      ui.notifications.error(game.i18n.format("CHARHUB.Test.Failed", { error: message }));
    }
  }
}
