// scripts/parseCaseText.js
//
// Parses the flattened body text of a Q2 Customer Portal "printable view"
// page (https://customerportal.q2.com/customerportal/{recordId}/p) into
// structured fields. This mirrors, field-for-field, the manual reading done
// to build the original 115-case dataset — the page format has been
// consistent across every case observed so far:
//
//   Case Information
//     Subject <value>
//     Description <value...>
//   Case Details
//     Product Family ...
//     Product Category <value>
//     Product <value>
//     Case Number <value>
//     Recurrence <value>  Urgency <value>
//     Contact Name <value>
//     ...
//     Type <value>  Owner of Case <value>
//     Date/Time Opened <value>  Date/Time Closed <value>
//     Priority <value>  Status <value>
//     Case Origin <value>  Sub-Status <value>
//     Account Name <value>  Case Solution <value>
//   Case Comments
//     <dd/mm/yyyy hh:mm>
//     User <name>
//     Comment <text...>
//     (repeats)
//   Attachments
//     ...
//
// This is regex/heuristic-based on label text, not DOM selectors, because
// that's the only representation we have proof-of-concept against (flattened
// text). If Q2 changes the page layout, update the section splitters and
// label patterns below — the surrounding scrape.js code doesn't need to
// change.
//
// Free-text fields (Subject/Description) can contain almost any word, so
// every field is grabbed from the *narrowest section it belongs in* — never
// from the whole page — to stop e.g. "High Priority" inside a Subject line
// from being mistaken for the Priority field in Case Details.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function grab(text, label, nextLabels, opts) {
  opts = opts || {};
  const stops = (nextLabels || []).map(escapeRe).join("|");
  const lookahead = stops ? `\\b(?:${stops})\\b` : null;
  const notPrecededBy = opts.notPrecededBy ? `(?<!${escapeRe(opts.notPrecededBy)} )` : "";
  const notFollowedBy = opts.notFollowedBy
    ? `(?!\\s*(?:${opts.notFollowedBy.map(escapeRe).join("|")}))`
    : "";
  const re = new RegExp(
    `${notPrecededBy}\\b${escapeRe(label)}\\b${notFollowedBy}\\s*([\\s\\S]*?)(?=${lookahead || "$"}|$)`,
    "i"
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function firstLine(s) {
  if (!s) return "";
  return s.split("\n")[0].trim();
}

function splitSections(text) {
  const detailsIdx = text.search(/\bCase Details\b/i);
  const commentsIdx = text.search(/\bCase Comments\b/i);
  const attachmentsIdx = (() => {
    const from = commentsIdx === -1 ? 0 : commentsIdx;
    const rel = text.slice(from + 1).search(/\bAttachments\b/i);
    return rel === -1 ? -1 : from + 1 + rel;
  })();

  const header = detailsIdx === -1 ? text : text.slice(0, detailsIdx);
  const details =
    detailsIdx === -1
      ? ""
      : text.slice(detailsIdx, commentsIdx === -1 ? text.length : commentsIdx);
  const comments =
    commentsIdx === -1
      ? ""
      : text.slice(commentsIdx, attachmentsIdx === -1 ? text.length : attachmentsIdx);

  return { header, details, comments };
}

function parseCaseText(rawText) {
  const text = rawText.replace(/\r/g, "");
  const { header, details, comments } = splitSections(text);

  const subject = grab(header, "Subject", ["Description", "Steps to Reproduce"]);
  const description = grab(header, "Description", ["Steps to Reproduce", "Case Details"]);

  const productCategory = firstLine(
    grab(details, "Product Category", ["Date & Time Issue Occurred", "Product"])
  );
  const product = firstLine(
    grab(details, "Product", ["Users Impacted", "Case Number"], { notFollowedBy: ["Family", "Category", "Other"] })
  );
  const urgency = firstLine(grab(details, "Urgency", ["Contact Name"]));
  const contactName = firstLine(grab(details, "Contact Name", ["Additional Information"]));
  const type = firstLine(grab(details, "Type", ["Owner of Case"], { notPrecededBy: "Environment" }));
  const owner = firstLine(grab(details, "Owner of Case", ["Date/Time Opened"]));
  const dateOpened = firstLine(grab(details, "Date/Time Opened", ["Date/Time Closed"]));
  const dateClosed = firstLine(grab(details, "Date/Time Closed", ["System Information", "Priority"]));
  const priority = firstLine(grab(details, "Priority", ["Status"]));
  const status = firstLine(grab(details, "Status", ["Case Origin"]));
  const caseOrigin = firstLine(grab(details, "Case Origin", ["Sub-Status"], { notPrecededBy: "Case" }));
  const accountName = firstLine(grab(details, "Account Name", ["Case Solution"]));

  const rawComments = comments.replace(/^Case Comments\s*/i, "").trim();

  return {
    subject,
    description,
    product_category: productCategory,
    product,
    urgency,
    contact_name: contactName,
    type,
    owner,
    date_opened: dateOpened,
    date_closed: dateClosed,
    priority,
    status,
    case_origin: caseOrigin,
    account_name: accountName,
    raw_comments: rawComments,
  };
}

module.exports = { parseCaseText };
