// Exercises every endpoint against a running Worker.
// Usage: node test/endpoints.mjs [baseUrl] [adminKey] [portalKey]
// Defaults match `npm run dev` with the values in .dev.vars.example.
// Uses throwaway world IDs, but still only point it at a test database.

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const ADMIN = process.argv[3] ?? "local-test-admin-key";
const PORTAL = process.argv[4] ?? "local-test-portal-key";
const RUN = Date.now().toString(36);
const HOME_A = `testA${RUN}`;
const HOME_B = `testB${RUN}`;
const HUB = `testHub${RUN}`;

let passed = 0;
let failed = 0;

async function call(method, path, { key, body, raw } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

async function main() {
  console.log(`Testing ${BASE}\n`);

  console.log("Health and CORS");
  let r = await call("GET", "/");
  check("GET / responds with apiVersion", r.status === 200 && r.json?.apiVersion === 1, r);
  const pre = await fetch(`${BASE}/v1/snapshots`, { method: "OPTIONS" });
  check("OPTIONS preflight allows any origin", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*");
  r = await call("GET", "/v1/nope");
  check("unknown path is 404 not_found", r.status === 404 && r.json?.error?.code === "not_found", r);
  r = await call("PATCH", "/v1/snapshots");
  check("wrong method is 405", r.status === 405, r);

  console.log("\nRegister worlds (admin)");
  r = await call("POST", "/v1/worlds", { body: { role: "home", worldId: HOME_A } });
  check("register without admin key is 401", r.status === 401, r);
  r = await call("POST", "/v1/worlds", { key: "wrong", body: { role: "home", worldId: HOME_A } });
  check("register with wrong admin key is 401", r.status === 401, r);
  r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role: "home", worldId: HOME_A, name: "Test A" } });
  check("register home A is 201 with key", r.status === 201 && r.json?.key?.startsWith("chh_home_"), r);
  let homeA = r.json?.key;
  r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role: "home", worldId: HOME_B } });
  const homeB = r.json?.key;
  check("register home B", r.status === 201, r);
  r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role: "hub", worldId: HUB, name: "Test hub" } });
  const hub = r.json?.key;
  check("register hub", r.status === 201 && hub?.startsWith("chh_hub_"), r);
  r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role: "hub", worldId: HOME_A } });
  check("re-registering with a different role is 409", r.status === 409 && r.json?.error?.code === "role_conflict", r);
  r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role: "home" } });
  check("home without worldId is 400", r.status === 400, r);
  r = await call("GET", "/v1/worlds", { key: ADMIN });
  check("list worlds includes all three, no key hashes",
    r.status === 200 && [HOME_A, HOME_B, HUB].every(id => r.json.worlds.some(w => w.worldId === id))
      && !JSON.stringify(r.json).includes("key_hash"), r);

  console.log("\nRotate a key");
  r = await call("POST", "/v1/worlds", { key: ADMIN, body: { role: "home", worldId: HOME_A } });
  check("re-register home A rotates its key", r.status === 200 && r.json?.rotated === true && r.json.key !== homeA, r);
  const oldHomeA = homeA;
  homeA = r.json?.key;
  r = await call("GET", "/v1/me", { key: oldHomeA });
  check("old key no longer works", r.status === 401, r);

  console.log("\nWho am I");
  r = await call("GET", "/v1/me", { key: homeA });
  check("home key identifies as home A", r.status === 200 && r.json?.role === "home" && r.json.worldId === HOME_A, r);
  r = await call("GET", "/v1/me", { key: hub });
  check("hub key identifies as hub", r.json?.role === "hub", r);
  r = await call("GET", "/v1/me");
  check("no key is 401", r.status === 401, r);

  console.log("\nPut snapshots");
  const actor = { _id: "actor0000000001", name: "Brakka", type: "character", system: { attributes: { hp: { value: 12 } } }, flags: { "midi-qol": { x: 1 } } };
  const putPath = `/v1/snapshots/${HOME_A}/actor0000000001?schemaVersion=1&systemVersion=6.0.5&name=Brakka`;
  r = await call("PUT", putPath, { key: homeA, raw: JSON.stringify(actor) });
  check("first push is 201, version 1", r.status === 201 && r.json?.version === 1, r);
  actor.system.attributes.hp.value = 9;
  r = await call("PUT", putPath, { key: homeA, raw: JSON.stringify(actor) });
  check("second push is 200, version 2", r.status === 200 && r.json?.version === 2, r);
  r = await call("PUT", `/v1/snapshots/${HOME_A}/actor0000000002?schemaVersion=1&name=Ilsa`, { key: homeA, raw: '{"_id":"actor0000000002","name":"Ilsa"}' });
  check("second character", r.status === 201, r);
  r = await call("PUT", `/v1/snapshots/${HOME_B}/actorB000000001?schemaVersion=1`, { key: homeB, raw: '{"_id":"actorB000000001"}' });
  check("home B pushes its own character", r.status === 201, r);
  r = await call("PUT", `/v1/snapshots/${HOME_B}/actor0000000009?schemaVersion=1`, { key: homeA, raw: "{}" });
  check("home A cannot push into home B", r.status === 403, r);
  r = await call("PUT", putPath, { key: hub, raw: "{}" });
  check("hub key cannot push snapshots", r.status === 403, r);
  r = await call("PUT", `/v1/snapshots/${HOME_A}/actor0000000001?schemaVersion=2`, { key: homeA, raw: "{}" });
  check("schemaVersion newer than Worker is 422 schema_unsupported", r.status === 422 && r.json?.error?.code === "schema_unsupported", r);
  r = await call("PUT", `/v1/snapshots/${HOME_A}/actor0000000001`, { key: homeA, raw: "{}" });
  check("missing schemaVersion is 400", r.status === 400, r);
  r = await call("PUT", `/v1/snapshots/${HOME_A}/actor0000000001?schemaVersion=1`, { key: homeA, raw: "not json" });
  check("non-object body is 400", r.status === 400, r);
  r = await call("PUT", `/v1/snapshots/${HOME_A}/bad-id!?schemaVersion=1`, { key: homeA, raw: "{}" });
  check("bad actor ID is 400", r.status === 400, r);
  const big = `{"pad":"${"x".repeat(1_950_000)}"}`;
  r = await call("PUT", `/v1/snapshots/${HOME_A}/actor0000000003?schemaVersion=1`, { key: homeA, raw: big });
  check("oversized snapshot is 413 snapshot_too_large", r.status === 413 && r.json?.error?.code === "snapshot_too_large", r);

  console.log("\nGet snapshots");
  r = await call("GET", `/v1/snapshots?homeWorldId=${HOME_A}`, { key: hub });
  check("hub lists home A metadata without data",
    r.status === 200 && r.json?.snapshots?.length === 2 && r.json.snapshots[0].data === undefined
      && r.json.snapshots.find(s => s.actorId === "actor0000000001")?.version === 2, r);
  r = await call("GET", `/v1/snapshots?homeWorldId=${HOME_A}&actorIds=actor0000000001&include=data`, { key: hub });
  const snap = r.json?.snapshots?.[0];
  check("hub gets full data by actor ID, whole actor intact",
    r.json?.snapshots?.length === 1 && snap.data.system.attributes.hp.value === 9 && snap.data.flags["midi-qol"].x === 1
      && snap.systemVersion === "6.0.5" && snap.name === "Brakka", r);
  r = await call("GET", `/v1/snapshots?actorIds=actor0000000002,actorB000000001`, { key: hub });
  check("hub can ask by actor IDs across worlds", r.json?.snapshots?.length === 2, r);
  r = await call("GET", "/v1/snapshots", { key: homeA });
  check("home A listing defaults to its own world", r.json?.snapshots?.every(s => s.homeWorldId === HOME_A) && r.json.snapshots.length === 2, r);
  r = await call("GET", `/v1/snapshots?homeWorldId=${HOME_B}`, { key: homeA });
  check("home A cannot list home B", r.status === 403, r);
  r = await call("GET", `/v1/snapshots/${HOME_A}/actor0000000001`, { key: hub });
  check("get one snapshot", r.status === 200 && r.json?.data?.name === "Brakka" && r.json.version === 2, r);
  r = await call("GET", `/v1/snapshots/${HOME_A}/actor0000000099`, { key: hub });
  check("missing snapshot is 404", r.status === 404 && r.json?.error?.code === "snapshot_not_found", r);

  console.log("\nChange requests");
  const cr = {
    homeWorldId: HOME_A, actorId: "actor0000000001", baseVersion: 2, schemaVersion: 1,
    submittedBy: "Player One", submittedById: "user00000000001",
    diff: { system: { "attributes.hp.value": { before: 9, after: 14 } }, items: { added: [], removed: [], modified: [] } }
  };
  r = await call("POST", "/v1/change-requests", { key: homeA, body: cr });
  check("home key cannot submit change requests", r.status === 403, r);
  r = await call("POST", "/v1/change-requests", { key: hub, body: cr });
  check("hub submits a change request", r.status === 201 && r.json?.status === "pending" && r.json.currentVersion === 2, r);
  const crId = r.json?.id;
  r = await call("POST", "/v1/change-requests", { key: hub, body: { ...cr, actorId: "actor0000000002", baseVersion: 1 } });
  const crId2 = r.json?.id;
  check("second change request", r.status === 201, r);
  r = await call("POST", "/v1/change-requests", { key: hub, body: { ...cr, baseVersion: 5 } });
  check("baseVersion newer than snapshot is 422", r.status === 422, r);
  r = await call("POST", "/v1/change-requests", { key: hub, body: { ...cr, actorId: "actor0000000099" } });
  check("request for unknown character is 404", r.status === 404, r);
  r = await call("POST", "/v1/change-requests", { key: hub, body: { ...cr, type: "create" } });
  check('type "create" is not accepted yet', r.status === 400, r);
  r = await call("POST", "/v1/change-requests", { key: hub, body: { ...cr, diff: "nope" } });
  check("non-object diff is 400", r.status === 400, r);
  r = await call("POST", "/v1/change-requests", { key: hub, raw: "{oops" });
  check("bad JSON is 400 bad_json", r.status === 400 && r.json?.error?.code === "bad_json", r);

  r = await call("GET", "/v1/change-requests?status=pending&include=diff", { key: homeA });
  check("home A lists its pending requests with diffs",
    r.status === 200 && r.json?.changeRequests?.length === 2
      && r.json.changeRequests[0].diff?.system?.["attributes.hp.value"]?.after === 14, r);
  r = await call("GET", "/v1/change-requests", { key: homeB });
  check("home B sees none of home A's requests", r.json?.changeRequests?.length === 0, r);
  r = await call("GET", `/v1/change-requests?homeWorldId=${HOME_A}`, { key: homeB });
  check("home B cannot ask for home A's requests", r.status === 403, r);
  r = await call("GET", `/v1/change-requests?homeWorldId=${HOME_A}&actorId=actor0000000001`, { key: hub });
  check("hub checks status by actor, no diff by default",
    r.json?.changeRequests?.length === 1 && r.json.changeRequests[0].diff === undefined, r);
  r = await call("GET", "/v1/change-requests?status=bogus", { key: hub });
  check("bad status filter is 400", r.status === 400, r);
  r = await call("GET", `/v1/change-requests/${crId}`, { key: homeA });
  check("get one request includes diff", r.status === 200 && r.json?.diff && r.json.submittedBy === "Player One", r);
  r = await call("GET", `/v1/change-requests/${crId}`, { key: homeB });
  check("other home world cannot read it", r.status === 403, r);

  console.log("\nResolve change requests");
  r = await call("POST", `/v1/change-requests/${crId}/resolve`, { key: hub, body: { status: "approved" } });
  check("hub key cannot resolve", r.status === 403, r);
  r = await call("POST", `/v1/change-requests/${crId}/resolve`, { key: homeB, body: { status: "approved" } });
  check("other home world cannot resolve", r.status === 404, r);
  r = await call("POST", `/v1/change-requests/${crId}/resolve`, { key: homeA, body: { status: "maybe" } });
  check("bad status is 400", r.status === 400, r);
  r = await call("POST", `/v1/change-requests/${crId}/resolve`, { key: homeA, body: { status: "approved", resolvedBy: "GM" } });
  check("home A approves", r.status === 200 && r.json?.status === "approved" && r.json.resolvedAt, r);
  r = await call("POST", `/v1/change-requests/${crId}/resolve`, { key: homeA, body: { status: "rejected" } });
  check("resolving twice is 409 already_resolved", r.status === 409 && r.json?.error?.code === "already_resolved", r);
  r = await call("POST", `/v1/change-requests/${crId2}/resolve`, { key: homeA,
    body: { status: "partial", resolution: { approved: ["system.attributes.hp.value"], rejected: [] } } });
  check("partial resolution with details", r.status === 200 && r.json?.status === "partial", r);
  r = await call("GET", `/v1/change-requests/${crId2}`, { key: hub });
  check("hub sees the resolution", r.json?.resolution?.approved?.[0] === "system.attributes.hp.value", r);
  r = await call("GET", "/v1/change-requests?status=pending", { key: homeA });
  check("nothing left pending", r.json?.changeRequests?.length === 0, r);
  r = await call("POST", "/v1/change-requests/does-not-exist/resolve", { key: homeA, body: { status: "approved" } });
  check("unknown request is 404", r.status === 404, r);

  console.log("\nUser lists and the portal key");
  const players = [{ id: "user00000000001", name: "Player One" }, { id: "user00000000002", name: "Player Two" }];
  r = await call("PUT", `/v1/users/${HOME_A}`, { key: homeA, body: { schemaVersion: 1, users: players } });
  check("home A pushes its user list", r.status === 201 && r.json?.count === 2, r);
  r = await call("PUT", `/v1/users/${HOME_A}`, { key: homeB, body: { schemaVersion: 1, users: [] } });
  check("home B cannot push home A's list", r.status === 403, r);
  r = await call("GET", `/v1/users/${HOME_A}`, { key: hub });
  check("hub key cannot read user lists", r.status === 403, r);
  r = await call("GET", "/v1/me", { key: PORTAL });
  check("portal key identifies as portal", r.status === 200 && r.json?.role === "portal", r);
  r = await call("GET", `/v1/users/${HOME_A}`, { key: PORTAL });
  check("portal reads home A's list", r.status === 200 && r.json?.users?.[1]?.name === "Player Two", r);
  r = await call("GET", "/v1/users", { key: PORTAL });
  check("portal lists every world's users", r.status === 200 && r.json?.worlds?.some(w => w.homeWorldId === HOME_A), r);
  r = await call("GET", `/v1/snapshots?homeWorldId=${HOME_A}`, { key: PORTAL });
  check("portal cannot read snapshots (yet)", r.status === 403, r);
  r = await call("POST", "/v1/change-requests", { key: PORTAL, body: cr });
  check("portal cannot submit change requests", r.status === 403, r);
  r = await call("PUT", `/v1/users/${HOME_A}`, { key: PORTAL, body: { schemaVersion: 1, users: [] } });
  check("portal cannot write user lists", r.status === 403, r);

  console.log("\nDelete and revoke");
  r = await call("DELETE", `/v1/snapshots/${HOME_A}/actor0000000002`, { key: hub });
  check("hub cannot delete snapshots", r.status === 403, r);
  r = await call("DELETE", `/v1/snapshots/${HOME_A}/actor0000000002`, { key: homeA });
  check("home A deletes a snapshot", r.status === 204, r);
  r = await call("DELETE", `/v1/snapshots/${HOME_A}/actor0000000002`, { key: homeA });
  check("deleting again is 404", r.status === 404, r);
  for (const id of [HOME_A, HOME_B, HUB]) {
    r = await call("DELETE", `/v1/worlds/${id}`, { key: ADMIN });
    check(`revoke ${id}`, r.status === 204, r);
  }
  r = await call("GET", "/v1/me", { key: hub });
  check("revoked key is 401", r.status === 401, r);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
