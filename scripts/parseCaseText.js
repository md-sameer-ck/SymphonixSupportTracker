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
  const attachments = attachmentsIdx === -1 ? "" : text.slice(attachmentsIdx);

  return { header, details, comments, attachments };
}

// Splits the Case Comments section into individual entries. The section is a
// flat run of repeating three-part blocks:
//
//   12/05/2026 13:38
//   User Rohit Datta
//   Comment Hi Team, …possibly many paragraphs…
//
// Kept as a line walk rather than one big regex because a comment body can
// contain anything at all — including lines that look like the next block's
// date — and only a date on its own line, followed by a "User" line, actually
// starts a new comment. A case with 100 comments is otherwise a single
// unreadable wall of text.
const COMMENT_DATE_RE = /^(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2})?)\s*$/;

function parsePortalComments(section) {
  const lines = section.replace(/^Case Comments\s*/i, "").split("\n");
  const entries = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dateMatch = line.match(COMMENT_DATE_RE);
    // Only treat a bare date as a new comment when a "User" line follows it,
    // so a date sitting on its own inside a comment body doesn't split it.
    if (dateMatch && /^User\b/i.test(lines[i + 1] || "")) {
      if (current) entries.push(current);
      current = { timestamp: dateMatch[1].trim(), author: "", comment: "" };
      continue;
    }
    if (!current) continue;
    if (!current.author && /^User\b/i.test(line)) {
      current.author = line.replace(/^User\s*/i, "").trim();
      continue;
    }
    if (/^Comment\b/i.test(line) && !current._body) {
      current._body = true;
      current.comment = line.replace(/^Comment\s*/i, "");
      continue;
    }
    if (current._body) current.comment += "\n" + line;
  }
  if (current) entries.push(current);

  return entries
    .map((e) => {
      delete e._body;
      // Every portal comment ends with the case's own number as a mail-footer
      // artefact; it carries no information and only adds noise per comment.
      e.comment = e.comment.replace(/\n*Case Number:\s*\d+\s*$/i, "").trim();
      return e;
    })
    .filter((e) => e.comment || e.author);
}

// The Attachments section lists a filename then its size, repeating:
//
//   Attachments
//   image-20260801-103626
//   Size 333KB
//
// The printable view gives no download URL in text form, so only name and
// size come from here — scrape.js separately tries to pull real hrefs out of
// the live DOM and merges them in by filename.
function parseAttachments(section) {
  const lines = section
    .replace(/^Attachments\s*/i, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const sizeMatch = lines[i].match(/^Size\s+(.+)$/i);
    if (sizeMatch) {
      if (out.length) out[out.length - 1].size = sizeMatch[1].trim();
      continue;
    }
    out.push({ name: lines[i], size: "" });
  }
  return out;
}

// Filenames the portal generates for pasted screenshots (image-<date>-<time>)
// plus anything with an obvious image extension.
function isImageAttachment(name) {
  return /\.(png|jpe?g|gif|bmp|webp|svg|tiff?)$/i.test(name) || /^image-\d{8}-\d{6}$/i.test(name);
}

function parseCaseText(rawText) {
  const text = rawText.replace(/\r/g, "");
  const { header, details, comments, attachments } = splitSections(text);

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
  const portalComments = parsePortalComments(comments);
  const attachmentList = parseAttachments(attachments).map((a) => ({
    ...a,
    is_image: isImageAttachment(a.name),
  }));

  return {
    subject,
    description,
    // Structured alongside the raw blob rather than replacing it: the original
    // 115 seeded cases hold hand-written "FIX:/DISCUSSION:" text in
    // raw_comments that this parser can't produce, and the dashboard falls
    // back to rendering that whenever the structured list is empty.
    portal_comments: portalComments,
    attachments: attachmentList,
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

module.exports = { parseCaseText, parsePortalComments, parseAttachments, isImageAttachment };
