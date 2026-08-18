// netlify/functions/_auth.js
//
// Server-side passcode gate for every write action (add case, add comment,
// edit a field, request a re-sync, reopen a case). Never checked in the
// browser — only here. Reading/viewing the dashboard is NOT gated by this —
// only mutations are.
//
// Two ways to configure who can edit (either or both, set in the Netlify
// UI's environment variables):
//
//   ADMIN_PASSCODE  - one shared passcode. Writes made with it are
//                     attributed as "Admin". Simplest option.
//
//   TEAM_PASSCODES  - a JSON object mapping each team member's name to
//                     their own passcode, so writes are attributed by name
//                     automatically instead of a free-text "your name"
//                     field, e.g.:
//                       {"Sameer":"correct-horse-1","Asha":"correct-horse-2"}
//                     Each person unlocks editing with their own passcode
//                     and every case/comment they add or edit is stamped
//                     with their name server-side.

function teamPasscodes() {
  try {
    const parsed = JSON.parse(process.env.TEAM_PASSCODES || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Returns the resolved person's name for a given passcode, or null.
function resolvePasscode(provided) {
  if (!provided) return null;
  if (process.env.ADMIN_PASSCODE && provided === process.env.ADMIN_PASSCODE) {
    return "Admin";
  }
  const team = teamPasscodes();
  return Object.keys(team).find((name) => team[name] === provided) || null;
}

function requirePasscode(event) {
  if (!process.env.ADMIN_PASSCODE && Object.keys(teamPasscodes()).length === 0) {
    return {
      ok: false,
      response: {
        statusCode: 500,
        body: JSON.stringify({
          error: "No ADMIN_PASSCODE or TEAM_PASSCODES configured on the server. Set one in Netlify env vars.",
        }),
      },
    };
  }

  const provided = event.headers["x-admin-passcode"] || event.headers["X-Admin-Passcode"] || "";
  const name = resolvePasscode(provided);

  if (!name) {
    return {
      ok: false,
      response: {
        statusCode: 401,
        body: JSON.stringify({ error: "Invalid or missing passcode." }),
      },
    };
  }

  return { ok: true, name };
}

module.exports = { requirePasscode, resolvePasscode };
