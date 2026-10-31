import { requireRole } from "../auth.js";
import { db } from "../db.js";
import { HttpError, json, nowIso, requireId, requireSchemaVersion } from "../http.js";

/**
 * Each home world's player list: Foundry user id and name, GMs left out by the module.
 * A website reads it with the portal key so players can pick their Foundry user when claiming.
 * The hub key has no access.
 */

const MAX_USERS = 300;
const MAX_NAME = 100;
const MAX_BODY_BYTES = 64 * 1024;

const COLUMNS = "home_world_id, version, schema_version, updated_at, users";

function toList(row) {
  return {
    homeWorldId: row.home_world_id,
    version: row.version,
    schemaVersion: row.schema_version,
    updatedAt: row.updated_at,
    users: JSON.parse(row.users)
  };
}

/** Keep only { id, name } from each entry; refuse anything malformed instead of guessing. */
export function cleanUsers(value) {
  if (!Array.isArray(value)) throw new HttpError(400, "bad_request", "users must be a list.");
  if (value.length > MAX_USERS) {
    throw new HttpError(400, "bad_request", `A world can send at most ${MAX_USERS} users.`);
  }
  const seen = new Set();
  return value.map((user, i) => {
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      throw new HttpError(400, "bad_request", `users[${i}] must be an object.`);
    }
    const id = requireId(user.id, `users[${i}].id`);
    if (seen.has(id)) throw new HttpError(400, "bad_request", `users[${i}].id is listed twice.`);
    seen.add(id);
    const name = typeof user.name === "string" ? user.name.trim() : "";
    if (!name || name.length > MAX_NAME) {
      throw new HttpError(400, "bad_request", `users[${i}].name must be 1-${MAX_NAME} characters.`);
    }
    return { id, name };
  });
}

/** Home worlds may only touch their own list. */
function requireOwnWorld(world, homeWorldId) {
  if (world.role === "home" && world.worldId !== homeWorldId) {
    throw new HttpError(403, "forbidden", "A home world key can only access its own users.");
  }
}

/** Only the home world itself and the portal can read a user list. */
function requireReader(world) {
  if (world.role !== "home" && world.role !== "portal") {
    throw new HttpError(403, "forbidden", "This key cannot read user lists.");
  }
}

/** PUT /v1/users/:homeWorldId (home key, own world). Replaces the world's whole list. */
export async function putUsers(request, env, world, homeWorldId) {
  requireRole(world, "home");
  requireId(homeWorldId, "homeWorldId");
  requireOwnWorld(world, homeWorldId);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "too_large", "The user list is too large.");
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object") throw new HttpError(400, "bad_request", "Body must be a JSON object.");
  const schemaVersion = requireSchemaVersion(body.schemaVersion);
  const users = cleanUsers(body.users);

  const row = await db(() => env.DB.prepare(`
    INSERT INTO world_users (home_world_id, version, schema_version, updated_at, users)
    VALUES (?1, 1, ?2, ?3, ?4)
    ON CONFLICT (home_world_id) DO UPDATE SET
      version = world_users.version + 1,
      schema_version = excluded.schema_version,
      updated_at = excluded.updated_at,
      users = excluded.users
    RETURNING home_world_id, version, updated_at
  `).bind(homeWorldId, schemaVersion, nowIso(), JSON.stringify(users)).first());

  return json({ homeWorldId: row.home_world_id, version: row.version, updatedAt: row.updated_at, count: users.length },
    row.version === 1 ? 201 : 200);
}

/** GET /v1/users/:homeWorldId (home key for its own world, or portal key). */
export async function getUsers(request, env, world, homeWorldId) {
  requireReader(world);
  requireId(homeWorldId, "homeWorldId");
  requireOwnWorld(world, homeWorldId);
  const row = await db(() => env.DB.prepare(
    `SELECT ${COLUMNS} FROM world_users WHERE home_world_id = ?1`
  ).bind(homeWorldId).first());
  if (!row) throw new HttpError(404, "users_not_found", "That world has not sent its user list yet.");
  return json(toList(row));
}

/** GET /v1/users (portal key). Every world's list in one call. */
export async function listUsers(request, env, world) {
  requireRole(world, "portal");
  const { results } = await db(() => env.DB.prepare(
    `SELECT ${COLUMNS} FROM world_users ORDER BY home_world_id`
  ).all());
  return json({ worlds: results.map(toList) });
}
