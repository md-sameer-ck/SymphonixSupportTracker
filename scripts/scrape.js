// scripts/scrape.js
//
// Runs inside GitHub Actions (see .github/workflows/scrape-case.yml and
// weekly-sync.yml). Logs into the Q2 Customer Portal with stored
// credentials, resolves a case number to its internal Salesforce record ID,
// opens the printable view, parses it with parseCaseText.js, and upserts the
// result into the CasesTable via Microsoft Graph.
//
// Usage:
//   node scripts/scrape.js 04700000    # scrape one case
//   node scripts/scrape.js --all       # re-scrape every case, closed ones
//                                        included — a case closed at Q2's
//                                        end can be reopened later, and the
//                                        only way to notice is to keep
//                                        checking it too.
//
// Required env vars: Q2_PORTAL_USER, Q2_PORTAL_PASS, Q2_LOGIN_URL,
// Q2_CASE_LIST_URL, plus whichever storage backend's vars are set (see
// lib/store.js) — TURSO_DATABASE_URL by default, or the MS_* Graph vars if
// using the legacy Excel backend.
//
// ⚠️  UNVERIFIED AGAINST THE LIVE PORTAL. This was written from the page
// text observed during manual browsing, not from testing an automated login
// against the real site (no portal credentials were available in that
// session). The printable-view parsing (parseCaseText.js) IS verified
// against real page text. What's NOT verified: the login form's field
// selectors/flow, and whether the case-list page requires extra waits or a
// different way to resolve "case number -> record ID". Run this once by
// hand (workflow_dispatch on a known case) and adjust the two spots marked
// "ADJUST IF NEEDED" below against what you actually see, before trusting
// the scheduled sync.

const { chromium } = require("playwright");
const { parseCaseText } = require("./parseCaseText");
const graph = require("../lib/store");

const Q2_LOGIN_URL = process.env.Q2_LOGIN_URL || "https://customerportal.q2.com/customerportal/s/login";
const Q2_CASE_LIST_URL =
  process.env.Q2_CASE_LIST_URL ||
  "https://customerportal.q2.com/customerportal/s/support-cases?Case-filterId=All_Cases_Open_or_Closed";

async function login(page) {
  const user = process.env.Q2_PORTAL_USER;
  const pass = process.env.Q2_PORTAL_PASS;
  if (!user || !pass) throw new Error("Missing Q2_PORTAL_USER / Q2_PORTAL_PASS env vars.");

  await page.goto(Q2_LOGIN_URL, { waitUntil: "domcontentloaded" });

  // ADJUST IF NEEDED: Salesforce Experience Cloud login forms are usually
  // #username / #password / a "Log In" submit button, but community themes
  // vary. If this fails, open the login page's HTML and update selectors.
  const userField = page.locator("#username, input[name='username']").first();
  const passField = page.locator("#password, input[name='pw']").first();
  await userField.waitFor({ timeout: 30_000 });
  await userField.fill(user);
  await passField.fill(pass);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
    page.locator("button[type='submit'], #Login").first().click(),
  ]);
}

async function resolveRecordId(page, caseNumber) {
  // ADJUST IF NEEDED: this scans the case list table for a row containing
  // the case number and reads the record ID out of that row's link href
  // (…/customerportal/{id}/…). If the portal exposes a search box instead,
  // it'll likely be faster to type the case number in there and grab the
  // first result's href — swap this out if the list-scan proves flaky.
  await page.goto(Q2_CASE_LIST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500); // let the Lightning list component render

  const href = await page.evaluate((caseNum) => {
    const links = Array.from(document.querySelectorAll("a[href*='/customerportal/']"));
    for (const a of links) {
      const row = a.closest("tr") || a.closest("li") || a.parentElement;
      if (row && row.textContent && row.textContent.includes(caseNum)) {
        return a.getAttribute("href");
      }
    }
    return null;
  }, caseNumber);

  if (!href) throw new Error(`Could not find case ${caseNumber} in the case list.`);
  const match = href.match(/\/customerportal\/([a-zA-Z0-9]{15,18})/);
  if (!match) throw new Error(`Could not parse a record ID out of href: ${href}`);
  return match[1];
}

async function scrapeOne(page, caseNumber) {
  const recordId = await resolveRecordId(page, caseNumber);
  const url = `https://customerportal.q2.com/customerportal/${recordId}/p`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);

  const parsed = parseCaseText(text);
  await graph.upsertCase(caseNumber, {
    ...parsed,
    sync_status: "synced",
    last_synced_at: new Date().toISOString(),
    sync_error: "", // cleared on success so a fixed case stops showing as failed
  });
  console.log(`Synced ${caseNumber}: ${parsed.subject}`);
}

// Records the failure on the case itself, so the dashboard can show *why* a
// sync failed instead of leaving the row on "pending" indefinitely. Best
// effort: if the store write itself fails there's nowhere left to report to,
// so just log it and let the original error surface.
async function recordFailure(caseNumber, err) {
  console.error(`Failed to sync ${caseNumber}: ${err.message}`);
  try {
    await graph.upsertCase(caseNumber, {
      sync_status: "error",
      sync_error: err.message,
      last_synced_at: new Date().toISOString(),
    });
  } catch (writeErr) {
    console.error(`Could not record the failure for ${caseNumber}: ${writeErr.message}`);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/scrape.js <case_number> | --all");
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await login(page);

    if (arg === "--all" || arg === "--all-open") {
      const cases = await graph.listCases();
      console.log(`Re-syncing ${cases.length} case(s) (including closed, in case any reopened)...`);
      for (const c of cases) {
        try {
          await scrapeOne(page, c.case_number);
        } catch (err) {
          await recordFailure(c.case_number, err);
        }
      }
    } else {
      // Single-case runs record the failure too, then rethrow so the Actions
      // run still goes red. Without this a failed scrape left the case on
      // "pending" forever, with the reason buried in the workflow log.
      try {
        await scrapeOne(page, arg);
      } catch (err) {
        await recordFailure(arg, err);
        throw err;
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
