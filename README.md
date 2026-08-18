# Folk2Folk × Q2 Symphonix — Support Cases Tracker

An internal dashboard for Folk2Folk's Q2 Symphonix support cases. New cases
auto-pull their details from the Q2 Customer Portal (no official API exists,
so this drives a real browser with your login), and the team adds dated
notes every Wednesday sync-up. Data lives in **Turso** — a free, hosted
SQLite database — so the whole stack (Netlify + GitHub + Turso) runs on free
tiers with no Azure AD app registration or Microsoft 365 license needed.

**Status: code is complete and tested against a local mock backend and a
real Turso (libSQL) database (see "Try it locally" below). It has NOT been
run against your real Q2 portal** — that needs your Q2 login, which this
assistant never had access to. Budget one debugging pass against the real
portal login before trusting the scheduled sync (see the "⚠️ UNVERIFIED"
note in `scripts/scrape.js`).

## How it fits together

```
 Netlify (site + Functions) ───────────────────► Turso (libSQL database)
        ▲    │                                          ▲
        │    └── on "Add case" ──► GitHub repository_dispatch
        │                                   │           │
   your browser                             ▼           │
                                   GitHub Actions runner│
                                   (Playwright logs into│
                                    Q2 portal, scrapes ─┘
                                    the case, writes to Turso)
```

- **Netlify** hosts the static dashboard (`site/`) and the API (`netlify/functions/`).
- **Turso** stores two tables — `cases` and `comments` — that the site and
  the scraper both read/write through the same `lib/turso.js` client.
- **GitHub Actions** runs the actual portal scraper (Playwright + a real
  Chromium), because that's a much better fit than a Netlify Function for a
  headless-browser job: no cold-start binary size limits, generous timeouts,
  and your Q2 login only ever needs to live in GitHub Secrets.

## What's automatic vs. manual (by design)

You asked for "paste a summary, everything else auto-pulls." Concretely:

| Field | Source |
|---|---|
| Subject, Status, Priority, Urgency, Product/Category, Type, Origin, Owner, Contact, Account, Dates, Description, raw comment thread | **Auto-pulled** from the portal by the scraper |
| Exec summary | **You type it** when adding the case |
| Current status note | **You edit it** any time (the one field the scraper never overwrites) |
| Weekly sync-up notes | **You add one per Wednesday sync**, timestamped, never overwritten |

The scraper does not attempt to write `case_fix` / `case_discussion`-style
AI summaries — that was done by hand (with an LLM in the loop) for the
original 115 cases and isn't something an unattended script can respons­ibly
replicate. If you want that later, the natural place to add it is inside
`scripts/scrape.js`, calling the Anthropic API with the scraped comment
thread — happy to wire that up as a follow-up.

## Reopened cases

Status always reflects whatever the Q2 portal says, because the scraper
overwrites it on every sync — there's no separate "reopen" action to
remember to click. Two things make this actually work day to day:

- The **weekly sync workflow re-scrapes every case, including closed
  ones** (`node scripts/scrape.js --all`), specifically so a case closed at
  Q2's end and reopened later doesn't sit stale until someone notices.
- The dashboard shows a **"↺ Reopened" badge** next to the status pill for
  any case that has a `date_closed` but isn't currently `90-Closed` — an
  easy visual flag during your Wednesday sync.
- You can also click **"🔄 Refresh from portal"** on any case any time to
  force an immediate re-check instead of waiting for the weekly run.

## Multi-person logins

Two ways to gate editing (set one or both in Netlify's environment
variables, and matching GitHub Secrets for the workflows):

- `ADMIN_PASSCODE` — one shared passcode; writes are attributed as "Admin".
  Simplest option, fine for a very small team.
- `TEAM_PASSCODES` — a JSON object giving each person their own passcode,
  e.g. `{"Sameer":"correct-horse-1","Asha":"correct-horse-2"}`. Each person
  unlocks editing with their own passcode, and every case they add, note
  they log, or field they edit is stamped with their name automatically —
  no more typing your name into a prompt every time.

## Weekly sync-up nudge

Every open case tracks whether it has a note logged since the most recent
Wednesday. The dashboard surfaces this without any extra backend state —
it's computed from existing comment timestamps:

