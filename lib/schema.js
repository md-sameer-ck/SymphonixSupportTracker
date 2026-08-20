// lib/schema.js
//
// Column list shared by every storage backend (lib/turso.js,
// lib/graphExcel.js, lib/localStore.js) so they all agree on the exact same
// case/comment shape regardless of which one is active.

const CASE_COLUMNS = [
  "case_number",
  "subject",
  "status",
  "priority",
  "urgency",
  "product_category",
  "product",
  "type",
  "case_origin",
  "owner",
  "contact_name",
  "account_name",
  "date_opened",
  "date_closed",
  "description",
  "exec_summary",
  "raw_comments",
  // The portal comment thread split into individual entries, stored as a JSON
  // array string of { timestamp, author, comment }. raw_comments is kept
  // alongside it because the original 115 seeded cases hold hand-written
  // "FIX:/DISCUSSION:" text there that the parser cannot reproduce.
  "portal_comments",
  // JSON array string of { name, size, is_image, url } for the case's files.
  "attachments",
  // Salesforce record ID for the case, e.g. 500Ux00000AbCdEfGHI. Needed to
  // build a direct link back to the case on customerportal.q2.com — the case
  // number alone can't address a page there.
  "portal_record_id",
  "current_status_note",
  "sync_status",
  "last_synced_at",
  "sync_error",
  "added_by",
];

// Weekly sync-up notes. "id" is the row's autoincrement key, exposed so a
// note can be edited after the fact; "edited_at" stays empty until it is.
const COMMENT_COLUMNS = ["id", "case_number", "timestamp", "author", "comment", "edited_at"];

module.exports = { CASE_COLUMNS, COMMENT_COLUMNS };
