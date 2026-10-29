import { HttpError } from "./http.js";
import { db } from "./db.js";

const encoder = new TextEncoder();

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** A new random world key. The prefix only helps humans tell keys apart. */
export function newWorldKey(role) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `chh_${role}_${body}`;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/** Check the request's world key. Returns { worldId, role }. */
export async function authenticateWorld(request, env) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "unauthorized", "Missing API key.");
  const hash = await sha256Hex(token);
  const row = await db(() =>
    env.DB.prepare("SELECT world_id, role FROM worlds WHERE key_hash = ?1").bind(hash).first()
  );
  if (!row) throw new HttpError(401, "unauthorized", "Unknown or revoked API key.");
  return { worldId: row.world_id, role: row.role };
}

export function requireRole(world, role) {
  if (world.role !== role) {
    throw new HttpError(403, "forbidden", `This action needs a ${role} world key.`);
  }
}

/** Admin requests use the ADMIN_KEY secret, which only the Worker owner knows. */
export async function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) {
    throw new HttpError(503, "admin_disabled", "ADMIN_KEY is not set on this Worker, so worlds cannot be registered.");
  }
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "unauthorized", "Missing admin key.");
  // Compare hashes so both sides are the same length for the constant-time check.
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_KEY))
  ]);
  if (!crypto.subtle.timingSafeEqual(given, expected)) {
    throw new HttpError(401, "unauthorized", "Wrong admin key.");
  }
}
