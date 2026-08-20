// netlify/functions/sync-all.js
//
//   POST /api/sync-all   (passcode required)
//   -> fires one GitHub Actions run that re-scrapes every tracked case,
//      closed ones included (a case reopened at Q2's end is only noticed by
//      checking it too). Same job the Wednesday cron runs; this is the
//      "Sync all" button for when you don't want to wait for it.
//
// Deliberately ONE dispatch for the whole set rather than one per case:
// 115 separate repository_dispatch calls would be rate-limited and would
// start 115 Actions runners, each paying the Playwright install cost.

const { json, handleOptions } = require("./_http");
const { requirePasscode } = require("./_auth");
const { triggerScrapeAll } = require("./_dispatch");
const graph = require("../../lib/store");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const auth = requirePasscode(event);
  if (!auth.ok) return json(auth.response.statusCode, JSON.parse(auth.response.body));

  try {
    const dispatch = await triggerScrapeAll();
    if (!dispatch.dispatched) {
      // Nothing was queued, so don't mark anything pending — report why and
      // leave every case's existing sync state untouched.
      return json(502, { error: dispatch.reason, dispatch });
    }

    // Mark open work as queued so the dashboard reflects that a refresh is in
    // flight. Closed cases are refreshed by the job too, but flipping all 115
    // rows to "pending" would make the whole board look unsynced for the ten
    // minutes the run takes, so only the cases someone is actually watching
    // get the badge.
    const cases = await graph.listCases();
    const open = cases.filter((c) => c.status !== "90-Closed");
    for (const c of open) {
      await graph.upsertCase(c.case_number, { sync_status: "pending", sync_error: "" });
    }

    return json(200, { ok: true, queued: cases.length, marked_pending: open.length, dispatch });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
