// netlify/functions/comments.js
//
//   GET  /api/comments?case_number=04700000   -> list that case's weekly notes
//   GET  /api/comments                        -> list every comment (all cases)
//   POST /api/comments   (passcode required)
//   body: { case_number: "04700000", author: "Sameer", comment: "Synced with Q2 8/20..." }
//
// This is the "every Wednesday we sync up" log — separate from the
// auto-pulled portal data, so your team's running commentary never gets
// overwritten by a re-scrape.

const { json, handleOptions } = require("./_http");
const { requirePasscode } = require("./_auth");
const graph = require("../../lib/store");

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

      await graph.addComment({
        case_number: caseNumber,
        author: body.author || auth.name,
        comment,
      });
      return json(201, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
