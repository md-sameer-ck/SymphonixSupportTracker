// lib/localStore.js
//
// A JSON-file-backed implementation of the exact same interface as
// lib/graphExcel.js. Used automatically (see lib/store.js) whenever the
// MS_DRIVE_ID / MS_FILE_ID env vars aren't set, so you can run the site and
// click through Add case / comments / edits locally before Azure AD /
// Microsoft Graph are wired up. NOT used in production — Netlify Functions'
// filesystem doesn't reliably persist writes between invocations, so this
// is strictly a local/dev convenience.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CASES_FILE = path.join(DATA_DIR, "local-cases.json");
const COMMENTS_FILE = path.join(DATA_DIR, "local-comments.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function seedCasesIfMissing() {
  if (fs.existsSync(CASES_FILE)) return;
  const seedPath = path.join(DATA_DIR, "seed-cases.json");
  const seed = readJson(seedPath, []);
  const mapped = seed.map((s) => ({
    case_number: s.case_number || "",
    subject: s.subject || "",
    status: s.status || "",
    priority: s.priority || "",
    urgency: s.urgency || "",
    product_category: s.product_category || "",
    product: s.product || "",
    type: s.type || "",
    case_origin: s.case_origin || "",
    owner: s.owner || "",
    contact_name: s.contact_name || "",
    account_name: s.account_name || "",
    date_opened: s.date_opened || "",
    date_closed: s.date_closed || "",
    description: s.description || "",
    exec_summary: s.issue_summary || "",
    raw_comments: [s.case_fix ? `FIX: ${s.case_fix}` : "", s.case_discussion ? `DISCUSSION: ${s.case_discussion}` : ""].filter(Boolean).join("\n\n"),
    current_status_note: s.current_status || "",
    sync_status: "synced",
    last_synced_at: new Date().toISOString(),
    added_by: "initial import",
  }));
  writeJson(CASES_FILE, mapped);
}

async function listCases() {
  seedCasesIfMissing();
  return readJson(CASES_FILE, []);
}

async function addCase(caseObj) {
  seedCasesIfMissing();
  const cases = readJson(CASES_FILE, []);
  cases.push({ sync_status: "pending", last_synced_at: "", ...caseObj });
  writeJson(CASES_FILE, cases);
}

async function upsertCase(caseNumber, patch) {
  seedCasesIfMissing();
  const cases = readJson(CASES_FILE, []);
  const idx = cases.findIndex((c) => String(c.case_number) === String(caseNumber));
  if (idx === -1) cases.push({ case_number: caseNumber, ...patch });
  else cases[idx] = { ...cases[idx], ...patch };
  writeJson(CASES_FILE, cases);
}

async function listComments(caseNumber) {
  const all = readJson(COMMENTS_FILE, []);
  if (!caseNumber) return all;
  return all.filter((c) => String(c.case_number) === String(caseNumber));
}

async function addComment({ case_number, author, comment }) {
  const all = readJson(COMMENTS_FILE, []);
  all.push({ case_number, author, comment, timestamp: new Date().toISOString() });
  writeJson(COMMENTS_FILE, all);
}

module.exports = { listCases, addCase, upsertCase, listComments, addComment };
