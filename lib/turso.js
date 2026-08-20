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

    // CREATE TABLE IF NOT EXISTS is a no-op on an already-seeded database, so
    // a column added to CASE_COLUMNS after the first deploy would never exist
    // in the live table. Diff the real table against the schema and ALTER in
    // whatever's missing — that way adding a column to lib/schema.js is all
    // that's needed, with no manual migration step.
    const pending = [];
    const info = await db.execute("PRAGMA table_info(cases)");
    const existing = new Set(info.rows.map((r) => r.name));
    CASE_COLUMNS.forEach((c) => { if (!existing.has(c)) pending.push(["cases", c]); });

    // Same treatment for comments — "edited_at" was added after first deploy.
    // "id" is the table's own primary key, never an ALTER candidate.
    const cInfo = await db.execute("PRAGMA table_info(comments)");
    const cExisting = new Set(cInfo.rows.map((r) => r.name));
    COMMENT_COLUMNS.forEach((c) => {
      if (c !== "id" && !cExisting.has(c)) pending.push(["comments", c]);
    });

    for (const [table, col] of pending) {
      try {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT DEFAULT ''`);
      } catch (err) {
        // SQLite has no "ADD COLUMN IF NOT EXISTS", and the check above is a
        // separate round-trip, so two functions racing on the first request
        // after a deploy can both decide to add the same column — the loser
        // gets "duplicate column name". The column exists either way, which
        // is all we wanted, so only a different error is worth failing on.
        // This matters because the dashboard's first load fires /api/cases and
        // /api/comments in parallel, as two separate function invocations.
        if (!/duplicate column name/i.test(err.message || "")) throw err;
      }
    }
  })();
  // A rejected promise would stay cached for the life of the process, turning
  // one transient failure into every later request in that container failing.
  // Clear it so the next call retries.
  schemaReady.catch(() => { schemaReady = null; });
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
  return {
    id: row.id,
    case_number: row.case_number,
    timestamp: row.timestamp,
    author: row.author,
    comment: row.comment,
    edited_at: row.edited_at == null ? "" : row.edited_at,
  };
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

const COMMENT_SELECT = "SELECT id, case_number, timestamp, author, comment, edited_at FROM comments";

async function listComments(caseNumber) {
  await ensureSchema();
  const db = getClient();
  const res = caseNumber
    ? await db.execute({
        sql: `${COMMENT_SELECT} WHERE case_number = ? ORDER BY timestamp DESC`,
        args: [caseNumber],
      })
    : await db.execute(`${COMMENT_SELECT} ORDER BY timestamp DESC`);
  return res.rows.map(rowToComment);
}

async function addComment({ case_number, author, comment }) {
  await ensureSchema();
  const db = getClient();
  const timestamp = new Date().toISOString();
  const res = await db.execute({
    sql: "INSERT INTO comments (case_number, timestamp, author, comment, edited_at) VALUES (?, ?, ?, ?, '')",
    args: [case_number, timestamp, author || "unknown", comment],
  });
  return { id: Number(res.lastInsertRowid), timestamp };
}

// Edits a note's text in place, stamping edited_at so the UI can show that it
// was changed after the fact rather than silently rewriting history. The
// original timestamp (when the note was first written) is never touched.
async function updateComment(id, comment) {
  await ensureSchema();
  const db = getClient();
  const res = await db.execute({
    sql: "UPDATE comments SET comment = ?, edited_at = ? WHERE id = ?",
    args: [comment, new Date().toISOString(), id],
  });
  return res.rowsAffected > 0;
}

async function deleteComment(id) {
  await ensureSchema();
  const db = getClient();
  const res = await db.execute({ sql: "DELETE FROM comments WHERE id = ?", args: [id] });
  return res.rowsAffected > 0;
}

module.exports = {
  CASE_COLUMNS,
  COMMENT_COLUMNS,
  listCases,
  addCase,
  upsertCase,
  listComments,
  addComment,
  updateComment,
  deleteComment,
};
