import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDbError, db, secondsUntilUtcMidnight } from "../src/db.js";

test("daily limit errors become sync_paused with Retry-After", () => {
  for (const message of [
    "D1_ERROR: Exceeded daily row read limit",
    "Your account has exceeded its free tier quota",
    "Too many requests"
  ]) {
    const err = classifyDbError(new Error(message));
    assert.equal(err.status, 503, message);
    assert.equal(err.code, "sync_paused", message);
    assert.ok(Number(err.headers["Retry-After"]) > 0);
  }
});

test("full database is reported as storage_full", () => {
  const err = classifyDbError(new Error("D1_ERROR: Exceeded maximum DB size"));
  assert.equal(err.code, "storage_full");
  assert.equal(err.status, 507);
});

test("oversized rows are reported as too_large", () => {
  assert.equal(classifyDbError(new Error("SQLITE_TOOBIG: string or blob too big")).code, "too_large");
});

test("other errors are storage_error", () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(classifyDbError(new Error("no such table: snapshots")).code, "storage_error");
  } finally {
    console.error = original;
  }
});

test("db() wraps thrown D1 errors", async () => {
  await assert.rejects(db(async () => { throw new Error("exceeded daily limit"); }), { code: "sync_paused" });
});

test("seconds until UTC midnight", () => {
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-28T23:59:00Z")), 60);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-28T00:00:00Z")), 86400);
});
