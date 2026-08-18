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
const { parseCaseText } = require("./parseCaseText");

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

if (!allPassed) {
  console.error("\nOne or more parser tests failed.");
  process.exit(1);
} else {
  console.log("\nAll parser tests passed.");
}
