import { HttpError } from "./http.js";

/** Seconds until 00:00 UTC, when Cloudflare's free daily limits reset. */
export function secondsUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Turn a D1 failure into an error the module can show. Once a free account passes its daily
 * limits, D1 queries fail; the module shows "sync paused" for that instead of crashing.
 */
export function classifyDbError(err) {
  const message = String(err?.message ?? err);
  if (/maximum (db|database) size|database is full|SQLITE_FULL/i.test(message)) {
    return new HttpError(507, "storage_full",
      "The Character Hub database is full. Delete old snapshots or upgrade the Cloudflare plan.");
  }
  if (/too big|SQLITE_TOOBIG/i.test(message)) {
    return new HttpError(413, "too_large", "This data is too large for one database row.");
  }
  if (/exceeded|quota|daily limit|rate limit|too many requests/i.test(message)) {
    return new HttpError(503, "sync_paused",
      "Sync is paused because the free daily database limit was reached. It resets at 00:00 UTC.",
      { "Retry-After": String(secondsUntilUtcMidnight()) });
  }
  console.error("D1 error:", message);
  return new HttpError(500, "storage_error", "The database returned an error. Try again later.");
}

/** Run D1 work, converting database failures into clear HTTP errors. */
export async function db(work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw classifyDbError(err);
  }
}
