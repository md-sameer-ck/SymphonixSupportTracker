// lib/turso.js
//
// Turso (libSQL/SQLite) backend — the default, fully-free path. Unlike the
// Microsoft Graph / Excel backend (lib/graphExcel.js), this needs no Azure
// AD app registration and no Microsoft 365 license: Turso's free tier
// (500 databases, generous row/storage limits) is more than enough for a
// small internal tracker. Same interface as every other backend — see
// lib/store.js for how the active one is picked.
//
// Required env vars:
//   TURSO_DATABASE_URL  - e.g. libsql://your-db-yourorg.turso.io
//   TURSO_AUTH_TOKEN    - from `turso db tokens create your-db` (not needed
//                         for a local file:./local.db database)
//
// Tables are created automatically on first use. Run `npm run seed:turso`
// once (after setting the env vars) to load the 115 already-scraped cases
// from data/seed-cases.json — see README.md "Turso setup".

const { createClient } = require("@libsql/client");
const { CASE_COLUMNS, COMMENT_COLUMNS } = require("./schema");

let client = null;
function getClient() {
  if (client) return client;
  const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } = process.env;
  if (!TURSO_DATABASE_URL) {
    throw new Error("Missing TURSO_DATABASE_URL env var — see README.md Turso setup.");
  }
  client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  return client;
}

let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  const db = getClient();
  schemaReady = (async () => {
    const caseCols = CASE_COLUMNS.filter((c) => c !== "case_number")
      .map((c) => `${c} TEXT DEFAULT ''`)
      .join(",\n        ");
    await db.execute(`CREATE TABLE IF NOT EXISTS cases (
        case_number TEXT PRIMARY KEY,
        ${caseCols}
      )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_number TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        author TEXT DEFAULT '',
        comment TEXT NOT NULL
      )`);
  })();
  return schemaReady;
}

function rowToCase(row) {
  const obj = {};
  CASE_COLUMNS.forEach((c) => {
    obj[c] = row[c] == null ? "" : row[c];
  });
  return obj;
}

function rowToComment(row) {
  return { case_number: row.case_number, timestamp: row.timestamp, author: row.author, comment: row.comment };
}

// ---------- Cases ----------

async function listCases() {
  await ensureSchema();
  const db = getClient();
  const res = await db.execute("SELECT * FROM cases");
  return res.rows.map(rowToCase);
}

async function addCase(caseObj) {
  await ensureSchema();
  const db = getClient();
  const full = { sync_status: "pending", last_synced_at: "", ...caseObj };
  const cols = CASE_COLUMNS.filter((c) => full[c] !== undefined);
  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols
    .filter((c) => c !== "case_number")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  await db.execute({
    sql: `INSERT INTO cases (${cols.join(", ")}) VALUES (${placeholders})
          ON CONFLICT(case_number) DO UPDATE SET ${updates}`,
    args: cols.map((c) => (full[c] == null ? "" : String(full[c]))),
  });
}

// Merges patch fields onto the existing row (so callers only need to pass
// what's changing), matching lib/graphExcel.js's upsertCase semantics.
async function upsertCase(caseNumber, patch) {
  await ensureSchema();
  const db = getClient();
  const cols = Object.keys(patch).filter((c) => CASE_COLUMNS.includes(c) && c !== "case_number");
  const existing = await db.execute({
    sql: "SELECT case_number FROM cases WHERE case_number = ?",
    args: [caseNumber],
  });
  if (existing.rows.length === 0) {
    return addCase({ case_number: caseNumber, ...patch });
  }
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  await db.execute({
    sql: `UPDATE cases SET ${setClause} WHERE case_number = ?`,
    args: [...cols.map((c) => (patch[c] == null ? "" : String(patch[c]))), caseNumber],
  });
}

// ---------- Comments ----------

async function listComments(caseNumber) {
  await ensureSchema();
  const db = getClient();
  const res = caseNumber
    ? await db.execute({
        sql: "SELECT case_number, timestamp, author, comment FROM comments WHERE case_number = ? ORDER BY timestamp DESC",
        args: [caseNumber],
      })
    : await db.execute("SELECT case_number, timestamp, author, comment FROM comments ORDER BY timestamp DESC");
  return res.rows.map(rowToComment);
}

async function addComment({ case_number, author, comment }) {
  await ensureSchema();
  const db = getClient();
  const timestamp = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO comments (case_number, timestamp, author, comment) VALUES (?, ?, ?, ?)",
    args: [case_number, timestamp, author || "unknown", comment],
  });
}

module.exports = { CASE_COLUMNS, COMMENT_COLUMNS, listCases, addCase, upsertCase, listComments, addComment };
