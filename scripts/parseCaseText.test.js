// scripts/parseCaseText.test.js
//
// Tiny, dependency-free regression test for the parser — run it whenever you
// touch parseCaseText.js, and add a new fixture (save the printable-view
// page text into scripts/__fixtures__/) whenever a real case slips through
// with a wrong field, so it can't regress silently again.
//
//   node scripts/parseCaseText.test.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { parseCaseText, parsePortalComments } = require("./parseCaseText");

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf-8");
}

function run(name, text, expected) {
  const actual = parseCaseText(text);
  let failed = false;
  Object.keys(expected).forEach((key) => {
    try {
      assert.strictEqual(actual[key], expected[key]);
    } catch (e) {
      failed = true;
      console.error(`FAIL [${name}] field "${key}"\n  expected: ${JSON.stringify(expected[key])}\n  actual:   ${JSON.stringify(actual[key])}`);
    }
  });
  if (!failed) console.log(`PASS [${name}]`);
  return !failed;
}

let allPassed = true;

allPassed &= run("case-04412564", readFixture("case-04412564.txt"), {
  subject: "High Priority – Reopening Case for Certificate Rate Change Reversal Error (Old Case ID: 04357799)",
  product_category: "Symphonix Loan Servicing",
  product: "Reschedule",
  type: "System Bug",
  owner: "Rohit Datta",
  date_opened: "23/09/2025 13:59",
  date_closed: "12/05/2026 13:38",
  priority: "Medium",
  status: "90-Closed",
  case_origin: "Web",
  account_name: "Folk2Folk Limited",
});

allPassed &= run("case-04645897", readFixture("case-04645897.txt"), {
  subject: "Quick Quote Lightning Page",
  product_category: "Symphonix Origination",
  product: "Quick Quote",
  type: "Custom Code/Troubleshooting",
  owner: "Rohit Datta",
  date_opened: "22/06/2026 20:21",
  date_closed: "05/08/2026 18:40",
  priority: "Low",
  status: "90-Closed",
  case_origin: "Web",
  account_name: "Folk2Folk Limited",
});

// ---- Structured comment thread + attachments ----
// Checked separately from run() because these are arrays, not scalar fields.
function runDeep(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`PASS [${name}]`);
    return true;
  } catch (e) {
    console.error(`FAIL [${name}]\n  expected: ${JSON.stringify(expected, null, 2)}\n  actual:   ${JSON.stringify(actual, null, 2)}`);
    return false;
  }
}

const c04412564 = parseCaseText(readFixture("case-04412564.txt"));
const c04645897 = parseCaseText(readFixture("case-04645897.txt"));

// Two comments, newest first, with the "Case Number:" mail footer stripped.
allPassed &= runDeep("04412564 portal_comments", c04412564.portal_comments, [
  {
    timestamp: "12/05/2026 13:38",
    author: "Rohit Datta",
    comment: "Hi Team,\n\nAs we have provided the patch fix for the issue, we are proceeding with case closure.",
  },
  {
    timestamp: "06/05/2026 12:30",
    author: "Rohit Datta",
    comment: "Hi Team,\n\nKindly install the below patch",
  },
]);

allPassed &= runDeep("04645897 portal_comments", c04645897.portal_comments, [
  {
    timestamp: "05/08/2026 18:30",
    author: "Rohit Datta",
    comment:
      "Hi Daniel,\n\nBased on the current use case of leveraging a custom Lightning Record Page, we recommend implementing a custom component.",
  },
]);

allPassed &= runDeep("04412564 attachments", c04412564.attachments, [
  { name: "Q2 Loan Servicing and Q2 Marketplace Release Notes December 2023 (8)", size: "2.24MB", is_image: false },
]);

// A pasted screenshot: no file extension, but the portal's image-<date>-<time>
// naming is recognised so the UI can badge it as an image.
allPassed &= runDeep("04645897 attachments", c04645897.attachments, [
  { name: "image-20260801-103626", size: "333KB", is_image: true },
]);

// The comment splitter must not break a body that itself contains a bare date
// on its own line — only a date followed by a "User" line starts a new entry.
allPassed &= runDeep(
  "comment body containing a bare date",
  parsePortalComments(
    [
      "Case Comments",
      "12/05/2026 13:38",
      "User Rohit Datta",
      "Comment The outage began on:",
      "01/01/2026",
      "and ran for two hours.",
    ].join("\n")
  ),
  [
    {
      timestamp: "12/05/2026 13:38",
      author: "Rohit Datta",
      comment: "The outage began on:\n01/01/2026\nand ran for two hours.",
    },
  ]
);

// Cases with no comments/attachments at all must yield empty arrays, not throw.
allPassed &= runDeep("no comments section", parseCaseText("Subject Foo\nCase Details\nStatus 90-Closed").portal_comments, []);
allPassed &= runDeep("no attachments section", parseCaseText("Subject Foo\nCase Details\nStatus 90-Closed").attachments, []);

if (!allPassed) {
  console.error("\nOne or more parser tests failed.");
  process.exit(1);
} else {
  console.log("\nAll parser tests passed.");
}
