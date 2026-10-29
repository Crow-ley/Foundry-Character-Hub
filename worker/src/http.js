export const API_VERSION = 1;

/** Highest snapshot/change request schema version this Worker understands. */
export const MAX_SCHEMA_VERSION = 1;

/** D1 rejects rows over 2,000,000 bytes, so leave a little room for the other columns. */
export const MAX_ROW_BYTES = 1_900_000;

// Foundry clients call from whatever host the world runs on, and auth is a bearer header
// (never cookies), so any origin is allowed.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400"
};

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Respond with JSON text that is already serialized. */
export function rawJson(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headers }
  });
}

export function json(body, status = 200, headers = {}) {
  return rawJson(JSON.stringify(body), status, headers);
}

export function noContent() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message } }, err.status, err.headers);
  }
  console.error(err);
  return json({ error: { code: "internal_error", message: "Unexpected server error." } }, 500);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be valid JSON.");
  }
}

export function nowIso() {
  return new Date().toISOString();
}

// Foundry document IDs and home world IDs are short alphanumeric strings.
const ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export function requireId(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new HttpError(400, "bad_request", `${field} must be 1-64 letters or digits.`);
  }
  return value;
}

export function requireInt(value, field, { min = 0 } = {}) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < min) {
    throw new HttpError(400, "bad_request", `${field} must be a whole number of at least ${min}.`);
  }
  return n;
}

export function requireSchemaVersion(value) {
  const v = requireInt(value, "schemaVersion", { min: 1 });
  if (v > MAX_SCHEMA_VERSION) {
    throw new HttpError(422, "schema_unsupported",
      `Schema version ${v} is newer than this Worker supports (${MAX_SCHEMA_VERSION}). Update the Worker.`);
  }
  return v;
}

export function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, "bad_request", `${field} must be text of at most ${maxLength} characters.`);
  }
  return value;
}
