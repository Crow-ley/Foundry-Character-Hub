import { FLAGS, MODULE_ID, PUSH_DELAY_MS, ROLES, SCHEMA_VERSION, SETTINGS } from "../constants.js";
import { HubApiError, WorkerClient } from "../api.js";
import { getApiKey, getSetting, getWorldRole, setSetting } from "../settings.js";

/**
 * Home world sync: pushes full snapshots of characters marked "in use" to the Worker.
 *
 * Only the active GM's client pushes, so several connected GMs don't send the same change twice.
 * Changes are pushed PUSH_DELAY_MS after the first edit, so many quick edits (a combat turn)
 * become one push holding the latest state.
 */

const timers = new Map();      // actorId -> pending push timeout
const inFlight = new Set();    // actorIds being pushed right now
const dirtyAgain = new Set();  // actorIds edited while their push was in flight
const failed = new Set();      // actorIds whose last push failed

/** Shared with the UI. Changes are announced with the `character-hub.syncStatus` hook. */
export const status = {
  state: "idle",               // idle | pending | syncing | ok | error | paused
  message: "",
  pausedUntil: 0
};

function setStatus(state, message = "") {
  status.state = state;
  status.message = message;
  Hooks.callAll(`${MODULE_ID}.syncStatus`, status);
}

export function isInUse(actor) {
  return actor?.getFlag(MODULE_ID, FLAGS.IN_USE) === true;
}

/** Characters only, and only world actors (not unlinked token copies or compendium entries). */
export function isSyncable(actor) {
  return actor?.documentName === "Actor" && actor.type === "character" && !actor.isToken && !actor.pack;
}

export function inUseActors() {
  return game.actors.filter(a => isSyncable(a) && isInUse(a));
}

export function isHomeGM() {
  return getWorldRole() === ROLES.HOME && game.user.isGM;
}

/** True if this client is the one that pushes. */
export function isPusher() {
  return isHomeGM() && game.users.activeGM?.isSelf === true;
}

export function isConfigured() {
  return Boolean(getSetting(SETTINGS.WORKER_URL) && getApiKey() && getSetting(SETTINGS.HOME_WORLD_ID));
}

export function pendingCount() {
  return new Set([...timers.keys(), ...inFlight, ...failed]).size;
}

/** The newest modification time across the actor, its items, and all their effects. */
function latestChange(actor) {
  let latest = actor._stats?.modifiedTime ?? 0;
  const consider = doc => { latest = Math.max(latest, doc._stats?.modifiedTime ?? 0); };
  actor.effects.forEach(consider);
  for (const item of actor.items) {
    consider(item);
    item.effects.forEach(consider);
  }
  return latest;
}

async function recordSync(actorId, entry) {
  const state = foundry.utils.deepClone(getSetting(SETTINGS.SYNC_STATE));
  state.actors ??= {};
  if (entry) state.actors[actorId] = entry;
  else delete state.actors[actorId];
  if (entry) state.lastSyncAt = entry.syncedAt;
  await setSetting(SETTINGS.SYNC_STATE, state);
}

function describeError(err) {
  return err instanceof HubApiError ? err.message : String(err?.message ?? err);
}

/** Show an error from the Worker, remembering a pause so we stop sending until the limits reset. */
function handleError(err) {
  if (err instanceof HubApiError && err.paused) {
    status.pausedUntil = Date.now() + (err.retryAfter ?? 300) * 1000;
    setStatus("paused", describeError(err));
  } else {
    setStatus("error", describeError(err));
  }
}

/** Push one character now. Returns true on success. */
export async function pushActor(actor) {
  if (!isPusher() || !isConfigured() || !isSyncable(actor) || !isInUse(actor)) return false;
  if (status.pausedUntil > Date.now()) return false;
  if (inFlight.has(actor.id)) {
    dirtyAgain.add(actor.id);
    return false;
  }

  clearTimeout(timers.get(actor.id));
  timers.delete(actor.id);
  inFlight.add(actor.id);
  setStatus("syncing");
  const sourceTime = latestChange(actor);

  try {
    const meta = await new WorkerClient().request(
      "PUT",
      `/v1/snapshots/${getSetting(SETTINGS.HOME_WORLD_ID)}/${actor.id}`,
      {
        query: { schemaVersion: SCHEMA_VERSION, systemVersion: game.system.version, name: actor.name },
        text: JSON.stringify(actor.toObject())
      }
    );
    failed.delete(actor.id);
    status.pausedUntil = 0;
    await recordSync(actor.id, { version: meta.version, syncedAt: meta.updatedAt, sourceTime });
    return true;
  } catch (err) {
    failed.add(actor.id);
    console.warn(`${MODULE_ID} | Push failed for ${actor.name}:`, err);
    handleError(err);
    return false;
  } finally {
    // Leave the in-flight list before announcing the new status, so the count shown is accurate.
    inFlight.delete(actor.id);
    if (dirtyAgain.delete(actor.id)) schedulePush(actor);
    if (status.state === "syncing") setStatus(timers.size || inFlight.size ? "pending" : "ok");
  }
}

