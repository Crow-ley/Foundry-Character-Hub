import { SETTINGS } from "./constants.js";
import { getApiKey, getSetting } from "./settings.js";

/** A failed Worker call, with a code the UI can act on and a message it can show. */
export class HubApiError extends Error {
  constructor(code, message, { status = 0, retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** True when the free daily limits are used up and syncing should wait. */
  get paused() {
    return this.code === "sync_paused";
  }
}

/**
 * The only code that talks to the network. Every request goes to the configured Worker URL.
 * `url` and `key` can be given directly, for testing values that are not saved yet.
 */
export class WorkerClient {
  constructor({ url, key } = {}) {
    this.url = (url ?? getSetting(SETTINGS.WORKER_URL) ?? "").replace(/\/+$/, "");
    this.key = key ?? getApiKey();
  }

  get configured() {
    return Boolean(this.url && this.key);
  }

  /**
   * @param {string} method
   * @param {string} path            Starts with /v1/
   * @param {object} [options]
   * @param {object} [options.query] Query string values; null and undefined are skipped
   * @param {*} [options.json]       Body to send as JSON
   * @param {string} [options.text]  Body already serialized as JSON text
   * @param {string} [options.key]   Overrides the world key (used for the admin key)
   */
  async request(method, path, { query, json, text, key } = {}) {
    if (!this.url) throw new HubApiError("not_configured", game.i18n.localize("CHARHUB.Error.NoUrl"));
    const authKey = key ?? this.key;
    if (!authKey) throw new HubApiError("not_configured", game.i18n.localize("CHARHUB.Error.NoKey"));

    const url = new URL(this.url + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = { Authorization: `Bearer ${authKey}` };
    let body;
    if (text !== undefined) body = text;
    else if (json !== undefined) body = JSON.stringify(json);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await fetch(url, { method, headers, body });
    } catch {
      throw new HubApiError("unreachable", game.i18n.localize("CHARHUB.Error.Unreachable"));
    }
    if (response.status === 204) return null;

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Not JSON. Usually Cloudflare itself answering because a plan limit was hit.
    }

    if (response.ok && data) return data;
    const retryAfter = Number(response.headers.get("Retry-After")) || null;
    if (data?.error) {
      throw new HubApiError(data.error.code, data.error.message, { status: response.status, retryAfter });
    }
    if (response.status === 429 || response.status >= 500) {
      throw new HubApiError("sync_paused", game.i18n.localize("CHARHUB.Error.PlatformLimit"),
        { status: response.status, retryAfter });
    }
    throw new HubApiError("bad_response",
      game.i18n.format("CHARHUB.Error.BadResponse", { status: response.status }), { status: response.status });
  }
}
