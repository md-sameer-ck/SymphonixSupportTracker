// scripts/turso-init.js
//
// One-time setup for the Turso backend: creates the `cases` and `comments`
// tables (lib/turso.js also does this lazily, but running it explicitly up
// front lets you confirm the connection works) and loads the 115
// already-scraped cases from data/seed-cases.json. Safe to re-run — skips
// seeding if the cases table already has rows.
//
//   export TURSO_DATABASE_URL=libsql://your-db-yourorg.turso.io
//   export TURSO_AUTH_TOKEN=...
//   npm run seed:turso
//
// See README.md "Turso setup" for how to create the database and get these
// values from the Turso CLI.

const fs = require("fs");
const path = require("path");
const store = require("../lib/turso");

const SEED_PATH = path.join(__dirname, "..", "data", "seed-cases.json");

function mapSeedRowToCaseRow(seed) {
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
  const existing = await store.listCases();
  if (existing.length > 0) {
    console.log(`Tables already exist with ${existing.length} case(s) — nothing to seed.`);
    console.log("Delete rows manually first if you want to reload from data/seed-cases.json.");
    return;
  }

  const seedRows = JSON.parse(fs.readFileSync(SEED_PATH, "utf-8"));
  for (const seed of seedRows) {
    await store.addCase(mapSeedRowToCaseRow(seed));
  }
  console.log(`Seeded ${seedRows.length} cases into Turso.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
