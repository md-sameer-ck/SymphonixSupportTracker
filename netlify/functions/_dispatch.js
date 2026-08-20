// netlify/functions/_dispatch.js
//
// Fires the GitHub Actions workflows that do the actual portal scraping, via
// repository_dispatch. Shared by cases.js (new case), case-update.js (single
// re-sync) and sync-all.js (refresh everything), which all previously carried
// their own near-identical copy of this.
//
// Every failure returns { dispatched: false, reason } rather than throwing —
// the caller records the reason on the case so it shows up under Sync health
// instead of leaving a row spinning on "pending" with no explanation.

const GITHUB_API = "https://api.github.com";

// GitHub's own message is included verbatim, plus a hint for the two status
// codes that actually happen in practice. A bare "403" tells you nothing about
// which of several quite different problems you have.
function explain(status, body) {
  const detail = (body || "").slice(0, 300).trim();
  if (status === 403) {
    return (
      `GitHub refused the request (403). The token in GITHUB_DISPATCH_TOKEN can reach the API but is not ` +
      `allowed to dispatch workflows on this repo. Check, in order: (1) the token has the "repo" scope ` +
      `(classic PAT) or Contents: Read and write (fine-grained PAT); (2) for a fine-grained PAT, this ` +
      `specific repository is listed under its Repository access; (3) GITHUB_REPO is "owner/repo" for a ` +
      `repo the token's owner can write to; (4) the token has not expired. ` +
      `GitHub said: ${detail || "(no message)"}`
    );
  }
  if (status === 404) {
    return (
      `GitHub returned 404 for GITHUB_REPO. Either the value is not in "owner/repo" form, the repo does ` +
      `not exist, or the token cannot see it — a token without access to a private repo gets 404, not 403. ` +
      `GitHub said: ${detail || "(no message)"}`
    );
  }
  if (status === 401) {
    return `GitHub rejected the token (401) — GITHUB_DISPATCH_TOKEN is invalid, revoked or expired. GitHub said: ${detail || "(no message)"}`;
  }
  return `GitHub dispatch failed (${status}): ${detail || "(no message)"}`;
}

async function dispatch(eventType, payload) {
  const { GITHUB_DISPATCH_TOKEN, GITHUB_REPO } = process.env;
  if (!GITHUB_DISPATCH_TOKEN || !GITHUB_REPO) {
    return {
      dispatched: false,
      reason:
        "GITHUB_DISPATCH_TOKEN / GITHUB_REPO are not set in the Netlify environment variables, so no " +
        "portal scrape can be triggered. See README.md “GitHub — secrets and repo dispatch”.",
    };
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(GITHUB_REPO)) {
    return {
      dispatched: false,
      reason: `GITHUB_REPO must be "owner/repo" — got "${GITHUB_REPO}".`,
    };
  }

  let res;
  try {
    res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload || {} }),
    });
  } catch (err) {
    return { dispatched: false, reason: `Could not reach the GitHub API: ${err.message}` };
  }

  // A successful repository_dispatch is 204 No Content.
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (e) {}
    return { dispatched: false, status: res.status, reason: explain(res.status, body) };
  }
  return { dispatched: true };
}

// Named wrappers so callers read clearly and the event names live in one place.
const triggerScrape = (caseNumber) => dispatch("scrape-case", { case_number: caseNumber });
const triggerScrapeAll = () => dispatch("scrape-all", {});

module.exports = { dispatch, triggerScrape, triggerScrapeAll };
