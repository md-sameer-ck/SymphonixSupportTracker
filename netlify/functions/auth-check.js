// netlify/functions/auth-check.js
//
//   POST /api/auth-check   body: { passcode: "..." }
//   -> { ok: true, name: "Sameer" }
//
// Lets the frontend verify a passcode once (when the user clicks "Unlock
// editing") and remember it — plus the resolved name, used to attribute
// comments and edits automatically instead of a free-text prompt — for the
// session. The passcode is still re-checked server-side on every actual
// write (cases.js / case-update.js / comments.js) — this endpoint never
// grants access by itself, it just confirms upfront.

const { json, handleOptions } = require("./_http");
const { resolvePasscode } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  if (!process.env.ADMIN_PASSCODE && !process.env.TEAM_PASSCODES) {
    return json(500, { error: "No ADMIN_PASSCODE or TEAM_PASSCODES configured on the server." });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const name = resolvePasscode(body.passcode || "");
    if (name) return json(200, { ok: true, name });
    return json(401, { ok: false, error: "Incorrect passcode." });
  } catch (err) {
    return json(400, { error: "Invalid request body." });
  }
};
