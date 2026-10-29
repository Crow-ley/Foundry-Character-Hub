import { requireRole } from "../auth.js";
import { db } from "../db.js";
import {
  HttpError, json, MAX_ROW_BYTES, nowIso, optionalString, readJson, requireId, requireInt, requireSchemaVersion
} from "../http.js";

const STATUSES = ["pending", "approved", "rejected", "partial"];
const RESOLVED_STATUSES = ["approved", "rejected", "partial"];
const SUMMARY_COLUMNS = "id, type, home_world_id, actor_id, base_version, schema_version, submitted_by, "
  + "submitted_by_id, submitted_at, status, resolved_at, resolved_by";

function toRequest(row, includeDetail) {
  const out = {
    id: row.id,
    type: row.type,
    homeWorldId: row.home_world_id,
    actorId: row.actor_id,
    baseVersion: row.base_version,
    schemaVersion: row.schema_version,
    submittedBy: row.submitted_by,
    submittedById: row.submitted_by_id,
    submittedAt: row.submitted_at,
    status: row.status,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by
  };
  if (includeDetail) {
    out.diff = JSON.parse(row.diff);
    out.resolution = row.resolution ? JSON.parse(row.resolution) : null;
  }
  return out;
}

function requireOwnWorld(world, homeWorldId) {
  if (world.role === "home" && world.worldId !== homeWorldId) {
    throw new HttpError(403, "forbidden", "A home world key can only access its own change requests.");
  }
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "bad_request", `${field} must be a JSON object.`);
  }
  return value;
}

function serializeLimited(value, field) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_ROW_BYTES) {
    throw new HttpError(413, "too_large", `${field} is too large to store.`);
  }
  return text;
}

/** POST /v1/change-requests (hub key). A player submits their edits to a character. */
export async function createChangeRequest(request, env, world) {
  requireRole(world, "hub");
  const body = await readJson(request);
  const type = body.type ?? "update";
  if (type !== "update") {
    throw new HttpError(400, "bad_request", 'Only type "update" is supported in this version.');
  }
  const homeWorldId = requireId(body.homeWorldId, "homeWorldId");
  const actorId = requireId(body.actorId, "actorId");
  const baseVersion = requireInt(body.baseVersion, "baseVersion", { min: 1 });
  const schemaVersion = requireSchemaVersion(body.schemaVersion);
  const submittedBy = optionalString(body.submittedBy, "submittedBy", 200);
  const submittedById = optionalString(body.submittedById, "submittedById", 64);
  const diff = serializeLimited(requireObject(body.diff, "diff"), "diff");

  const snapshot = await db(() => env.DB.prepare(
    "SELECT version FROM snapshots WHERE home_world_id = ?1 AND actor_id = ?2"
  ).bind(homeWorldId, actorId).first());
  if (!snapshot) throw new HttpError(404, "snapshot_not_found", "That character is not on the hub any more.");
  if (baseVersion > snapshot.version) {
    throw new HttpError(422, "bad_base_version",
      `baseVersion ${baseVersion} is newer than the latest snapshot (${snapshot.version}).`);
  }

  const id = crypto.randomUUID();
  const submittedAt = nowIso();
  await db(() => env.DB.prepare(`
    INSERT INTO change_requests
      (id, type, home_world_id, actor_id, base_version, schema_version, submitted_by, submitted_by_id, submitted_at, status, diff)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)
  `).bind(id, type, homeWorldId, actorId, baseVersion, schemaVersion, submittedBy, submittedById, submittedAt, diff).run());

  return json({ id, status: "pending", submittedAt, currentVersion: snapshot.version }, 201);
}

/**
 * GET /v1/change-requests?homeWorldId=&actorId=&status=&include=diff&limit=
 * Home keys only see their own world. Oldest first, so the GM reviews in submission order.
 */
export async function listChangeRequests(request, env, world) {
  const params = new URL(request.url).searchParams;
  let homeWorldId = params.get("homeWorldId");
  if (world.role === "home") homeWorldId ??= world.worldId;
  if (homeWorldId) {
    requireId(homeWorldId, "homeWorldId");
    requireOwnWorld(world, homeWorldId);
  }
  const actorId = params.get("actorId");
  if (actorId) requireId(actorId, "actorId");
  const status = params.get("status");
  if (status && !STATUSES.includes(status)) {
    throw new HttpError(400, "bad_request", `status must be one of ${STATUSES.join(", ")}.`);
  }
  const limit = params.has("limit") ? requireInt(params.get("limit"), "limit", { min: 1 }) : 100;
  const includeDetail = params.get("include") === "diff";

  const where = [];
  const binds = [];
  for (const [column, value] of [["home_world_id", homeWorldId], ["actor_id", actorId], ["status", status]]) {
    if (!value) continue;
    binds.push(value);
    where.push(`${column} = ?${binds.length}`);
  }
  binds.push(Math.min(limit, 500));
  const sql = `SELECT ${SUMMARY_COLUMNS}${includeDetail ? ", diff, resolution" : ""} FROM change_requests`
    + (where.length ? ` WHERE ${where.join(" AND ")}` : "")
    + ` ORDER BY submitted_at ASC LIMIT ?${binds.length}`;

  const { results } = await db(() => env.DB.prepare(sql).bind(...binds).all());
  return json({ changeRequests: results.map(r => toRequest(r, includeDetail)) });
}

/** GET /v1/change-requests/:id. Always includes the diff. */
export async function getChangeRequest(request, env, world, id) {
  const row = await db(() => env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}, diff, resolution FROM change_requests WHERE id = ?1`
  ).bind(id).first());
  if (!row) throw new HttpError(404, "not_found", "No change request with that ID.");
  requireOwnWorld(world, row.home_world_id);
  return json(toRequest(row, true));
}

/**
 * POST /v1/change-requests/:id/resolve (home key, own world).
 * Body: { status: "approved" | "rejected" | "partial", resolvedBy?, resolution? }.
 * Only a pending request can be resolved, so two GM clients cannot both apply it.
 */
export async function resolveChangeRequest(request, env, world, id) {
  requireRole(world, "home");
  const body = await readJson(request);
  if (!RESOLVED_STATUSES.includes(body.status)) {
    throw new HttpError(400, "bad_request", `status must be one of ${RESOLVED_STATUSES.join(", ")}.`);
  }
  const resolvedBy = optionalString(body.resolvedBy, "resolvedBy", 200);
  const resolution = body.resolution === undefined || body.resolution === null
    ? null
    : serializeLimited(requireObject(body.resolution, "resolution"), "resolution");

  const row = await db(() => env.DB.prepare(`
    UPDATE change_requests SET status = ?1, resolved_at = ?2, resolved_by = ?3, resolution = ?4
    WHERE id = ?5 AND home_world_id = ?6 AND status = 'pending'
    RETURNING ${SUMMARY_COLUMNS}
  `).bind(body.status, nowIso(), resolvedBy, resolution, id, world.worldId).first());
  if (row) return json(toRequest(row, false));

  const existing = await db(() => env.DB.prepare(
    "SELECT home_world_id, status FROM change_requests WHERE id = ?1"
  ).bind(id).first());
  if (!existing || existing.home_world_id !== world.worldId) {
    throw new HttpError(404, "not_found", "No change request with that ID for this world.");
  }
  throw new HttpError(409, "already_resolved", `This change request was already ${existing.status}.`);
}
