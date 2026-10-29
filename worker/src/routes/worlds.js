import { newWorldKey, requireAdmin, sha256Hex } from "../auth.js";
import { db } from "../db.js";
import { API_VERSION, HttpError, json, MAX_SCHEMA_VERSION, noContent, nowIso, optionalString, readJson, requireId } from "../http.js";

/**
 * POST /v1/worlds (admin). Registers a world, or issues a new key for an existing one.
 * The key is only ever returned here; the Worker keeps just its hash.
 */
export async function registerWorld(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const role = body.role;
  if (role !== "home" && role !== "hub") {
    throw new HttpError(400, "bad_request", 'role must be "home" or "hub".');
  }
  const worldId = role === "hub" ? requireId(body.worldId ?? "hub", "worldId") : requireId(body.worldId, "worldId");
  const name = optionalString(body.name, "name", 200);

  const key = newWorldKey(role);
  const keyHash = await sha256Hex(key);
  const now = nowIso();

  const existing = await db(() =>
    env.DB.prepare("SELECT role FROM worlds WHERE world_id = ?1").bind(worldId).first()
  );
  if (existing && existing.role !== role) {
    throw new HttpError(409, "role_conflict", `World ${worldId} is already registered as ${existing.role}.`);
  }

  if (existing) {
    await db(() => env.DB.prepare(
      "UPDATE worlds SET key_hash = ?1, key_rotated_at = ?2, name = COALESCE(?3, name) WHERE world_id = ?4"
    ).bind(keyHash, now, name, worldId).run());
  } else {
    await db(() => env.DB.prepare(
      "INSERT INTO worlds (world_id, role, name, key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(worldId, role, name, keyHash, now).run());
  }

  return json({ worldId, role, name, key, rotated: Boolean(existing) }, existing ? 200 : 201);
}

/** GET /v1/worlds (admin). */
export async function listWorlds(request, env) {
  await requireAdmin(request, env);
  const { results } = await db(() => env.DB.prepare(
    "SELECT world_id, role, name, created_at, key_rotated_at FROM worlds ORDER BY role, world_id"
  ).all());
  return json({
    worlds: results.map(r => ({
      worldId: r.world_id,
      role: r.role,
      name: r.name,
      createdAt: r.created_at,
      keyRotatedAt: r.key_rotated_at
    }))
  });
}

/** DELETE /v1/worlds/:worldId (admin). Revokes the world's key. Its data stays. */
export async function deleteWorld(request, env, worldId) {
  await requireAdmin(request, env);
  requireId(worldId, "worldId");
  const result = await db(() => env.DB.prepare("DELETE FROM worlds WHERE world_id = ?1").bind(worldId).run());
  if (!result.meta.changes) throw new HttpError(404, "not_found", `World ${worldId} is not registered.`);
  return noContent();
}

/** GET /v1/me. Lets a world check its key and the Worker's versions. */
export function whoAmI(world) {
  return json({ apiVersion: API_VERSION, maxSchemaVersion: MAX_SCHEMA_VERSION, worldId: world.worldId, role: world.role });
}