- A banner appears at the top whenever any open case is missing this
  week's update: *"X of Y open cases still need this week's sync-up note."*
- A **"🗓 Needs sync-up"** filter button in the filter bar shows just those
  cases so you can click through them one by one during the meeting.
- Each case's "Weekly sync-up notes" section shows a **"Needs this week's
  update"** badge until someone adds a note.

## Repo layout

```
site/                   Static frontend — index.html, styles.css, app.js
netlify/functions/      API: cases.js, case-update.js, comments.js, auth-check.js
lib/schema.js           Shared case/comment column list, used by every backend
lib/turso.js            Turso (libSQL) backend — the default, fully-free path
lib/graphExcel.js       Legacy: Microsoft Graph <-> Excel table adapter (optional)
lib/localStore.js       JSON-file stand-in for local testing (no Turso needed)
lib/store.js            Picks turso vs graphExcel vs localStore automatically
scripts/scrape.js       Playwright scraper, run by GitHub Actions
scripts/parseCaseText.js   Parses the portal's printable-view page text
scripts/parseCaseText.test.js   Regression tests for the parser (2 real fixtures)
scripts/turso-init.js   Creates Turso tables and seeds the 115 known cases
scripts/seed-from-json.js  Legacy: builds an Excel workbook instead (only if using graphExcel)
scripts/dev-server.js   Zero-dependency local server for clicking through the UI
data/seed-cases.json    The 115 cases already pulled (this is your starting dataset)
.github/workflows/      scrape-case.yml (on-demand) + weekly-sync.yml (Wed cron)
```

## Try it locally first (no Turso account, no GitHub secrets needed)

```
npm install
npm test          # runs the parser regression tests
npm run dev        # http://localhost:8888, admin passcode: dev-passcode
```

`npm run dev` starts a tiny local server that serves the site and backs the
API with a JSON file (`lib/localStore.js`), seeded from the 115 already-known
cases. Click "Add case", add weekly notes, edit the status note, watch the
"needs sync-up" filter and banner react — everything works except the actual
portal scrape (there's nothing to scrape locally). This is the fastest way
to sanity-check the UI before touching Turso/GitHub.

To try it against a real (free) Turso database locally instead of the JSON
file, export `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN` if it's a remote
db) before running `npm run dev` — see "Turso setup" below. You can even
point at a throwaway local file, e.g. `TURSO_DATABASE_URL=file:./local.db`.

## Setup — in order

### 1. Turso setup

1. Install the Turso CLI and sign up (free — no credit card):
   ```
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth signup
   ```
2. Create a database and get its connection details:
   ```
   turso db create f2f-q2-tracker
   turso db show f2f-q2-tracker --url          # -> TURSO_DATABASE_URL
   turso db tokens create f2f-q2-tracker        # -> TURSO_AUTH_TOKEN
   ```
3. Create the tables and load the 115 already-scraped cases:
   ```
   export TURSO_DATABASE_URL=libsql://f2f-q2-tracker-yourorg.turso.io
   export TURSO_AUTH_TOKEN=eyJ...
   npm run seed:turso
   ```

### 2. GitHub — secrets and repo dispatch

In your GitHub repo, **Settings > Secrets and variables > Actions**, add:

| Secret | Value |
|---|---|
| `Q2_PORTAL_USER` | Your Q2 Customer Portal login email |
| `Q2_PORTAL_PASS` | Your Q2 Customer Portal password |
| `TURSO_DATABASE_URL` | from step 1 |
| `TURSO_AUTH_TOKEN` | from step 1 |

Also create a **fine-grained personal access token** (Settings > Developer
settings > Personal access tokens) scoped only to this repo, with
**Actions: Read and write** permission — this is what lets the live site
trigger a scrape when someone clicks "Add case." You'll paste this into
Netlify as `GITHUB_DISPATCH_TOKEN` (next step), not into GitHub itself.

**Test the scraper before relying on it:** go to the Actions tab, run
"Scrape one case from Q2 portal" manually (`workflow_dispatch`) with a known
case number, and watch the log. See the ⚠️ note at the top of
`scripts/scrape.js` — the login-form selectors are a best guess and may need
a tweak once you see the real page.

