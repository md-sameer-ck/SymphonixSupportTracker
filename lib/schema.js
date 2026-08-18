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
  "current_status_note",
  "sync_status",
  "last_synced_at",
  "added_by",
];

const COMMENT_COLUMNS = ["case_number", "timestamp", "author", "comment"];

module.exports = { CASE_COLUMNS, COMMENT_COLUMNS };
