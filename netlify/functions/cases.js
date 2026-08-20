// netlify/functions/cases.js
//
//   GET  /api/cases            -> list every case (read-only, no passcode)
//   POST /api/cases             -> add a new case placeholder (passcode required)
//
// POST body: { case_number: "04700000", exec_summary: "...", added_by: "Sameer" }
//
// Adding a case writes an immediate stub row (sync_status: "pending") so it
// shows up on the dashboard right away, then fires a GitHub repository_dispatch
// event so the scrape-case.yml workflow logs into the Q2 portal and fills in
// every auto-pullable field. If GITHUB_DISPATCH_TOKEN / GITHUB_REPO aren't
// configured yet, the case still saves — it just stays "pending" until you
// configure the dispatch (or scrape it manually) later.

const { json, handleOptions } = require("./_http");
const { requirePasscode } = require("./_auth");
const { triggerScrape } = require("./_dispatch");
const graph = require("../../lib/store");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  try {
    if (event.httpMethod === "GET") {
      const cases = await graph.listCases();
      return json(200, { cases });
    }

    if (event.httpMethod === "POST") {
      const auth = requirePasscode(event);
      if (!auth.ok) return json(auth.response.statusCode, JSON.parse(auth.response.body));

      const body = JSON.parse(event.body || "{}");
      const caseNumber = (body.case_number || "").trim();
      if (!caseNumber) return json(400, { error: "case_number is required" });

      await graph.addCase({
        case_number: caseNumber,
        exec_summary: body.exec_summary || "",
        added_by: body.added_by || auth.name,
        sync_status: "pending",
        last_synced_at: "",
      });

      const dispatch = await triggerScrape(caseNumber);
      // A failed dispatch means nothing will ever fill this case in, so it's
      // a sync failure — record it rather than leaving the row on "pending"
      // with no explanation on the dashboard.
      if (!dispatch.dispatched) {
        await graph.upsertCase(caseNumber, { sync_status: "error", sync_error: dispatch.reason });
      }
      return json(201, { ok: true, case_number: caseNumber, dispatch });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
