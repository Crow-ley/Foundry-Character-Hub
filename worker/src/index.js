import { authenticateWorld } from "./auth.js";
import { API_VERSION, errorResponse, HttpError, json, preflight } from "./http.js";
import { deleteWorld, listWorlds, registerWorld, whoAmI } from "./routes/worlds.js";
import { deleteSnapshot, getSnapshot, listSnapshots, putSnapshot } from "./routes/snapshots.js";
import {
  createChangeRequest, getChangeRequest, listChangeRequests, resolveChangeRequest
} from "./routes/change-requests.js";

// [method, path pattern, handler, needs a world key]. Admin routes check the admin key themselves.
const ROUTES = [
  ["POST", /^\/v1\/worlds$/, registerWorld, false],
  ["GET", /^\/v1\/worlds$/, listWorlds, false],
  ["DELETE", /^\/v1\/worlds\/([^/]+)$/, deleteWorld, false],
  ["GET", /^\/v1\/me$/, (request, env, world) => whoAmI(world), true],
  ["GET", /^\/v1\/snapshots$/, listSnapshots, true],
  ["GET", /^\/v1\/snapshots\/([^/]+)\/([^/]+)$/, getSnapshot, true],
  ["PUT", /^\/v1\/snapshots\/([^/]+)\/([^/]+)$/, putSnapshot, true],
  ["DELETE", /^\/v1\/snapshots\/([^/]+)\/([^/]+)$/, deleteSnapshot, true],
  ["POST", /^\/v1\/change-requests$/, createChangeRequest, true],
  ["GET", /^\/v1\/change-requests$/, listChangeRequests, true],
  ["GET", /^\/v1\/change-requests\/([^/]+)$/, getChangeRequest, true],
  ["POST", /^\/v1\/change-requests\/([^/]+)\/resolve$/, resolveChangeRequest, true]
];

async function route(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/" || pathname === "/v1") {
    return json({ name: "character-hub-worker", apiVersion: API_VERSION });
  }

  let pathMatched = false;
  for (const [method, pattern, handler, needsWorld] of ROUTES) {
    const match = pathname.match(pattern);
    if (!match) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    const params = match.slice(1).map(decodeURIComponent);
    if (!needsWorld) return handler(request, env, ...params);
    const world = await authenticateWorld(request, env);
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