### 3. Netlify

1. **Connect this GitHub repo** in the Netlify UI (Sites > Add new site >
   Import from Git) — this gets you continuous deployment for free, so you
   never need to give this assistant (or anyone) a Netlify API token. Every
   push to `main` redeploys automatically. In **Site configuration > General
   > Site details > Change site name**, set it to `symphonix-support-tracker`
   so the live URL is `symphonix-support-tracker.netlify.app` (or attach
   your own domain there instead).
2. **Site configuration > Environment variables**, add:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Same values as the GitHub secrets |
| `ADMIN_PASSCODE` and/or `TEAM_PASSCODES` | See "Multi-person logins" above |
| `GITHUB_DISPATCH_TOKEN` | The fine-grained PAT from step 2 |
| `GITHUB_REPO` | `yourorg/symphonix-support-tracker` |

3. Deploy. The site reads/writes the same Turso database the GitHub Action
   writes to — no sync step needed, Turso is the single source of truth.

### 4. Weekly sync schedule

`.github/workflows/weekly-sync.yml` runs every Wednesday at 06:00 UTC and
re-scrapes **every** case — including closed ones, in case any reopened —
so the dashboard is fresh before your sync-up. Edit the cron line if your
meeting time or day changes. You can also trigger it manually from the
Actions tab any time.

## Day-to-day use

- **Add a case:** click "+ Add case," enter the case number and a one-line
  summary, unlock with your passcode if you haven't already. The case
  appears immediately as "Pending" and fills in within a minute or two once
  the GitHub Action finishes. Your name is attributed automatically if
  you're using `TEAM_PASSCODES`.
- **Backfill an old case's raw comment thread:** open any of the original
  115 cases and click "🔄 Refresh from portal" — they were seeded from the
  earlier manual pull, which didn't retain the verbatim comment thread.
- **Weekly notes:** open a case, add a note under "Weekly sync-up notes."
  These are never touched by the scraper. Use the "🗓 Needs sync-up" filter
  during your Wednesday meeting to work through everything that still needs
  one.
- **Current status note:** the one editable field on the case itself —
  useful for a one-line "where this stands" that's easier to scan than the
  full comment history.
- **Reopened cases:** nothing to do manually — once Q2 shows a case as open
  again and it's re-scraped (weekly, or via "🔄 Refresh from portal"), the
  dashboard picks it up and shows the "↺ Reopened" badge.

## Optional: Microsoft Graph / Excel backend instead of Turso

If your team specifically wants the data living in an Excel workbook on
OneDrive/SharePoint instead of Turso, `lib/graphExcel.js` still implements
the same interface — `lib/store.js` uses it automatically if `MS_DRIVE_ID`
and `MS_FILE_ID` are set and `TURSO_DATABASE_URL` is not. This path needs an
Azure AD app registration and a Microsoft 365 license for the OneDrive/
SharePoint storage, and is not built for high write concurrency — it was
the original design before this was consolidated onto Turso. See the git
history of this README for the full Azure AD setup instructions if you need
them; for a small internal team, Turso is the simpler and fully-free choice.

## Known limitations / things to sanity-check

- **The scraper is unverified against the live portal** (see above) — the
  parsing logic (`parseCaseText.js`) is tested against two real pages, but
  the login flow and case-number → record-ID resolution in `scrape.js` are
  educated guesses at Salesforce Experience Cloud's usual patterns. Run it
  once by hand first.
- **Scraping Q2's portal** — double-check this is fine under your agreement
  with Q2 before relying on it long-term. This automates something you
  already do by hand (viewing your own cases), but it's worth a quick check
  with Q2 or your account team.
- **Passcode auth is intentionally simple** — passcodes are plaintext env
  vars checked server-side, no hashing, no session expiry beyond the
  browser tab. Good enough for a small internal tool; if you outgrow it,
  Netlify Identity is the natural upgrade.
- **The weekly "needs sync-up" nudge is a client-side computation**, not a
  stored flag — it's derived from comment timestamps every time the page
  loads, so there's nothing to keep in sync or reset each week.
