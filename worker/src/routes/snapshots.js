import { requireRole } from "../auth.js";
import { db } from "../db.js";
import {
  HttpError, json, MAX_ROW_BYTES, noContent, nowIso, optionalString, rawJson, requireId, requireSchemaVersion
} from "../http.js";

const META_COLUMNS = "home_world_id, actor_id, version, schema_version, system_version, actor_name, updated_at";

function toMeta(row) {
  return {
    homeWorldId: row.home_world_id,
    actorId: row.actor_id,
    version: row.version,
    schemaVersion: row.schema_version,
    systemVersion: row.system_version,
    name: row.actor_name,
    updatedAt: row.updated_at
  };
}

/**
 * Serialize a snapshot with its stored actor JSON spliced in as-is.
 * Parsing and re-serializing a large actor would cost more CPU time than the free plan allows.
 */
function snapshotJson(row) {
  const meta = JSON.stringify(toMeta(row));
  return `${meta.slice(0, -1)},"data":${row.data}}`;
}

/** Home worlds may only touch their own snapshots. */
function requireOwnWorld(world, homeWorldId) {
  if (world.role === "home" && world.worldId !== homeWorldId) {
    throw new HttpError(403, "forbidden", "A home world key can only access its own characters.");
  }
}

/**
 * PUT /v1/snapshots/:homeWorldId/:actorId (home key).
 * Body is the raw actor JSON. Metadata goes in the query string so the Worker never has to parse the body.
 * The Worker assigns the version: 1 for a new character, then +1 on every push.
 */
export async function putSnapshot(request, env, world, homeWorldId, actorId) {
  requireRole(world, "home");
  requireId(homeWorldId, "homeWorldId");
  requireId(actorId, "actorId");
  requireOwnWorld(world, homeWorldId);

  const params = new URL(request.url).searchParams;
  const schemaVersion = requireSchemaVersion(params.get("schemaVersion"));
  const systemVersion = optionalString(params.get("systemVersion"), "systemVersion", 50);
  const name = optionalString(params.get("name"), "name", 200);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_ROW_BYTES) {
    throw new HttpError(413, "snapshot_too_large",
      `This character is ${(bytes.byteLength / 1e6).toFixed(1)} MB, over the ${(MAX_ROW_BYTES / 1e6).toFixed(1)} MB limit for one snapshot.`);
  }
  const data = new TextDecoder().decode(bytes);
  // A cheap shape check instead of a full parse, which would cost too much CPU on large actors.
  const trimmed = data.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new HttpError(400, "bad_request", "Body must be the actor's JSON object.");
  }

  const row = await db(() => env.DB.prepare(`
    INSERT INTO snapshots (home_world_id, actor_id, version, schema_version, system_version, actor_name, updated_at, data)
    VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (home_world_id, actor_id) DO UPDATE SET
      version = snapshots.version + 1,
      schema_version = excluded.schema_version,
      system_version = excluded.system_version,
      actor_name = excluded.actor_name,
      updated_at = excluded.updated_at,
      data = excluded.data
    RETURNING ${META_COLUMNS}
  `).bind(homeWorldId, actorId, schemaVersion, systemVersion, name, nowIso(), data).first());

  return json(toMeta(row), row.version === 1 ? 201 : 200);
}

/**
 * GET /v1/snapshots?homeWorldId=&actorIds=a,b&include=data
 * Without include=data only metadata is returned, so the hub can compare versions cheaply
 * and then fetch full data for just the characters that changed.
 */
export async function listSnapshots(request, env, world) {
  const params = new URL(request.url).searchParams;
  let homeWorldId = params.get("homeWorldId");
  if (world.role === "home") homeWorldId ??= world.worldId;
  if (homeWorldId) {
    requireId(homeWorldId, "homeWorldId");
    requireOwnWorld(world, homeWorldId);
  }

  const actorIds = (params.get("actorIds") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (actorIds.length > 100) throw new HttpError(400, "bad_request", "Ask for at most 100 actorIds at a time.");
  actorIds.forEach(id => requireId(id, "actorIds"));

  const includeData = params.get("include") === "data";
  const where = [];
  const binds = [];
  if (homeWorldId) {
    binds.push(homeWorldId);
    where.push(`home_world_id = ?${binds.length}`);
  }
  if (actorIds.length) {
    const start = binds.length + 1;
    binds.push(...actorIds);
    where.push(`actor_id IN (${actorIds.map((_, i) => `?${start + i}`).join(", ")})`);
  }
  const sql = `SELECT ${META_COLUMNS}${includeData ? ", data" : ""} FROM snapshots`
    + (where.length ? ` WHERE ${where.join(" AND ")}` : "")
    + " ORDER BY home_world_id, actor_id";

  const { results } = await db(() => env.DB.prepare(sql).bind(...binds).all());
  if (!includeData) return json({ snapshots: results.map(toMeta) });
  return rawJson(`{"snapshots":[${results.map(snapshotJson).join(",")}]}`);
}

/** GET /v1/snapshots/:homeWorldId/:actorId. Always includes data. */
export async function getSnapshot(request, env, world, homeWorldId, actorId) {
  requireId(homeWorldId, "homeWorldId");
  requireId(actorId, "actorId");
  requireOwnWorld(world, homeWorldId);
  const row = await db(() => env.DB.prepare(
    `SELECT ${META_COLUMNS}, data FROM snapshots WHERE home_world_id = ?1 AND actor_id = ?2`
  ).bind(homeWorldId, actorId).first());
  if (!row) throw new HttpError(404, "snapshot_not_found", "No snapshot for that character.");
  return rawJson(snapshotJson(row));
}

/** DELETE /v1/snapshots/:homeWorldId/:actorId (home key). Used when a character is no longer in use. */
export async function deleteSnapshot(request, env, world, homeWorldId, actorId) {
  requireRole(world, "home");
  requireId(homeWorldId, "homeWorldId");
  requireId(actorId, "actorId");
  requireOwnWorld(world, homeWorldId);
  const result = await db(() => env.DB.prepare(
    "DELETE FROM snapshots WHERE home_world_id = ?1 AND actor_id = ?2"
  ).bind(homeWorldId, actorId).run());
  if (!result.meta.changes) throw new HttpError(404, "snapshot_not_found", "No snapshot for that character.");
  return noContent();
}
