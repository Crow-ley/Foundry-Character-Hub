import { MODULE_ID, ROLES, SETTINGS } from "../constants.js";
import { getSetting, getWorldRole } from "../settings.js";
import {
  inUseActors, isConfigured, isHomeGM, isInUse, isSyncable, pendingCount, status, syncAll, toggleInUse
} from "./sync.js";

/** "just now", "5 minutes ago", ... in the user's language. */
function timeAgo(iso) {
  if (!iso) return game.i18n.localize("CHARHUB.Status.Never");
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 45) return game.i18n.localize("CHARHUB.Status.JustNow");
  const format = new Intl.RelativeTimeFormat(game.i18n.lang, { numeric: "auto" });
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(seconds, "second");
}

function statusText() {
  const count = inUseActors().length;
  if (!isConfigured()) return { state: "error", text: game.i18n.localize("CHARHUB.Sync.NotConfigured") };
  if (status.state === "error" || status.state === "paused") {
    return { state: status.state, text: game.i18n.format("CHARHUB.Status.Error", { error: status.message }) };
  }
  const last = timeAgo(getSetting(SETTINGS.SYNC_STATE).lastSyncAt);
  const pending = pendingCount();
  if (status.state === "syncing") return { state: "syncing", text: game.i18n.localize("CHARHUB.Status.Syncing") };
  if (pending) return { state: "pending", text: game.i18n.format("CHARHUB.Status.Pending", { count, pending, last }) };
  return { state: "ok", text: game.i18n.format("CHARHUB.Status.Ok", { count, last }) };
}

/** Refresh every status bar on screen (the Actors tab, and its pop-out if open). */
function updateBars() {
  const { state, text } = statusText();
  for (const bar of document.querySelectorAll(".charhub-sync-bar")) {
    bar.className = `charhub-sync-bar state-${state}`;
    const label = bar.querySelector(".charhub-sync-text");
    label.textContent = text;
    label.dataset.tooltip = text;
  }
}

function addSyncBar(html) {
  const header = html.querySelector(".directory-header");
  if (!header || header.querySelector(".charhub-sync-bar")) return;
  const bar = document.createElement("div");
  bar.className = "charhub-sync-bar";
  bar.innerHTML = `<i class="fa-solid fa-tower-broadcast" inert></i>
    <span class="charhub-sync-text"></span>
    <button type="button"><i class="fa-solid fa-arrows-rotate" inert></i> ${game.i18n.localize("CHARHUB.Sync.AllButton")}</button>`;
  const button = bar.querySelector("button");
  button.addEventListener("click", async event => {
    event.preventDefault();
    button.disabled = true;
    try {
      await syncAll();
    } finally {
      button.disabled = false;
    }
  });
  header.append(bar);
}

function addInUseMarkers(html) {
  const label = game.i18n.localize("CHARHUB.InUse.Marker");
  for (const li of html.querySelectorAll(".directory-item[data-entry-id]")) {
    if (li.querySelector(".charhub-in-use")) continue;
    const actor = game.actors.get(li.dataset.entryId);
    if (!isSyncable(actor) || !isInUse(actor)) continue;
    const icon = document.createElement("i");
    icon.className = "charhub-in-use fa-solid fa-tower-broadcast";
    icon.dataset.tooltip = label;
    icon.setAttribute("aria-label", label);
    li.append(icon);
  }
}

export function registerHomeSyncUI() {
  if (getWorldRole() !== ROLES.HOME) return;

  // "In use" toggle in the character sheet's header menu. Works with any ApplicationV2 actor sheet.
  Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
    const actor = app.document;
    if (!isHomeGM() || !isSyncable(actor)) return;
    const inUse = isInUse(actor);
    controls.push({
      action: `${MODULE_ID}-toggle-in-use`,
      icon: inUse ? "fa-solid fa-tower-broadcast" : "fa-regular fa-circle",
      label: inUse ? "CHARHUB.InUse.Stop" : "CHARHUB.InUse.Start",
      onClick: () => toggleInUse(actor)
    });
  });

  Hooks.on("renderActorDirectory", (app, html) => {
    if (!isHomeGM()) return;
    const root = html instanceof HTMLElement ? html : html[0];
    addSyncBar(root);
    addInUseMarkers(root);
    updateBars();
  });

  // Turning a character's flag on or off changes its marker and the count.
  Hooks.on("updateActor", (actor, changes) => {
    if (!isHomeGM() || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
    ui.actors?.render();
  });
  Hooks.on(`${MODULE_ID}.syncStatus`, updateBars);
  Hooks.on("updateSetting", setting => {
    if (setting.key === `${MODULE_ID}.${SETTINGS.SYNC_STATE}`) updateBars();
  });
  // Keep "5 minutes ago" current.
  Hooks.once("ready", () => setInterval(updateBars, 60_000));
}
