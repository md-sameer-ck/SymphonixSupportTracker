// netlify/functions/comments.js
//
//   GET   /api/comments?case_number=04700000   -> list that case's weekly notes
//   GET   /api/comments                        -> list every comment (all cases)
//   POST  /api/comments   (passcode required)
//   body: { case_number: "04700000", author: "Sameer", comment: "Synced with Q2 8/20..." }
//   PATCH /api/comments   (passcode required)  -> fix a typo in an existing note
//   body: { id: 42, comment: "corrected text" }
//   DELETE /api/comments  (passcode required)
//   body: { id: 42 }
//
// Editing stamps edited_at and leaves the original timestamp alone, so the
// note still shows when it was written, plus a marker that it was corrected.
//
// This is the "every Wednesday we sync up" log — separate from the
// auto-pulled portal data, so your team's running commentary never gets
// overwritten by a re-scrape.

const { json, handleOptions } = require("./_http");
const { requirePasscode } = require("./_auth");
const graph = require("../../lib/store");

// Editing and deleting a note need to address a specific row, which the
// legacy Microsoft Graph / Excel backend (lib/graphExcel.js) doesn't
// implement. Report that plainly instead of throwing "not a function".
function unsupported(action) {
  return {
    error:
      `${action} a note isn't supported on the Excel backend — it has no row addressing for comments. ` +
      "Turso (the default backend) supports it; see README.md.",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  try {
    if (event.httpMethod === "GET") {
      const caseNumber = event.queryStringParameters && event.queryStringParameters.case_number;
      const comments = await graph.listComments(caseNumber);
      comments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return json(200, { comments });
    }

    if (event.httpMethod === "POST") {
      const auth = requirePasscode(event);
      if (!auth.ok) return json(auth.response.statusCode, JSON.parse(auth.response.body));

      const body = JSON.parse(event.body || "{}");
      const caseNumber = (body.case_number || "").trim();
      const comment = (body.comment || "").trim();
      if (!caseNumber || !comment) {
        return json(400, { error: "case_number and comment are required" });
      }

      const created = await graph.addComment({
        case_number: caseNumber,
        author: body.author || auth.name,
        comment,
      });
      return json(201, { ok: true, ...(created || {}) });
    }

    if (event.httpMethod === "PATCH") {
      const auth = requirePasscode(event);
      if (!auth.ok) return json(auth.response.statusCode, JSON.parse(auth.response.body));

      const body = JSON.parse(event.body || "{}");
      const id = body.id;
      const comment = (body.comment || "").trim();
      if (id === undefined || id === null || id === "") return json(400, { error: "id is required" });
      if (!comment) return json(400, { error: "comment cannot be empty — use DELETE to remove a note" });

      if (typeof graph.updateComment !== "function") return json(501, unsupported("Editing"));
      const ok = await graph.updateComment(id, comment);
      if (!ok) return json(404, { error: `No note with id ${id}` });
      return json(200, { ok: true });
    }

    if (event.httpMethod === "DELETE") {
      const auth = requirePasscode(event);
      if (!auth.ok) return json(auth.response.statusCode, JSON.parse(auth.response.body));

      const body = JSON.parse(event.body || "{}");
      if (body.id === undefined || body.id === null || body.id === "") {
        return json(400, { error: "id is required" });
      }
      if (typeof graph.deleteComment !== "function") return json(501, unsupported("Deleting"));
      const ok = await graph.deleteComment(body.id);
      if (!ok) return json(404, { error: `No note with id ${body.id}` });
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