/** Push a character PUSH_DELAY_MS from its first change. Later changes ride along. */
export function schedulePush(actor) {
  if (!isPusher() || !isSyncable(actor) || !isInUse(actor)) return;
  if (inFlight.has(actor.id)) {
    dirtyAgain.add(actor.id);
    return;
  }
  if (timers.has(actor.id)) return;
  timers.set(actor.id, setTimeout(() => {
    timers.delete(actor.id);
    const current = game.actors.get(actor.id);
    if (current) pushActor(current);
  }, PUSH_DELAY_MS));
  if (status.state !== "error" && status.state !== "paused") setStatus("pending");
}

/**
 * Push characters one after another. With `onlyStale`, skip characters unchanged since their last push.
 * Used by the "Sync all to hub" button and to catch up on changes made while no GM was syncing.
 */
export async function syncAll({ onlyStale = false, notify = true } = {}) {
  if (!isHomeGM()) return;
  if (!isPusher()) return ui.notifications.warn("CHARHUB.Sync.NotActiveGM", { localize: true });
  if (!isConfigured()) return ui.notifications.warn("CHARHUB.Sync.NotConfigured", { localize: true });
  status.pausedUntil = 0;

  const synced = getSetting(SETTINGS.SYNC_STATE).actors ?? {};
  const actors = inUseActors().filter(a => !onlyStale || failed.has(a.id) || !synced[a.id]
    || latestChange(a) > (synced[a.id].sourceTime ?? 0));
  if (!actors.length) {
    if (notify) ui.notifications.info("CHARHUB.Sync.NothingToDo", { localize: true });
    if (status.state === "idle") setStatus("ok");
    return;
  }

  let ok = 0;
  for (const actor of actors) {
    if (await pushActor(actor)) ok++;
    else if (status.state === "paused") break;
  }
  if (!notify) return;
  if (ok === actors.length) {
    ui.notifications.info(game.i18n.format("CHARHUB.Sync.AllDone", { count: ok }));
  } else {
    ui.notifications.warn(game.i18n.format("CHARHUB.Sync.SomeFailed", { ok, total: actors.length, error: status.message }));
  }
}

/** Remove a character's snapshot from the Worker, so the hub stops receiving it. */
async function removeSnapshot(actorId) {
  clearTimeout(timers.get(actorId));
  timers.delete(actorId);
  failed.delete(actorId);
  if (!isPusher() || !isConfigured()) return;
  try {
    await new WorkerClient().request("DELETE", `/v1/snapshots/${getSetting(SETTINGS.HOME_WORLD_ID)}/${actorId}`);
  } catch (err) {
    // Already gone is fine.
    if (!(err instanceof HubApiError && err.code === "snapshot_not_found")) {
      handleError(err);
      return;
    }
  }
  await recordSync(actorId, null);
}

/** GM toggle from the character sheet. Turning it off asks first, because it removes the hub's source. */
export async function toggleInUse(actor) {
  if (!isHomeGM() || !isSyncable(actor)) return;
  if (!isInUse(actor)) {
    await actor.setFlag(MODULE_ID, FLAGS.IN_USE, true);
    if (!isConfigured()) return ui.notifications.warn("CHARHUB.Sync.NotConfigured", { localize: true });
    if (await pushActor(actor)) {
      ui.notifications.info(game.i18n.format("CHARHUB.InUse.Started", { name: actor.name }));
    }
    return;
  }

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "CHARHUB.InUse.StopTitle" },
    content: `<p>${game.i18n.format("CHARHUB.InUse.StopConfirm", { name: foundry.utils.escapeHTML(actor.name) })}</p>`,
    rejectClose: false
  });
  if (!confirmed) return;
  await actor.unsetFlag(MODULE_ID, FLAGS.IN_USE);
  await removeSnapshot(actor.id);
  ui.notifications.info(game.i18n.format("CHARHUB.InUse.Stopped", { name: actor.name }));
}

/** True if an actor update changed anything besides this module's own flags and Foundry's bookkeeping. */
function isRealChange(changes) {
  return Object.keys(foundry.utils.flattenObject(changes))
    .some(key => key !== "_id" && !key.startsWith("_stats.") && !key.startsWith(`flags.${MODULE_ID}`));
}

/** The world actor an item or effect belongs to, if any. */
function owningActor(doc) {
  let parent = doc.parent;
  if (parent?.documentName === "Item") parent = parent.parent;
  return parent?.documentName === "Actor" ? parent : null;
}

export function registerHomeSync() {
  if (getWorldRole() !== ROLES.HOME) return;

  Hooks.on("updateActor", (actor, changes) => {
    if (isRealChange(changes)) schedulePush(actor);
  });
  Hooks.on("deleteActor", actor => {
    if (isPusher() && isSyncable(actor) && isInUse(actor)) removeSnapshot(actor.id);
  });
  for (const type of ["Item", "ActiveEffect"]) {
    for (const action of ["create", "update", "delete"]) {
      Hooks.on(`${action}${type}`, doc => {
        const actor = owningActor(doc);
        if (actor) schedulePush(actor);
      });
    }
  }

  Hooks.once("ready", () => {
    if (!isPusher()) return;
    if (!isConfigured()) {
      if (inUseActors().length) setStatus("error", game.i18n.localize("CHARHUB.Sync.NotConfigured"));
      return;
    }
    // Catch up on anything changed while no GM was connected, or that failed to push last time.
    syncAll({ onlyStale: true, notify: false });
  });
}
