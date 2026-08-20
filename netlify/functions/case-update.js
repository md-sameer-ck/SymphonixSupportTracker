// netlify/functions/case-update.js
//
//   PATCH /api/case-update   (passcode required)
//   body: { case_number: "04700000", current_status_note: "...", ...anyEditableField }
//
//   POST  /api/case-update?resync=1   (passcode required)
//   body: { case_number: "04700000" }
//   -> re-fires the GitHub scrape workflow for a case you already have
//      (use this to backfill raw_comments on the original 115 imported
//      cases, or to force-refresh one that's stuck)

const { json, handleOptions } = require("./_http");
const { requirePasscode } = require("./_auth");
const graph = require("../../lib/store");

const EDITABLE_FIELDS = ["exec_summary", "current_status_note"];

async function triggerScrape(caseNumber) {
  const { GITHUB_DISPATCH_TOKEN, GITHUB_REPO } = process.env;
  if (!GITHUB_DISPATCH_TOKEN || !GITHUB_REPO) {
    return { dispatched: false, reason: "GITHUB_DISPATCH_TOKEN/GITHUB_REPO not configured" };
  }
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "scrape-case", client_payload: { case_number: caseNumber } }),
  });
  if (!res.ok) return { dispatched: false, reason: `GitHub dispatch failed (${res.status})` };
  return { dispatched: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  const auth = requirePasscode(event);
  if (!auth.ok) return json(auth.response.statusCode, JSON.parse(auth.response.body));

  try {
    const body = JSON.parse(event.body || "{}");
    const caseNumber = (body.case_number || "").trim();
    if (!caseNumber) return json(400, { error: "case_number is required" });

    const isResync = event.queryStringParameters && event.queryStringParameters.resync;

    if (isResync || event.httpMethod === "POST") {
      const dispatch = await triggerScrape(caseNumber);
      // Only mark it pending if the scrape was actually queued. If the
      // dispatch failed, nothing is coming — surface that as the sync error
      // so it shows up under Sync health instead of spinning on "pending".
      await graph.upsertCase(
        caseNumber,
        dispatch.dispatched
          ? { sync_status: "pending", sync_error: "" }
          : { sync_status: "error", sync_error: dispatch.reason }
      );
      return json(200, { ok: true, dispatch });
    }

    if (event.httpMethod === "PATCH") {
      const patch = {};
      EDITABLE_FIELDS.forEach((f) => {
        if (body[f] !== undefined) patch[f] = body[f];
      });
      if (Object.keys(patch).length === 0) {
        return json(400, { error: `No editable fields provided. Allowed: ${EDITABLE_FIELDS.join(", ")}` });
      }
      await graph.upsertCase(caseNumber, patch);
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
