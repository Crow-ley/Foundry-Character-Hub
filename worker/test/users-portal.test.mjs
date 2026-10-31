// User lists and the read-only portal key, run against the real Worker code with an in-memory
// SQLite database standing in for D1. Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { cleanUsers } from "../src/routes/users.js";

// Cloudflare adds timingSafeEqual to crypto.subtle; Node keeps it in node:crypto.
if (!crypto.subtle.timingSafeEqual) {
  const { timingSafeEqual } = await import("node:crypto");
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

const ADMIN = "test-admin-key";
const PORTAL = "test-portal-key";
const MIGRATIONS = new URL("../migrations/", import.meta.url);

/** Just enough of D1's API for the Worker's queries. */
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
        async run() { const r = sqlite.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; }
      };
      return statement;
    }
  };
}

let env, homeA, homeB, hub;

async function call(method, path, { key, body, raw } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await worker.fetch(new Request("https://hub.test" + path, { method, headers, body: payload }), env);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function register(role, worldId) {
  const r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role, worldId } });
  assert.ok(r.status === 201, JSON.stringify(r));
  return r.json.key;
}

const playersA = [{ id: "userA0000000001", name: "Player One" }, { id: "userA0000000002", name: "Player Two" }];

beforeEach(async () => {
  env = { ADMIN_KEY: ADMIN, PORTAL_KEY: PORTAL, DB: fakeD1() };
  homeA = await register("home", "homeA");
  homeB = await register("home", "homeB");
  hub = await register("hub", "hub");
});

test("a home world pushes its list; version goes up on each push", async () => {
  let r = await call("PUT", "/v1/users/homeA", { key: homeA, body: { schemaVersion: 1, users: playersA } });
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 1);
  assert.equal(r.json.count, 2);
  r = await call("PUT", "/v1/users/homeA", { key: homeA, body: { schemaVersion: 1, users: playersA.slice(0, 1) } });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 2);
  r = await call("GET", "/v1/users/homeA", { key: homeA });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.users, playersA.slice(0, 1));
});

test("only id and name are kept; names are trimmed", async () => {
  const users = [{ id: "userA0000000001", name: "  Player One ", password: "x", role: 4, email: "a@b.c" }];
  await call("PUT", "/v1/users/homeA", { key: homeA, body: { schemaVersion: 1, users } });
  const r = await call("GET", "/v1/users/homeA", { key: PORTAL });
  assert.deepEqual(r.json.users, [{ id: "userA0000000001", name: "Player One" }]);
});

test("bad lists are refused", async () => {
  const cases = [
    { schemaVersion: 1, users: "nope" },
    { schemaVersion: 1, users: [{ id: "bad id!", name: "x" }] },
    { schemaVersion: 1, users: [{ id: "user1", name: "" }] },
    { schemaVersion: 1, users: [{ id: "user1", name: "x".repeat(101) }] },
    { schemaVersion: 1, users: [{ id: "user1", name: "a" }, { id: "user1", name: "b" }] },
    { schemaVersion: 1, users: [null] },
    { users: playersA },
    { schemaVersion: 1, users: Array.from({ length: 301 }, (_, i) => ({ id: `u${i}`, name: "x" })) }
  ];
  for (const body of cases) {
    const r = await call("PUT", "/v1/users/homeA", { key: homeA, body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  let r = await call("PUT", "/v1/users/homeA", { key: homeA, body: { schemaVersion: 2, users: playersA } });
  assert.equal(r.status, 422);
  r = await call("PUT", "/v1/users/homeA", { key: homeA, raw: "{oops" });
  assert.equal(r.json.error.code, "bad_json");
  r = await call("PUT", "/v1/users/homeA", { key: homeA, raw: `{"pad":"${"x".repeat(70_000)}"}` });
  assert.equal(r.status, 413);
});

test("home worlds only reach their own list; the hub key reaches none", async () => {
  await call("PUT", "/v1/users/homeA", { key: homeA, body: { schemaVersion: 1, users: playersA } });
  assert.equal((await call("PUT", "/v1/users/homeA", { key: homeB, body: { schemaVersion: 1, users: [] } })).status, 403);
  assert.equal((await call("GET", "/v1/users/homeA", { key: homeB })).status, 403);
  assert.equal((await call("GET", "/v1/users", { key: homeA })).status, 403);
  assert.equal((await call("GET", "/v1/users/homeA", { key: hub })).status, 403);
  assert.equal((await call("GET", "/v1/users", { key: hub })).status, 403);
  assert.equal((await call("PUT", "/v1/users/hub", { key: hub, body: { schemaVersion: 1, users: [] } })).status, 403);
});

test("portal key reads every world's list, and one world's", async () => {
  await call("PUT", "/v1/users/homeA", { key: homeA, body: { schemaVersion: 1, users: playersA } });
  await call("PUT", "/v1/users/homeB", { key: homeB, body: { schemaVersion: 1, users: [{ id: "userB0000000001", name: "B" }] } });
  let r = await call("GET", "/v1/users", { key: PORTAL });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.worlds.map(w => w.homeWorldId), ["homeA", "homeB"]);
  r = await call("GET", "/v1/users/homeB", { key: PORTAL });
  assert.equal(r.json.users[0].name, "B");
  r = await call("GET", "/v1/users/homeZ", { key: PORTAL });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "users_not_found");
  r = await call("GET", "/v1/me", { key: PORTAL });
  assert.equal(r.json.role, "portal");
  assert.equal(r.json.worldId, null);
});

test("portal key is refused everywhere else, before touching any data", async () => {
  await call("PUT", "/v1/snapshots/homeA/actor0000000001?schemaVersion=1", { key: homeA, raw: '{"_id":"actor0000000001"}' });
  const refused = [
    ["GET", "/v1/snapshots"],
    ["GET", "/v1/snapshots?include=data"],
    ["GET", "/v1/snapshots/homeA/actor0000000001"],
    ["PUT", "/v1/snapshots/homeA/actor0000000001?schemaVersion=1", "{}"],
    ["DELETE", "/v1/snapshots/homeA/actor0000000001"],
    ["POST", "/v1/change-requests", "{}"],
    ["GET", "/v1/change-requests"],
    ["GET", "/v1/change-requests/abc"],
    ["POST", "/v1/change-requests/abc/resolve", "{}"],
    ["PUT", "/v1/users/homeA", JSON.stringify({ schemaVersion: 1, users: [] })]
  ];
  for (const [method, path, raw] of refused) {
    const r = await call(method, path, { key: PORTAL, raw });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.error.code, "forbidden", `${method} ${path}`);
  }
  // Admin routes don't accept it either.
  for (const [method, path] of [["GET", "/v1/worlds"], ["POST", "/v1/worlds"], ["DELETE", "/v1/worlds/homeA"]]) {
    assert.equal((await call(method, path, { key: PORTAL, raw: method === "POST" ? '{"role":"home","worldId":"x"}' : undefined })).status, 401);
  }
  // The snapshot is untouched.
  assert.equal((await call("GET", "/v1/snapshots/homeA/actor0000000001", { key: hub })).status, 200);
});

test("without PORTAL_KEY set, no key is treated as the portal", async () => {
  delete env.PORTAL_KEY;
  assert.equal((await call("GET", "/v1/users", { key: PORTAL })).status, 401);
  assert.equal((await call("GET", "/v1/users", { key: "" })).status, 401);
});

test("cleanUsers accepts an empty list", () => {
  assert.deepEqual(cleanUsers([]), []);
});
