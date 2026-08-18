// scripts/seed-from-json.js
//
// Builds the initial workbook (Folk2Folk_Q2_Support_Cases_Tracker.xlsx) with
// the exact structure the app expects: a "Cases" sheet holding an Excel
// Table named CasesTable, and a "Comments" sheet holding CommentsTable —
// pre-loaded with the 115 cases already pulled from the Q2 portal.
//
// Run:  npm run seed
// Then: upload the resulting file to OneDrive/SharePoint and follow
// README.md to point MS_DRIVE_ID / MS_FILE_ID at it.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { CASE_COLUMNS, COMMENT_COLUMNS } = require("../lib/graphExcel");

const SEED_PATH = path.join(__dirname, "..", "data", "seed-cases.json");
const OUT_PATH = path.join(__dirname, "..", "data", "Folk2Folk_Q2_Support_Cases_Tracker.xlsx");

const HEADER_LABELS = {
  case_number: "Case Number",
  subject: "Subject",
  status: "Status",
  priority: "Priority",
  urgency: "Urgency",
  product_category: "Product Category",
  product: "Product",
  type: "Type",
  case_origin: "Case Origin",
  owner: "Owner",
  contact_name: "Contact Name",
  account_name: "Account Name",
  date_opened: "Date Opened",
  date_closed: "Date Closed",
  description: "Description",
  exec_summary: "Exec Summary",
  raw_comments: "Raw Comments (from portal)",
  current_status_note: "Current Status Note",
  sync_status: "Sync Status",
  last_synced_at: "Last Synced At",
  added_by: "Added By",
};

function mapSeedRowToCaseRow(seed) {
  // The seed data (from the manual Claude-assisted pull) used a slightly
  // different schema (issue_summary / case_fix / case_discussion /
  // current_status). Fold those into the new schema's closest fields —
  // raw_comments won't have the verbatim portal thread until the case is
  // re-synced (use the "Refresh from portal" action in the UI to backfill).
  const combinedNote = [
    seed.case_fix ? `FIX: ${seed.case_fix}` : "",
    seed.case_discussion ? `DISCUSSION: ${seed.case_discussion}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    case_number: seed.case_number || "",
    subject: seed.subject || "",
    status: seed.status || "",
    priority: seed.priority || "",
    urgency: seed.urgency || "",
    product_category: seed.product_category || "",
    product: seed.product || "",
    type: seed.type || "",
    case_origin: seed.case_origin || "",
    owner: seed.owner || "",
    contact_name: seed.contact_name || "",
    account_name: seed.account_name || "",
    date_opened: seed.date_opened || "",
    date_closed: seed.date_closed || "",
    description: seed.description || "",
    exec_summary: seed.issue_summary || "",
    raw_comments: `(imported from initial dataset — not yet re-synced verbatim)\n\n${combinedNote}`,
    current_status_note: seed.current_status || "",
    sync_status: "synced",
    last_synced_at: new Date().toISOString(),
    added_by: "initial import",
  };
}

async function main() {
  const seedRows = JSON.parse(fs.readFileSync(SEED_PATH, "utf-8"));

  const wb = new ExcelJS.Workbook();

  // --- Cases sheet ---
  const casesSheet = wb.addWorksheet("Cases");
  casesSheet.addTable({
    name: "CasesTable",
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: CASE_COLUMNS.map((key) => ({ name: HEADER_LABELS[key] || key })),
    rows: seedRows.map((seed) => CASE_COLUMNS.map((key) => mapSeedRowToCaseRow(seed)[key])),
  });
  CASE_COLUMNS.forEach((key, i) => {
    const col = casesSheet.getColumn(i + 1);
    col.width = ["description", "raw_comments", "current_status_note", "exec_summary", "subject"].includes(key)
      ? 46
      : 18;
  });
  casesSheet.getRow(1).font = { bold: true };
  casesSheet.views = [{ state: "frozen", ySplit: 1 }];

  // --- Comments sheet (starts empty — filled in as the team adds weekly notes) ---
  const commentsSheet = wb.addWorksheet("Comments");
  commentsSheet.addTable({
    name: "CommentsTable",
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleMedium4", showRowStripes: true },
    columns: COMMENT_COLUMNS.map((key) => ({
      name: { case_number: "Case Number", timestamp: "Timestamp", author: "Author", comment: "Comment" }[key],
    })),
    rows: [["(example)", new Date().toISOString(), "Sameer", "Delete this row — placeholder only."]],
  });
  commentsSheet.getColumn(1).width = 16;
  commentsSheet.getColumn(2).width = 22;
  commentsSheet.getColumn(3).width = 16;
  commentsSheet.getColumn(4).width = 60;
  commentsSheet.getRow(1).font = { bold: true };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Wrote ${seedRows.length} cases to ${OUT_PATH}`);
  console.log("Next: upload this file to OneDrive/SharePoint, then follow README.md to get");
  console.log("its MS_DRIVE_ID / MS_FILE_ID via Graph Explorer.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
