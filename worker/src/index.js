import { authenticateWorld } from "./auth.js";
import { API_VERSION, errorResponse, HttpError, json, preflight } from "./http.js";
import { deleteWorld, listWorlds, registerWorld, whoAmI } from "./routes/worlds.js";
import { deleteSnapshot, getSnapshot, listSnapshots, putSnapshot } from "./routes/snapshots.js";
import {
  createChangeRequest, getChangeRequest, listChangeRequests, resolveChangeRequest
} from "./routes/change-requests.js";
import { getUsers, listUsers, putUsers } from "./routes/users.js";

// [method, path pattern, handler, needs a world key, portal key allowed].
// Admin routes check the admin key themselves.
// The portal key is read-only by this allowlist: anything not marked here answers 403 before the
// handler runs, so a handler that only restricts home keys can never be reached with it.
const ROUTES = [
  ["POST", /^\/v1\/worlds$/, registerWorld, false, false],
  ["GET", /^\/v1\/worlds$/, listWorlds, false, false],
  ["DELETE", /^\/v1\/worlds\/([^/]+)$/, deleteWorld, false, false],
  ["GET", /^\/v1\/me$/, (request, env, world) => whoAmI(world), true, true],
  ["GET", /^\/v1\/snapshots$/, listSnapshots, true, false],
  ["GET", /^\/v1\/snapshots\/([^/]+)\/([^/]+)$/, getSnapshot, true, false],
  ["PUT", /^\/v1\/snapshots\/([^/]+)\/([^/]+)$/, putSnapshot, true, false],
  ["DELETE", /^\/v1\/snapshots\/([^/]+)\/([^/]+)$/, deleteSnapshot, true, false],
  ["POST", /^\/v1\/change-requests$/, createChangeRequest, true, false],
  ["GET", /^\/v1\/change-requests$/, listChangeRequests, true, false],
  ["GET", /^\/v1\/change-requests\/([^/]+)$/, getChangeRequest, true, false],
  ["POST", /^\/v1\/change-requests\/([^/]+)\/resolve$/, resolveChangeRequest, true, false],
  ["GET", /^\/v1\/users$/, listUsers, true, true],
  ["GET", /^\/v1\/users\/([^/]+)$/, getUsers, true, true],
  ["PUT", /^\/v1\/users\/([^/]+)$/, putUsers, true, false]
];

async function route(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/" || pathname === "/v1") {
    return json({ name: "character-hub-worker", apiVersion: API_VERSION });
  }

  let pathMatched = false;
  for (const [method, pattern, handler, needsWorld, portalAllowed] of ROUTES) {
    const match = pathname.match(pattern);
    if (!match) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    const params = match.slice(1).map(decodeURIComponent);
    if (!needsWorld) return handler(request, env, ...params);
    const world = await authenticateWorld(request, env);
    if (world.role === "portal" && !portalAllowed) {
      throw new HttpError(403, "forbidden", "The portal key is read-only and cannot use this endpoint.");
    }
    return handler(request, env, world, ...params);
  }
  if (pathMatched) throw new HttpError(405, "method_not_allowed", `${request.method} is not allowed here.`);
  throw new HttpError(404, "not_found", "No such endpoint.");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight();
    try {
      return await route(request, env);
    } catch (err) {
      return errorResponse(err);
    }
  }
};
