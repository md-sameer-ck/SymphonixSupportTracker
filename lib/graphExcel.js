// lib/graphExcel.js
//
// Thin client over the Microsoft Graph "workbook" API, used to read/write an
// Excel file stored in OneDrive/SharePoint without ever downloading the whole
// file. Shared by the Netlify Functions (read/write from the live site) and
// the GitHub Actions scraper script (writes scraped case data).
//
// Required environment variables (see README.md "Azure AD app registration"):
//   MS_TENANT_ID      - Azure AD tenant ID
//   MS_CLIENT_ID      - App registration (client) ID
//   MS_CLIENT_SECRET  - App registration client secret
//   MS_DRIVE_ID       - The OneDrive/SharePoint drive ID that holds the file
//   MS_FILE_ID        - The workbook's drive-item ID
//
// The workbook must contain two native Excel Tables (Insert > Table, not just
// a styled range) named exactly:
//   CasesTable    - columns: see CASE_COLUMNS below, in that exact order
//   CommentsTable - columns: see COMMENT_COLUMNS below, in that exact order
//
// scripts/seed-from-json.js builds a workbook with this exact structure from
// the already-scraped case data, so you have a ready-to-upload starting file.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const { CASE_COLUMNS, COMMENT_COLUMNS } = require("./schema");

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry - 30_000) return cachedToken;

  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error(
      "Missing MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET env vars — see README.md setup."
    );
  }

  const url = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MS Graph token request failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiry = now + json.expires_in * 1000;
  return cachedToken;
}

function workbookBase() {
  const { MS_DRIVE_ID, MS_FILE_ID } = process.env;
  if (!MS_DRIVE_ID || !MS_FILE_ID) {
    throw new Error("Missing MS_DRIVE_ID / MS_FILE_ID env vars — see README.md setup.");
  }
  return `${GRAPH_BASE}/drives/${MS_DRIVE_ID}/items/${MS_FILE_ID}/workbook`;
}

async function graphFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${workbookBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph request failed (${res.status}) ${path}: ${text}`);
  }
  // 204 No Content on some PATCH/POST calls
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rowsToObjects(rowsValues, columns) {
  return rowsValues.map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i] === undefined || row[i] === null ? "" : row[i];
    });
    return obj;
  });
}

function objectToRow(obj, columns) {
  return columns.map((col) => (obj[col] === undefined || obj[col] === null ? "" : obj[col]));
}

// ---------- Generic table helpers ----------

async function listTableRows(tableName, columns) {
  const data = await graphFetch(`/tables('${tableName}')/rows`);
  const values = (data.value || []).map((r) => r.values[0]);
  return rowsToObjects(values, columns);
}

async function findRowIndex(tableName, keyColumn, keyValue, columns) {
  const rows = await listTableRows(tableName, columns);
  const idx = rows.findIndex((r) => String(r[keyColumn]) === String(keyValue));
  return { idx, rows };
}

async function addTableRow(tableName, obj, columns) {
  const row = objectToRow(obj, columns);
  return graphFetch(`/tables('${tableName}')/rows/add`, {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
}

async function updateTableRow(tableName, rowIndex, obj, columns) {
  const row = objectToRow(obj, columns);
  return graphFetch(`/tables('${tableName}')/rows/itemAt(index=${rowIndex})`, {
    method: "PATCH",
    body: JSON.stringify({ values: [row] }),
  });
}

// ---------- Cases ----------

async function listCases() {
  return listTableRows("CasesTable", CASE_COLUMNS);
}

async function addCase(caseObj) {
  const full = { sync_status: "pending", last_synced_at: "", ...caseObj };
  return addTableRow("CasesTable", full, CASE_COLUMNS);
}

// Merges patch fields onto the existing row (so callers only need to pass
// what's changing) and writes the row back at its current index.
async function upsertCase(caseNumber, patch) {
  const { idx, rows } = await findRowIndex("CasesTable", "case_number", caseNumber, CASE_COLUMNS);
  if (idx === -1) {
    return addCase({ case_number: caseNumber, ...patch });
  }
  const merged = { ...rows[idx], ...patch };
  return updateTableRow("CasesTable", idx, merged, CASE_COLUMNS);
}

// ---------- Comments ----------

async function listComments(caseNumber) {
  const all = await listTableRows("CommentsTable", COMMENT_COLUMNS);
  if (!caseNumber) return all;
  return all.filter((c) => String(c.case_number) === String(caseNumber));
}

async function addComment({ case_number, author, comment }) {
  const timestamp = new Date().toISOString();
  return addTableRow(
    "CommentsTable",
    { case_number, timestamp, author, comment },
    COMMENT_COLUMNS
  );
}

module.exports = {
  CASE_COLUMNS,
  COMMENT_COLUMNS,
  listCases,
  addCase,
  upsertCase,
  listComments,
  addComment,
};
