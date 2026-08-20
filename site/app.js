(function () {
  "use strict";

  // ---------- Config ----------
  var API_CASES = "/api/cases";
  var API_CASE_UPDATE = "/api/case-update";
  var API_COMMENTS = "/api/comments";
  var API_AUTH_CHECK = "/api/auth-check";
  var API_SYNC_ALL = "/api/sync-all";

  // Where a case lives on the Q2 portal. The record-view path is the standard
  // Salesforce Experience Cloud one; "/p" (the printable view the scraper
  // reads) is definitely valid on this base, so if your community routes
  // record pages differently, PORTAL_CASE_PATH is the single line to change.
  var PORTAL_BASE = "https://customerportal.q2.com/customerportal";
  var PORTAL_CASE_PATH = "/view";
  var PORTAL_CASE_LIST = PORTAL_BASE + "/s/support-cases?Case-filterId=All_Cases_Open_or_Closed";

  // Login persists across browser restarts (localStorage) rather than dying
  // with the tab (sessionStorage). This is a shared team passcode on an
  // internal tool, and re-entering it every morning was the bigger problem.
  var STORE_KEY_PASSCODE = "f2f_admin_passcode";
  var STORE_KEY_NAME = "f2f_admin_name";

  function readStored(key) {
    try {
      // Migrate anyone mid-session from the old sessionStorage-only behaviour.
      var legacy = sessionStorage.getItem(key);
      if (legacy && !localStorage.getItem(key)) localStorage.setItem(key, legacy);
      return localStorage.getItem(key);
    } catch (e) {
      return null; // private mode / storage disabled — just don't persist
    }
  }
  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function clearStored(key) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch (e) {}
  }

  var STATUS_LABELS = {
    "90-Closed": "Closed",
    "20-Waiting on Customer": "Waiting on Customer",
    "22-Waiting on Q2 (internal)": "Waiting on Q2",
    "30-Product Mgmt Review": "Product Mgmt Review",
    "": "Pending sync",
  };
  var STATUS_COLOR_MAP = {
    "90-Closed": "var(--status-good)",
    "20-Waiting on Customer": "var(--status-warning)",
    "22-Waiting on Q2 (internal)": "var(--status-serious)",
    "30-Product Mgmt Review": "var(--status-neutral)",
    "": "var(--status-neutral)",
  };
  var PRIORITY_COLOR_MAP = { Low: "var(--seq-250)", Medium: "var(--seq-450)", High: "var(--seq-650)", "": "var(--text-muted)" };
  var CATEGORY_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];

  // An open case older than this is "ageing" — a long-runner worth a second
  // look, distinct from the weekly "has anyone written a note" nudge.
  var AGEING_DAYS = 90;
  // A successful sync older than this is stale enough to be worth flagging.
  var STALE_SYNC_DAYS = 10;

  // ---------- State ----------
  var STATE = {
    cases: [],
    byNumber: {},
    commentsByCase: {},
    allComments: [],
    relations: null,
    view: "cases",
    expandedCase: null,
    sort: { key: "case_number", dir: "desc" },
    adminPasscode: readStored(STORE_KEY_PASSCODE) || null,
    adminName: readStored(STORE_KEY_NAME) || "",
    syncFilterOnly: false,
    agedFilterOnly: false,
    linkedFilterOnly: false,
    expandedThreads: {},   // case_number -> showing the full portal thread
    expandedEdges: {},     // cluster index -> its written-out link list is open
    editingComment: null,  // id of the weekly note currently being edited
    graphMode: true,       // Related view: diagram vs plain link list
  };

  // ---------- Theme ----------
  var root = document.documentElement;
  var themeState = "auto";
  var themeLabel = document.getElementById("themeLabel");
  document.getElementById("themeToggle").addEventListener("click", function () {
    themeState = themeState === "auto" ? "light" : themeState === "light" ? "dark" : "auto";
    if (themeState === "auto") { root.removeAttribute("data-theme"); themeLabel.textContent = "Auto"; }
    else { root.setAttribute("data-theme", themeState); themeLabel.textContent = themeState === "light" ? "Light" : "Dark"; }
  });

  // ---------- Helpers ----------
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function toast(msg, isError) {
    var el = document.createElement("div");
    el.className = "toast";
    if (isError) el.style.color = "var(--status-critical)";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  function toSortableDate(s) {
    if (!s) return "";
    var parts = s.split(" ")[0].split("/");
    if (parts.length !== 3) return s;
    return parts[2] + parts[1] + parts[0];
  }

  // Portal dates arrive as dd/mm/yyyy, optionally with hh:mm. Parsed by hand
  // because new Date("26/10/2022") is invalid in every browser — it reads the
  // first field as a month.
  function parseUkDate(s) {
    if (!s) return null;
    var m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    var d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
    return isNaN(d.getTime()) ? null : d;
  }

  function daysBetween(a, b) {
    if (!a || !b) return null;
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function relativeTime(date) {
    if (!date) return "never";
    var days = daysBetween(date, new Date());
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    if (days < 365) return Math.round(days / 30) + " months ago";
    return Math.round(days / 365) + " years ago";
  }

  function isClosed(r) { return r.status === "90-Closed"; }

  // Direct link back to the case on the Q2 portal. Needs the Salesforce record
  // ID, which only arrives with a scrape — cases seeded before that (or never
  // successfully synced) fall back to the portal's case list, where the number
  // can be searched.
  function portalUrl(r) {
    return r.portal_record_id ? PORTAL_BASE + "/" + r.portal_record_id + PORTAL_CASE_PATH : null;
  }

  // Columns holding JSON arrays are TEXT everywhere, and a case that has never
  // synced has "" rather than "[]" — so every read goes through this.
  function parseJsonArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      var parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  // ---------- Derived per-case fields ----------
  // Computed once per load so filters, sorting and the Age column all read the
  // same numbers instead of re-parsing dates on every render.
  function enrichCases(cases) {
    var now = new Date();
    cases.forEach(function (r) {
      var opened = parseUkDate(r.date_opened);
      var closed = parseUkDate(r.date_closed);
      r._opened = opened;
      r._closed = closed;
      // For an open case, age is how long it's been running. For a closed one
      // it's how long it took to resolve — the same column answers both.
      r.age_days = opened ? daysBetween(opened, isClosed(r) && closed ? closed : now) : null;
      r._syncedAt = r.last_synced_at ? new Date(r.last_synced_at) : null;
      if (r._syncedAt && isNaN(r._syncedAt.getTime())) r._syncedAt = null;
      r._portalComments = parseJsonArray(r.portal_comments);
      r._attachments = parseJsonArray(r.attachments);
    });
    return cases;
  }

  // ---------- Portal comment thread ----------
  // Rendered as a list of individual comments, newest first, with only the
  // first few expanded. A busy case can carry a hundred portal comments, which
  // as one pre-wrapped text blob is unreadable and buries everything below it.
  var THREAD_PREVIEW = 3;

  function renderPortalThread(r) {
    var thread = r._portalComments;
    if (!thread.length) {
      // The original 115 seeded cases hold hand-written "FIX:/DISCUSSION:"
      // text in raw_comments that the parser can't produce, so that blob is
      // still the fallback — and a re-sync upgrades them to the structured list.
      if (r.raw_comments) {
        return '<p class="thread-fallback">' + escapeHtml(r.raw_comments) + "</p>" +
          '<p class="thread-hint">This case predates structured comment parsing — "🔄 Refresh from portal" ' +
          "will split it into individual comments.</p>";
      }
      return '<p style="color:var(--text-muted); font-size:12px;">Not synced yet.</p>';
    }

    var expanded = STATE.expandedThreads[r.case_number];
    var shown = expanded ? thread : thread.slice(0, THREAD_PREVIEW);
    var hidden = thread.length - shown.length;

    return (
      '<div class="thread-meta">' + plural(thread.length, "comment") + " from the portal" +
        (thread[0] && thread[0].timestamp ? ' · latest ' + escapeHtml(thread[0].timestamp) : "") +
      "</div>" +
      '<div class="thread">' +
        shown.map(function (c, i) {
          return '<div class="thread-item">' +
            '<div class="thread-head">' +
              '<span class="thread-author">' + escapeHtml(c.author || "Unknown") + "</span>" +
              '<span class="thread-when">' + escapeHtml(c.timestamp || "") + "</span>" +
            "</div>" +
            '<div class="thread-text">' + escapeHtml(c.comment) + "</div>" +
          "</div>";
        }).join("") +
      "</div>" +
      (hidden > 0 || expanded
        ? '<button class="btn small" data-action="toggle-thread" data-case="' + escapeHtml(r.case_number) + '">' +
            (expanded ? "Show fewer" : "Show all " + thread.length + " comments") +
          "</button>"
        : "")
    );
  }

  // ---------- Attachments ----------
  // The portal's printable text gives filenames and sizes but no URLs, so a
  // direct href only exists when the scraper managed to read one out of the
  // live DOM. Without it the link goes to the case page, which is where the
  // file is — one extra click rather than a dead end.
  function renderAttachments(r) {
    var files = r._attachments;
    if (!files.length) return "";
    var caseLink = portalUrl(r);
    var images = files.filter(function (f) { return f.is_image; }).length;
    return '<div class="detail-block" style="grid-column: 1 / -1;">' +
      "<h4>Attachments <span class=\"muted\">· " + plural(files.length, "file") +
        (images ? ", " + images + " image" + (images === 1 ? "" : "s") : "") + "</span></h4>" +
      '<div class="attach-row">' +
        files.map(function (f) {
          var href = f.url || caseLink;
          var label = (f.is_image ? "🖼" : "📎") + " " + f.name + (f.size ? " · " + f.size : "");
          if (!href) {
            return '<span class="attach-chip disabled" title="No link available until this case is re-synced">' +
              escapeHtml(label) + "</span>";
          }
          return '<a class="attach-chip" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"' +
            ' title="' + escapeHtml(f.url ? "Open the file on the Q2 portal" : "Opens the case on the Q2 portal — the file is in its Attachments section") + '">' +
            escapeHtml(label) + (f.url ? "" : ' <span class="muted">↗ case</span>') + "</a>";
        }).join("") +
      "</div>" +
      (files.some(function (f) { return !f.url; })
        ? '<p class="thread-hint">Files without a direct link open the case on the portal instead — ' +
          "you need to be signed in to the portal either way.</p>"
        : "") +
    "</div>";
  }

  function isAgeing(r) {
    return !isClosed(r) && r.age_days != null && r.age_days > AGEING_DAYS;
  }

  // ---------- Relationship detection ----------
  // Two independent kinds of link, both mined out of text we already have —
  // no schema field, no scrape, nothing for anyone to keep up to date:
  //
  //   "mention" — one case's text quotes another case's 8-digit number.
  //   "entity"  — two cases name the same business record (loan account
  //               LAI-…, payment transaction LPT-…, charge CHG-…, investor
  //               loan ID ILID-…), which in practice means the same
  //               underlying money moved wrongly twice.
  //
  // The mention pattern deliberately refuses a match preceded by "XXX-",
  // because LAI-00001258 is a loan account, not case 00001258. Without that
  // guard every loan account in the dataset becomes a phantom case link.
  var CASE_REF_RE = /(^|[^A-Za-z0-9-])(0\d{7})(?![0-9])/g;
  var ENTITY_RE = /\b(LAI|LPT|CHG|ILID)-(\d+)\b/g;
  var ENTITY_LABELS = { LAI: "Loan account", LPT: "Payment transaction", CHG: "Charge", ILID: "Investor loan" };

  function caseText(r) {
    return [r.subject, r.description, r.exec_summary, r.raw_comments, r.current_status_note].filter(Boolean).join("\n");
  }

  // LAI-00001134 and LAI-1134 are the same loan account written two ways, so
  // the numeric part is normalised before use as a key.
  function normEntity(prefix, digits) { return prefix + "-" + String(Number(digits)); }

  function buildRelations(cases) {
    var known = {};
    cases.forEach(function (r) { known[String(r.case_number)] = true; });

    var mentions = {};      // case -> [case numbers it names]
    var mentionedBy = {};   // case -> [case numbers that name it]
    var untracked = {};     // referenced number we don't track -> [citing cases]
    var entityCases = {};   // normalised entity id -> { cases: {}, seen: raw label }

    cases.forEach(function (r) {
      var self = String(r.case_number);
      var text = caseText(r);
      mentions[self] = mentions[self] || [];
      mentionedBy[self] = mentionedBy[self] || [];

      var m;
      CASE_REF_RE.lastIndex = 0;
      var seen = {};
      while ((m = CASE_REF_RE.exec(text)) !== null) {
        var ref = m[2];
        if (ref === self || seen[ref]) continue;
        seen[ref] = true;
        if (known[ref]) {
          mentions[self].push(ref);
          (mentionedBy[ref] = mentionedBy[ref] || []).push(self);
        } else {
          (untracked[ref] = untracked[ref] || []).push(self);
        }
      }

      ENTITY_RE.lastIndex = 0;
      while ((m = ENTITY_RE.exec(text)) !== null) {
        var key = normEntity(m[1], m[2]);
        var rec = entityCases[key] || (entityCases[key] = { prefix: m[1], cases: {} });
        rec.cases[self] = true;
      }
    });

    // Only entities touching more than one case are a relationship; the rest
    // are just an ID mentioned once and tell us nothing.
    var sharedEntities = [];
    var entityLinks = {}; // case -> [{ entity, others }]
    Object.keys(entityCases).forEach(function (key) {
      var members = Object.keys(entityCases[key].cases);
      if (members.length < 2) return;
      sharedEntities.push({ entity: key, prefix: entityCases[key].prefix, cases: members });
      members.forEach(function (c) {
        (entityLinks[c] = entityLinks[c] || []).push({
          entity: key,
          prefix: entityCases[key].prefix,
          others: members.filter(function (o) { return o !== c; }),
        });
      });
    });

    // Undirected edge list, tagged with how each link was found. A pair can
    // legitimately be joined both ways, so both tags are kept.
    var edgeMap = {};
    function addEdge(a, b, kind, label) {
      var key = [a, b].sort().join("|");
      var e = edgeMap[key] || (edgeMap[key] = { a: [a, b].sort()[0], b: [a, b].sort()[1], kinds: {}, entities: [] });
      e.kinds[kind] = true;
      if (label && e.entities.indexOf(label) === -1) e.entities.push(label);
    }
    Object.keys(mentions).forEach(function (from) {
      mentions[from].forEach(function (to) { addEdge(from, to, "mention"); });
    });
    sharedEntities.forEach(function (se) {
      for (var i = 0; i < se.cases.length; i++) {
        for (var j = i + 1; j < se.cases.length; j++) addEdge(se.cases[i], se.cases[j], "entity", se.entity);
      }
    });

    return {
      mentions: mentions,
      mentionedBy: mentionedBy,
      untracked: untracked,
      sharedEntities: sharedEntities,
      entityLinks: entityLinks,
      edges: Object.keys(edgeMap).map(function (k) { return edgeMap[k]; }),
    };
  }

  // Groups linked cases into families (connected components) so the UI can
  // show "these six cases are all the same underlying problem" rather than a
  // flat list of pairs.
  function buildClusters(edges) {
    var adj = {};
    edges.forEach(function (e) {
      (adj[e.a] = adj[e.a] || []).push(e.b);
      (adj[e.b] = adj[e.b] || []).push(e.a);
    });
    var seen = {}, clusters = [];
    Object.keys(adj).forEach(function (start) {
      if (seen[start]) return;
      var stack = [start], members = [];
      seen[start] = true;
      while (stack.length) {
        var n = stack.pop();
        members.push(n);
        (adj[n] || []).forEach(function (o) { if (!seen[o]) { seen[o] = true; stack.push(o); } });
      }
      var memberSet = {};
      members.forEach(function (m) { memberSet[m] = true; });
      clusters.push({
        members: members.sort(),
        edges: edges.filter(function (e) { return memberSet[e.a] && memberSet[e.b]; }),
      });
    });
    return clusters.sort(function (a, b) { return b.members.length - a.members.length; });
  }

  // ---------- Cluster diagram ----------
  // A small force-directed layout per cluster, drawn as inline SVG. One
  // diagram per cluster rather than one giant graph of everything: a cluster
  // is the unit you actually reason about ("111 links 222, and 222 is also in
  // 333 and 444"), and 76 linked cases in a single picture is a hairball.
  //
  // Plain spring-electrical relaxation — repulsion between every pair,
  // attraction along edges, cooling step size. Deterministic: nodes start on a
  // circle by index, so the same cluster always draws the same way instead of
  // rearranging on every render.
  var RENDER_WIDTH = 900;   // canonical layout width; 1 unit ≈ 1 rendered pixel
  var NODE_R_MIN = 7;
  var NODE_R_MAX = 14;

  function layoutCluster(members, edges, width, height) {
    var n = members.length;
    var idx = {};
    members.forEach(function (m, i) { idx[m] = i; });

    var cx = width / 2, cy = height / 2;
    var radius = Math.min(width, height) * 0.34;
    var pos = members.map(function (m, i) {
      var a = (2 * Math.PI * i) / n;
      return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
    });
    if (n === 1) return pos;

    var links = edges.map(function (e) { return [idx[e.a], idx[e.b]]; });
    // Ideal edge length. These link graphs are mostly trees — few cycles — and
    // a tree under weak repulsion collapses into a thin snake that wastes the
    // canvas and stacks labels on top of each other. Strong repulsion plus a
    // long, slow cool spreads it into two dimensions instead.
    var k = Math.sqrt((width * height) / n) * 0.9;
    var iterations = 520;
    var step = k * 0.5;

    for (var it = 0; it < iterations; it++) {
      var dx = new Array(n).fill(0);
      var dy = new Array(n).fill(0);

      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var ax = pos[i].x - pos[j].x;
          var ay = pos[i].y - pos[j].y;
          var d2 = ax * ax + ay * ay;
          if (d2 < 0.01) { ax = (i - j) * 0.1 + 0.05; ay = 0.05; d2 = ax * ax + ay * ay; }
          var d = Math.sqrt(d2);
          var rep = (k * k) / d;
          dx[i] += (ax / d) * rep; dy[i] += (ay / d) * rep;
          dx[j] -= (ax / d) * rep; dy[j] -= (ay / d) * rep;
        }
      }
      links.forEach(function (l) {
        var a = l[0], b = l[1];
        var lx = pos[a].x - pos[b].x;
        var ly = pos[a].y - pos[b].y;
        var d = Math.sqrt(lx * lx + ly * ly) || 0.01;
        var att = (d * d) / k;
        dx[a] -= (lx / d) * att; dy[a] -= (ly / d) * att;
        dx[b] += (lx / d) * att; dy[b] += (ly / d) * att;
      });
      // Gentle pull to centre so disconnected-ish nodes don't drift away.
      for (var c = 0; c < n; c++) {
        dx[c] += (cx - pos[c].x) * 0.012;
        dy[c] += (cy - pos[c].y) * 0.012;
      }

      for (var p = 0; p < n; p++) {
        var len = Math.sqrt(dx[p] * dx[p] + dy[p] * dy[p]) || 1;
        var move = Math.min(len, step);
        pos[p].x += (dx[p] / len) * move;
        pos[p].y += (dy[p] / len) * move;
      }
      step *= 0.992;
    }

    // Rotate the finished layout so its longest axis runs horizontally. The
    // relaxation has no preferred orientation, so a chain of cases would just
    // as happily settle on a diagonal — which gives a near-square bounding box
    // and therefore a tall, mostly-empty diagram in a wide card. Aligning the
    // principal axis (the 2D covariance eigenvector) with x makes every
    // cluster read left-to-right and keeps the card short.
    var mx = 0, my = 0;
    pos.forEach(function (p) { mx += p.x; my += p.y; });
    mx /= n; my /= n;
    var cxx = 0, cyy = 0, cxy = 0;
    pos.forEach(function (p) {
      var ax = p.x - mx, ay = p.y - my;
      cxx += ax * ax; cyy += ay * ay; cxy += ax * ay;
    });
    var theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    var cos = Math.cos(-theta), sin = Math.sin(-theta);
    pos.forEach(function (p) {
      var ax = p.x - mx, ay = p.y - my;
      p.x = mx + ax * cos - ay * sin;
      p.y = my + ax * sin + ay * cos;
    });

    // Normalise to a canonical width so one user unit is roughly one rendered
    // pixel. Everything downstream — radii, font size, minimum separation —
    // is then a plain pixel number in the same space, instead of the layout
    // and the drawing each having their own scale (which previously let the
    // separation pass enforce a gap smaller than the circles it was
    // separating).
    var xs0 = pos.map(function (p) { return p.x; });
    var ys0 = pos.map(function (p) { return p.y; });
    var w0 = Math.max.apply(null, xs0) - Math.min.apply(null, xs0);
    var h0 = Math.max.apply(null, ys0) - Math.min.apply(null, ys0);
    var scale = w0 > 1 ? RENDER_WIDTH / w0 : 1;
    // Don't let a tall, narrow cluster overflow vertically once widened.
    if (h0 * scale > RENDER_WIDTH * 0.62) scale = (RENDER_WIDTH * 0.62) / h0;
    pos.forEach(function (p) { p.x *= scale; p.y *= scale; });

    // Now push apart any pair still closer than two full node radii plus a
    // little breathing room. In pixel space this is a fixed number.
    var minGap = 2 * NODE_R_MAX + 8;
    for (var pass = 0; pass < 200; pass++) {
      var moved = false;
      for (var i2 = 0; i2 < n; i2++) {
        for (var j2 = i2 + 1; j2 < n; j2++) {
          var ox = pos[j2].x - pos[i2].x;
          var oy = pos[j2].y - pos[i2].y;
          var od = Math.sqrt(ox * ox + oy * oy) || 0.01;
          if (od >= minGap) continue;
          var push = (minGap - od) / 2;
          pos[i2].x -= (ox / od) * push; pos[i2].y -= (oy / od) * push;
          pos[j2].x += (ox / od) * push; pos[j2].y += (oy / od) * push;
          moved = true;
        }
      }
      if (!moved) break;
    }

    return pos;
  }

  function clusterDiagram(cluster, rel) {
    var members = cluster.members;
    var n = members.length;
    // The layout runs in a nominal square and the viewBox is then fitted to
    // whatever shape it actually settled into. Forcing a fixed box instead
    // meant a wide, flat cluster — which most of these are, being near-trees —
    // sat in a deep band of empty space.
    var span = 300 + Math.sqrt(n) * 180;
    var pos = layoutCluster(members, cluster.edges, span, span);
    var at = {};
    members.forEach(function (m, i) { at[m] = pos[i]; });

    var degree = {};
    cluster.edges.forEach(function (e) {
      degree[e.a] = (degree[e.a] || 0) + 1;
      degree[e.b] = (degree[e.b] || 0) + 1;
    });
    var maxDeg = Math.max.apply(null, members.map(function (m) { return degree[m] || 0; }).concat([1]));

    // layoutCluster already normalised positions to pixel space, so radii,
    // font sizes and padding below are plain pixel numbers.

    var edgeSvg = cluster.edges.map(function (e) {
      var a = at[e.a], b = at[e.b];
      var aMentionsB = (rel.mentions[e.a] || []).indexOf(e.b) !== -1;
      var bMentionsA = (rel.mentions[e.b] || []).indexOf(e.a) !== -1;
      // Mentions are solid and get an arrowhead on the cited end; a shared
      // loan/transaction is a dashed undirected line, since neither case
      // points at the other.
      var mention = !!e.kinds.mention;
      var title = e.a + (mention ? (aMentionsB && bMentionsA ? " ⇄ " : aMentionsB ? " → " : " ← ") : " ⇄ ") + e.b +
        (mention ? (aMentionsB && bMentionsA ? " mention each other" : " mentions") : "") +
        (e.kinds.entity ? (mention ? "; also share " : " share ") + e.entities.join(", ") : "");
      // Draw the arrow from citer to cited so direction reads off the picture.
      var from = mention && !aMentionsB ? b : a;
      var to = mention && !aMentionsB ? a : b;
      return '<line x1="' + from.x.toFixed(1) + '" y1="' + from.y.toFixed(1) +
        '" x2="' + to.x.toFixed(1) + '" y2="' + to.y.toFixed(1) + '"' +
        ' class="g-edge' + (mention ? "" : " entity") + (mention && aMentionsB && bMentionsA ? " mutual" : "") + '"' +
        ' stroke-width="1.6" stroke-dasharray="' + (mention ? "none" : "5 4") + '"' +
        (mention ? ' marker-end="url(#garrow)"' : "") +
        "><title>" + escapeHtml(title) + "</title></line>";
    }).join("");

    // Not every circle can carry its case number — in a dense cluster the
    // numbers land on top of each other. Rather than a blunt "only hubs get
    // labels" rule, walk the nodes most-connected first and keep a label only
    // when its box doesn't collide with one already placed. That labels as many
    // as genuinely fit, and the most important ones win the ties. Everything
    // else keeps its hover tooltip and its chip below the diagram.
    var labelW = 8 * 5.6;   // 8-digit case number at the label font size
    var labelH = 11;
    var placed = [];
    var labelled = {};
    members
      .slice()
      .sort(function (a, b) { return (degree[b] || 0) - (degree[a] || 0); })
      .forEach(function (m) {
        var p = at[m];
        var deg = degree[m] || 0;
        var radius = NODE_R_MIN + (deg / maxDeg) * (NODE_R_MAX - NODE_R_MIN);
        var box = { x1: p.x - labelW / 2, x2: p.x + labelW / 2, y1: p.y + radius + 2, y2: p.y + radius + 2 + labelH };
        var clash = placed.some(function (q) {
          return !(box.x2 < q.x1 || box.x1 > q.x2 || box.y2 < q.y1 || box.y1 > q.y2);
        });
        if (clash) return;
        placed.push(box);
        labelled[m] = true;
      });
    var labelAll = Object.keys(labelled).length === n;

    var nodeSvg = members.map(function (m) {
      var p = at[m];
      var r = STATE.byNumber[m] || {};
      var deg = degree[m] || 0;
      // Radius carries connectedness, so the hub of a cluster is visibly the hub.
      var radius = NODE_R_MIN + (deg / maxDeg) * (NODE_R_MAX - NODE_R_MIN);
      var color = STATUS_COLOR_MAP[r.status || ""] || "var(--status-neutral)";
      var open = r.status && !isClosed(r);
      var showLabel = !!labelled[m];
      return '<g class="g-node" data-open-case="' + escapeHtml(m) + '" tabindex="0">' +
        "<title>" + escapeHtml(m + " · " + (r.subject || "(awaiting sync)") + "\n" +
          (STATUS_LABELS[r.status || ""] || r.status || "Pending sync") + " · " + plural(deg, "link")) + "</title>" +
        '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + radius.toFixed(1) +
          '" fill="' + color + '"' + (open ? ' class="g-open"' : "") +
          ' stroke-width="' + (open ? "2.5" : "2") + '" />' +
        (showLabel
          ? '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + radius + 11).toFixed(1) +
              '" class="g-label" font-size="10" stroke-width="3">' +
              escapeHtml(m) + "</text>"
          : "") +
        "</g>";
    }).join("");

    // Fit the viewBox to the drawn content: node radius on every side, plus
    // extra at the bottom for the labels that hang below their circles.
    var maxR = NODE_R_MAX;
    var xs = members.map(function (m) { return at[m].x; });
    var ys = members.map(function (m) { return at[m].y; });
    var vx = Math.min.apply(null, xs) - maxR - 34;
    var vy = Math.min.apply(null, ys) - maxR - 8;
    var vw = Math.max.apply(null, xs) - Math.min.apply(null, xs) + 2 * maxR + 68;
    var vh = Math.max.apply(null, ys) - Math.min.apply(null, ys) + 2 * maxR + 26;

    return '<div class="graph-wrap">' +
      (labelAll ? "" : '<p class="graph-note">Only the most-linked cases are labelled — hover or click any circle to identify it.</p>') +
      '<svg class="cluster-graph" viewBox="' + vx.toFixed(1) + " " + vy.toFixed(1) + " " + vw.toFixed(1) + " " + vh.toFixed(1) +
      '" role="img" aria-label="Diagram of ' + n + ' linked cases">' +
      "<defs><marker id=\"garrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\">" +
        '<path d="M 0 1 L 10 5 L 0 9 z" class="g-arrow" /></marker></defs>' +
      edgeSvg + nodeSvg +
      "</svg></div>";
  }

  function hasAnyLink(caseNumber) {
    if (!STATE.relations) return false;
    var cn = String(caseNumber);
    return (
      (STATE.relations.mentions[cn] || []).length > 0 ||
      (STATE.relations.mentionedBy[cn] || []).length > 0 ||
      (STATE.relations.entityLinks[cn] || []).length > 0
    );
  }

  // ---------- Weekly sync-up tracking ----------
  // "Needs sync-up" = an open case with no weekly note logged since the
  // most recent Wednesday (today counts, if today is Wednesday). Purely a
  // client-side nudge computed from existing comment timestamps — no
  // separate "last synced" field to keep in sync.
  function mostRecentWednesday(now) {
    var d = new Date(now);
    var diff = (d.getDay() - 3 + 7) % 7; // days since the last Wednesday (0 if today is Wed)
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function latestCommentAt(caseNumber) {
    var comments = STATE.commentsByCase[caseNumber] || [];
    if (!comments.length) return null;
    return comments.reduce(function (max, c) {
      var t = new Date(c.timestamp);
      return !max || t > max ? t : max;
    }, null);
  }

  function needsWeeklySync(r) {
    if (isClosed(r)) return false;
    var cutoff = mostRecentWednesday(new Date());
    var latest = latestCommentAt(r.case_number);
    return !latest || latest < cutoff;
  }

  function isReopened(r) {
    return !!r.date_closed && !isClosed(r);
  }

  function renderSyncBanner(cases) {
    var open = cases.filter(function (r) { return !isClosed(r); });
    var needing = open.filter(needsWeeklySync);
    var failed = cases.filter(function (r) { return r.sync_status === "error"; });
    var el = document.getElementById("syncBanner");
    var toggle = document.getElementById("syncFilterToggle");
    toggle.textContent = "🗓 Needs sync-up (" + needing.length + ")";

    var bits = [];
    if (open.length && needing.length) {
      bits.push(
        "📅 <b>" + needing.length + " of " + open.length + "</b> open cases still need this week's sync-up note — " +
        '<span class="link" data-jump="sync-needed">show them</span>.'
      );
    }
    if (failed.length) {
      bits.push(
        "⚠️ <b>" + plural(failed.length, "case") + "</b> failed to sync from the portal — " +
        '<span class="link" data-jump="sync-view">see why</span>.'
      );
    }
    if (!bits.length) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.innerHTML = bits.join("<br>");
    el.querySelectorAll("[data-jump]").forEach(function (link) {
      link.addEventListener("click", function () {
        if (link.getAttribute("data-jump") === "sync-view") {
          setView("sync");
        } else {
          setView("cases");
          STATE.syncFilterOnly = true;
          document.getElementById("syncFilterToggle").classList.add("active");
          renderTable();
          document.querySelector(".table-card").scrollIntoView({ behavior: "smooth" });
        }
      });
    });
  }

  async function apiFetch(url, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.auth && STATE.adminPasscode) headers["X-Admin-Passcode"] = STATE.adminPasscode;
    var res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ "Content-Type": "application/json" }, headers) }));
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ("Request failed: " + res.status));
    return data;
  }

  // ---------- Admin unlock ----------
  var adminToggle = document.getElementById("adminToggle");
  function setAdminUi() {
    adminToggle.innerHTML = STATE.adminPasscode ? ("🔓 " + escapeHtml(STATE.adminName || "Admin")) : "🔒 Admin";
  }
  setAdminUi();

  var unlockModal = document.getElementById("unlockModal");
  var unlockInput = document.getElementById("unlockInput");
  var unlockError = document.getElementById("unlockError");

  adminToggle.addEventListener("click", function () {
    if (STATE.adminPasscode) {
      STATE.adminPasscode = null;
      STATE.adminName = "";
      clearStored(STORE_KEY_PASSCODE);
      clearStored(STORE_KEY_NAME);
      setAdminUi();
      toast("Editing locked.");
      renderCurrentView();
      return;
    }
    unlockError.style.display = "none";
    unlockInput.value = "";
    unlockModal.style.display = "flex";
    unlockInput.focus();
  });
  document.getElementById("unlockCancel").addEventListener("click", function () { unlockModal.style.display = "none"; });
  document.getElementById("unlockSubmit").addEventListener("click", async function () {
    var passcode = unlockInput.value;
    try {
      var result = await apiFetch(API_AUTH_CHECK, { method: "POST", body: JSON.stringify({ passcode: passcode }) });
      STATE.adminPasscode = passcode;
      STATE.adminName = result.name || "";
      writeStored(STORE_KEY_PASSCODE, passcode);
      writeStored(STORE_KEY_NAME, STATE.adminName);
      setAdminUi();
      unlockModal.style.display = "none";
      toast("Editing unlocked as " + (STATE.adminName || "Admin") + ".");
      renderCurrentView();
    } catch (err) {
      unlockError.textContent = err.message;
      unlockError.style.display = "block";
    }
  });
  unlockInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("unlockSubmit").click();
  });

  function requireAdmin() {
    if (!STATE.adminPasscode) {
      unlockModal.style.display = "flex";
      unlockInput.focus();
      return false;
    }
    return true;
  }

  // ---------- Add case modal ----------
  var addCaseModal = document.getElementById("addCaseModal");
  var addCaseError = document.getElementById("addCaseError");
  document.getElementById("addCaseBtn").addEventListener("click", function () {
    if (!requireAdmin()) return;
    addCaseError.style.display = "none";
    document.getElementById("addCaseNumber").value = "";
    document.getElementById("addCaseSummary").value = "";
    document.getElementById("addCaseAuthor").value = STATE.adminName || "";
    addCaseModal.style.display = "flex";
  });
  document.getElementById("addCaseCancel").addEventListener("click", function () { addCaseModal.style.display = "none"; });
  document.getElementById("addCaseSubmit").addEventListener("click", async function () {
    var caseNumber = document.getElementById("addCaseNumber").value.trim();
    var summary = document.getElementById("addCaseSummary").value.trim();
    var author = document.getElementById("addCaseAuthor").value.trim();
    if (!caseNumber) {
      addCaseError.textContent = "Case number is required.";
      addCaseError.style.display = "block";
      return;
    }
    if (STATE.byNumber[caseNumber]) {
      addCaseError.textContent = "Case " + caseNumber + " is already tracked.";
      addCaseError.style.display = "block";
      return;
    }
    try {
      var result = await apiFetch(API_CASES, {
        method: "POST",
        auth: true,
        body: JSON.stringify({ case_number: caseNumber, exec_summary: summary, added_by: author }),
      });
      addCaseModal.style.display = "none";
      if (result.dispatch && result.dispatch.dispatched === false) {
        toast("Case added, but auto-pull isn't configured yet (see README) — fill in fields manually for now.");
      } else {
        toast("Case added — pulling details from the portal now, refresh in a minute.");
      }
      await loadData();
    } catch (err) {
      addCaseError.textContent = err.message;
      addCaseError.style.display = "block";
    }
  });

  // ---------- Charts ----------
  function countBy(arr, key) {
    var m = {};
    arr.forEach(function (r) {
      var v = r[key] || "";
      m[v] = (m[v] || 0) + 1;
    });
    return m;
  }

  function renderBarChart(containerId, counts, colorFn, order, labelFn) {
    var el = document.getElementById(containerId);
    var keys = order || Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    var max = Math.max.apply(null, keys.map(function (k) { return counts[k] || 0; }).concat([1]));
    el.innerHTML = keys.map(function (k, i) {
      var v = counts[k] || 0;
      var pct = Math.round((v / max) * 100);
      var color = colorFn(k, i);
      var label = labelFn ? labelFn(k) : (k || "(blank)");
      return '<div class="bar-row">' +
        '<div class="bar-label"><span class="bar-icon" style="background:' + color + '"></span>' + escapeHtml(label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%; background:' + color + '"></div></div>' +
        '<div class="bar-value">' + v + '</div>' +
        '</div>';
    }).join("");
  }

  function renderTiles(cases) {
    var total = cases.length;
    var closedCases = cases.filter(isClosed);
    var open = cases.filter(function (r) { return !isClosed(r); });
    var high = cases.filter(function (r) { return r.priority === "High"; }).length;
    var pending = cases.filter(function (r) { return r.sync_status === "pending"; }).length;
    var failed = cases.filter(function (r) { return r.sync_status === "error"; }).length;
    var needsSync = cases.filter(needsWeeklySync).length;
    var reopened = cases.filter(isReopened).length;
    var ageing = cases.filter(isAgeing);

    var openAges = open.map(function (r) { return r.age_days; }).filter(function (d) { return d != null; });
    var closeTimes = closedCases.map(function (r) { return r.age_days; }).filter(function (d) { return d != null; });
    var oldestOpen = open.reduce(function (best, r) {
      if (r.age_days == null) return best;
      return !best || r.age_days > best.age_days ? r : best;
    }, null);

    var linkedCount = cases.filter(function (r) { return hasAnyLink(r.case_number); }).length;

    var tiles = [
      { label: "Total cases", value: total, sub: pending ? plural(pending, "case") + " pending sync" : "all synced" },
      { label: "Open / in review", value: open.length, sub: reopened ? plural(reopened, "reopened case") : "none reopened" },
      { label: "Closed", value: closedCases.length, sub: total ? Math.round(closedCases.length / total * 100) + "% of all cases" : "—" },
      { label: "High priority", value: high, sub: total ? Math.round(high / total * 100) + "% of all cases" : "—" },
      { label: "Needs this week's update", value: needsSync, sub: open.length ? needsSync + " of " + open.length + " open" : "—" },
      {
        label: "Ageing (>" + AGEING_DAYS + "d open)",
        value: ageing.length,
        sub: oldestOpen ? "oldest " + oldestOpen.case_number + " · " + plural(oldestOpen.age_days, "day") : "—",
      },
      {
        label: "Median age, open",
        value: openAges.length ? median(openAges) + "d" : "—",
        sub: closeTimes.length ? "closed took " + median(closeTimes) + "d (median)" : "—",
      },
      {
        label: "Linked cases",
        value: linkedCount,
        sub: STATE.relations ? plural(STATE.relations.edges.length, "link") + " detected" : "—",
      },
      {
        label: "Sync failures",
        value: failed,
        sub: failed ? "see Sync health" : "no failures",
      },
    ];
    document.getElementById("tiles").innerHTML = tiles.map(function (t) {
      return '<div class="tile"><p class="label">' + escapeHtml(t.label) + '</p><p class="value">' + escapeHtml(String(t.value)) + '</p><p class="sub">' + escapeHtml(t.sub) + '</p></div>';
    }).join("");
  }

  function renderCharts(cases) {
    var statusCounts = countBy(cases, "status");
    var statusOrder = Object.keys(STATUS_LABELS).filter(function (k) { return statusCounts[k]; });
    renderBarChart("chartStatus", statusCounts, function (k) { return STATUS_COLOR_MAP[k] || "var(--status-neutral)"; }, statusOrder, function (k) { return STATUS_LABELS[k] || k; });

    var priorityCounts = countBy(cases, "priority");
    var priorityOrder = ["Low", "Medium", "High"].filter(function (k) { return priorityCounts[k]; });
    if (priorityCounts[""]) priorityOrder.push("");
    renderBarChart("chartPriority", priorityCounts, function (k) { return PRIORITY_COLOR_MAP[k] || "var(--text-muted)"; }, priorityOrder, function (k) { return k || "Pending"; });

    var categoryCounts = countBy(cases, "product_category");
    var categoryKeys = Object.keys(categoryCounts).sort(function (a, b) { return categoryCounts[b] - categoryCounts[a]; });
    renderBarChart("chartCategory", categoryCounts, function (k, i) { return k ? CATEGORY_COLORS[i % CATEGORY_COLORS.length] : "var(--text-muted)"; }, categoryKeys, function (k) { return k || "Pending"; });
  }

  // ---------- View switching ----------
  var VIEWS = ["cases", "activity", "related", "sync"];
  function setView(view) {
    if (VIEWS.indexOf(view) === -1) view = "cases";
    STATE.view = view;
    VIEWS.forEach(function (v) {
      document.getElementById("view-" + v).style.display = v === view ? "" : "none";
    });
    // Each of the other views leads with its own digest tiles, so showing the
    // portfolio-wide row as well would just be two stacked bands of numbers.
    document.getElementById("tiles").style.display = view === "cases" ? "" : "none";
    document.querySelectorAll("#tabs .tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === view);
    });
    renderCurrentView();
  }
  document.querySelectorAll("#tabs .tab").forEach(function (t) {
    t.addEventListener("click", function () { setView(t.getAttribute("data-view")); });
  });

  function renderCurrentView() {
    if (STATE.view === "cases") renderTable();
    else if (STATE.view === "activity") renderActivity();
    else if (STATE.view === "related") renderRelated();
    else if (STATE.view === "sync") renderSyncHealth();
  }

  // Opens a case from anywhere — a related-case chip, the activity feed, the
  // sync table — by switching to the Cases view and expanding it. The hash
  // makes it a shareable link ("#case=04692476" in a Teams message).
  function openCase(caseNumber, updateHash) {
    setView("cases");
    STATE.expandedCase = String(caseNumber);
    // A case hidden by the active filters can't be expanded into view, so
    // clear them rather than silently doing nothing.
    if (!sortData(applyFilters()).some(function (r) { return String(r.case_number) === String(caseNumber); })) {
      clearFilters();
    }
    if (updateHash !== false) {
      if (window.location.hash !== "#case=" + caseNumber) {
        history.replaceState(null, "", "#case=" + caseNumber);
      }
    }
    renderTable();
    var row = document.querySelector("tr.case-row[data-case='" + caseNumber + "']");
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function caseChip(caseNumber, note) {
    var r = STATE.byNumber[String(caseNumber)];
    var label = r ? (r.subject || "(awaiting sync)") : "not tracked";
    var color = r ? (STATUS_COLOR_MAP[r.status || ""] || "var(--status-neutral)") : "var(--text-muted)";
    return '<button class="case-chip" data-open-case="' + escapeHtml(caseNumber) + '"' +
      ' title="' + escapeHtml(label) + '">' +
      '<span class="dot" style="background:' + color + '"></span>' +
      '<b>' + escapeHtml(caseNumber) + '</b>' +
      '<span class="chip-sub">' + escapeHtml(label.length > 46 ? label.slice(0, 45) + "…" : label) + '</span>' +
      (note ? '<span class="chip-note">' + escapeHtml(note) + '</span>' : '') +
      '</button>';
  }

  function wireCaseChips(container) {
    container.querySelectorAll("[data-open-case]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        openCase(btn.getAttribute("data-open-case"));
      });
    });
  }

  // ---------- Filters (Cases view) ----------
  var statusFilter = document.getElementById("statusFilter");
  var priorityFilter = document.getElementById("priorityFilter");
  var categoryFilter = document.getElementById("categoryFilter");
  var searchInput = document.getElementById("searchInput");

  function populateFilterOptions() {
    [statusFilter, priorityFilter, categoryFilter].forEach(function (sel) {
      while (sel.options.length > 1) sel.remove(1);
    });
    uniqueSorted("status").forEach(function (v) {
      var o = document.createElement("option"); o.value = v; o.textContent = STATUS_LABELS[v] || v || "Pending sync";
      statusFilter.appendChild(o);
    });
    uniqueSorted("priority").forEach(function (v) {
      var o = document.createElement("option"); o.value = v; o.textContent = v || "Pending";
      priorityFilter.appendChild(o);
    });
    uniqueSorted("product_category").forEach(function (v) {
      var o = document.createElement("option"); o.value = v; o.textContent = v || "Pending";
      categoryFilter.appendChild(o);
    });
  }
  function uniqueSorted(key) {
    var set = {};
    STATE.cases.forEach(function (r) { set[r[key] || ""] = true; });
    return Object.keys(set).sort();
  }

  function applyFilters() {
    var q = searchInput.value.trim().toLowerCase();
    return STATE.cases.filter(function (r) {
      if (statusFilter.value && statusFilter.value !== (r.status || "")) return false;
      if (priorityFilter.value && priorityFilter.value !== (r.priority || "")) return false;
      if (categoryFilter.value && categoryFilter.value !== (r.product_category || "")) return false;
      if (STATE.syncFilterOnly && !needsWeeklySync(r)) return false;
      if (STATE.agedFilterOnly && !isAgeing(r)) return false;
      if (STATE.linkedFilterOnly && !hasAnyLink(r.case_number)) return false;
      if (q) {
        var notes = (STATE.commentsByCase[r.case_number] || []).map(function (c) { return c.comment; }).join(" ");
        var hay = [r.subject, r.description, r.exec_summary, r.raw_comments, r.current_status_note, r.case_number, r.contact_name, notes].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function sortData(arr) {
    var key = STATE.sort.key, dir = STATE.sort.dir;
    return arr.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (key === "date_opened" || key === "date_closed") { av = toSortableDate(av); bv = toSortableDate(bv); }
      if (key === "age_days") {
        // Nulls (never-synced cases with no open date) sort last either way,
        // rather than pretending to be age zero.
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return dir === "asc" ? av - bv : bv - av;
      }
      av = av == null ? "" : av; bv = bv == null ? "" : bv;
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });
  }

  // ---------- Table + detail ----------
  function syncBadge(r) {
    if (r.sync_status === "pending") return '<span class="pill"><span class="dot" style="background:var(--status-warning)"></span>Pending</span>';
    if (r.sync_status === "error") return '<span class="pill err" title="' + escapeHtml(r.sync_error || "Sync failed") + '"><span class="dot" style="background:var(--status-critical)"></span>Sync failed</span>';
    return "";
  }

  // The full success/failure story for one case, shown in its detail row.
  function syncStatusLine(r) {
    if (r.sync_status === "error") {
      return '<div class="sync-line err">' +
        "<b>✕ Last sync failed</b>" +
        (r._syncedAt ? " <span class=\"muted\">" + escapeHtml(relativeTime(r._syncedAt)) + " · " + escapeHtml(r._syncedAt.toLocaleString()) + "</span>" : "") +
        (r.sync_error ? '<div class="sync-reason">' + escapeHtml(r.sync_error) + "</div>" : "") +
        "</div>";
    }
    if (r.sync_status === "pending") {
      return '<div class="sync-line pending"><b>⧗ Sync queued</b> <span class="muted">waiting for the portal scrape to run</span></div>';
    }
    var stale = r._syncedAt && daysBetween(r._syncedAt, new Date()) > STALE_SYNC_DAYS;
    return '<div class="sync-line ok' + (stale ? " stale" : "") + '">' +
      "<b>✓ Synced</b> " +
      '<span class="muted">' +
      (r._syncedAt ? escapeHtml(relativeTime(r._syncedAt)) + " · " + escapeHtml(r._syncedAt.toLocaleString()) : "no timestamp recorded") +
      (stale ? " — older than " + STALE_SYNC_DAYS + " days" : "") +
      "</span></div>";
  }

  function relatedBlock(r) {
    if (!STATE.relations) return "";
    var cn = String(r.case_number);
    var mentions = STATE.relations.mentions[cn] || [];
    var mentionedBy = STATE.relations.mentionedBy[cn] || [];
    var entities = STATE.relations.entityLinks[cn] || [];
    if (!mentions.length && !mentionedBy.length && !entities.length) {
      return '<div class="detail-block" style="grid-column: 1 / -1;">' +
        "<h4>Related cases</h4>" +
        '<p style="color:var(--text-muted); font-size:12px;">No other case references this one, and it shares no loan account or transaction ID with another case.</p>' +
        "</div>";
    }
    var parts = [];
    if (mentions.length) {
      parts.push('<div class="rel-group"><span class="rel-label">This case mentions →</span><div class="chip-row">' +
        mentions.map(function (m) { return caseChip(m); }).join("") + "</div></div>");
    }
    if (mentionedBy.length) {
      parts.push('<div class="rel-group"><span class="rel-label">← Mentioned by</span><div class="chip-row">' +
        mentionedBy.map(function (m) { return caseChip(m); }).join("") + "</div></div>");
    }
    entities.forEach(function (link) {
      parts.push('<div class="rel-group"><span class="rel-label">⇄ Same ' +
        escapeHtml((ENTITY_LABELS[link.prefix] || link.prefix).toLowerCase()) + " <code>" + escapeHtml(link.entity) + "</code></span>" +
        '<div class="chip-row">' + link.others.map(function (m) { return caseChip(m); }).join("") + "</div></div>");
    });
    return '<div class="detail-block" style="grid-column: 1 / -1;"><h4>Related cases</h4>' + parts.join("") + "</div>";
  }

  // One weekly note. Shows when it was written, and — if someone has since
  // fixed a typo — that it was edited, without losing the original date.
  function renderWeeklyNote(c, isAdmin) {
    var written = c._at ? c._at.toLocaleString() : c.timestamp;
    var editedAt = c.edited_at ? new Date(c.edited_at) : null;
    if (editedAt && isNaN(editedAt.getTime())) editedAt = null;

    if (STATE.editingComment === c.id) {
      return '<div class="comment-item editing">' +
        '<div class="who"><span>' + escapeHtml(c.author) + "</span><span>" + escapeHtml(written) + "</span></div>" +
        '<textarea class="note-edit-input" data-id="' + escapeHtml(String(c.id)) + '">' + escapeHtml(c.comment) + "</textarea>" +
        '<div class="note-edit-actions">' +
          '<button class="btn small primary" data-action="save-comment" data-id="' + escapeHtml(String(c.id)) + '">Save</button>' +
          '<button class="btn small" data-action="cancel-edit-comment">Cancel</button>' +
          '<button class="btn small danger" data-action="delete-comment" data-id="' + escapeHtml(String(c.id)) + '">Delete</button>' +
        "</div>" +
      "</div>";
    }

    return '<div class="comment-item">' +
      '<div class="who">' +
        "<span>" + escapeHtml(c.author || "unknown") + "</span>" +
        '<span class="note-when">' + escapeHtml(written) +
          (editedAt ? ' <span class="edited-tag" title="Edited ' + escapeHtml(editedAt.toLocaleString()) + '">· edited</span>' : "") +
          (isAdmin && c.id != null
            ? ' <button class="note-edit-btn" data-action="edit-comment" data-id="' + escapeHtml(String(c.id)) + '" title="Fix a typo in this note">✎</button>'
            : "") +
        "</span>" +
      "</div>" +
      '<div class="txt">' + escapeHtml(c.comment) + "</div>" +
    "</div>";
  }

  function renderDetailRow(r) {
    var isAdmin = !!STATE.adminPasscode;
    var comments = STATE.commentsByCase[r.case_number] || [];
    var commentsHtml = comments.length
      ? comments.map(function (c) { return renderWeeklyNote(c, isAdmin); }).join("")
      : '<p style="color:var(--text-muted); font-size:12px;">No weekly notes yet.</p>';

    var portal = portalUrl(r);

    return (
      '<tr class="detail-row"><td colspan="7">' +
        syncStatusLine(r) +
        '<div class="detail-meta">' +
          '<span><b>Type:</b> ' + escapeHtml(r.type) + '</span>' +
          '<span><b>Origin:</b> ' + escapeHtml(r.case_origin) + '</span>' +
          '<span><b>Owner:</b> ' + escapeHtml(r.owner) + '</span>' +
          '<span><b>Contact:</b> ' + escapeHtml(r.contact_name) + '</span>' +
          '<span><b>Account:</b> ' + escapeHtml(r.account_name) + '</span>' +
          '<span><b>Product:</b> ' + escapeHtml(r.product) + '</span>' +
          '<span><b>Opened:</b> ' + escapeHtml(r.date_opened || "—") + '</span>' +
          '<span><b>' + (isClosed(r) ? "Time to close" : "Open for") + ':</b> ' + (r.age_days != null ? escapeHtml(plural(r.age_days, "day")) : "—") + '</span>' +
          '<span><b>Added by:</b> ' + escapeHtml(r.added_by) + '</span>' +
        '</div>' +
        '<div class="detail-actions">' +
          // Primary action: get to the real case. Everything here is a
          // read-only copy of the portal, so "go look at the source" is the
          // most common thing anyone wants from a case row.
          (portal
            ? '<a class="btn small primary" href="' + escapeHtml(portal) + '" target="_blank" rel="noopener noreferrer">↗ Open in Q2 portal</a>'
            : '<a class="btn small" href="' + escapeHtml(PORTAL_CASE_LIST) + '" target="_blank" rel="noopener noreferrer"' +
              ' title="No portal record ID stored for this case yet — this opens the case list, where you can search ' + escapeHtml(r.case_number) + '. Re-syncing the case stores the direct link.">' +
              "↗ Find on Q2 portal</a>") +
          '<button class="btn small" data-action="resync" data-case="' + escapeHtml(r.case_number) + '">🔄 Refresh from portal</button>' +
          '<button class="btn small" data-action="copy-link" data-case="' + escapeHtml(r.case_number) + '">🔗 Copy link to this case</button>' +
        '</div>' +
        '<div class="detail-grid">' +
          '<div class="detail-block"><h4>Description (auto-pulled)</h4><p>' + (escapeHtml(r.description) || '<em style="color:var(--text-muted)">Not synced yet.</em>') + '</p></div>' +
          '<div class="detail-block"><h4>Your summary <span class="muted">· typed by your team</span></h4><p>' + (escapeHtml(r.exec_summary) || '<em style="color:var(--text-muted)">None provided.</em>') + '</p></div>' +
          '<div class="detail-block" style="grid-column: 1 / -1;"><h4>Portal comment thread (auto-pulled)</h4>' + renderPortalThread(r) + '</div>' +
          renderAttachments(r) +
          relatedBlock(r) +
          '<div class="detail-block" style="grid-column: 1 / -1;">' +
            '<h4>Current status note (internal)' + (isAdmin ? '<button class="btn small" data-action="save-note" data-case="' + escapeHtml(r.case_number) + '">Save</button>' : '') + '</h4>' +
            (isAdmin
              ? '<textarea class="note-input" data-case="' + escapeHtml(r.case_number) + '">' + escapeHtml(r.current_status_note) + '</textarea>'
              : '<p>' + (escapeHtml(r.current_status_note) || '<em style="color:var(--text-muted)">None yet.</em>') + '</p>') +
          '</div>' +
          '<div class="detail-block" style="grid-column: 1 / -1;">' +
            '<h4>Weekly sync-up notes' + (needsWeeklySync(r) ? ' <span class="pill needs-sync">Needs this week\'s update</span>' : '') + '</h4>' +
            '<div class="comment-list">' + commentsHtml + '</div>' +
            (isAdmin
              ? '<div class="comment-form">' +
                  '<input type="text" placeholder="Add this week\'s note…" data-case="' + escapeHtml(r.case_number) + '" class="new-comment-input">' +
                  '<button class="btn small" data-action="add-comment" data-case="' + escapeHtml(r.case_number) + '">Add</button>' +
                '</div>'
              : '<p style="color:var(--text-muted); font-size:11.5px;">🔒 Unlock editing to add a note.</p>') +
          '</div>' +
        '</div>' +
      '</td></tr>'
    );
  }

  function ageCell(r) {
    if (r.age_days == null) return '<span style="color:var(--text-muted)">—</span>';
    var label = r.age_days + "d";
    if (isClosed(r)) return '<span style="color:var(--text-muted)" title="Days from opened to closed">' + label + "</span>";
    if (isAgeing(r)) return '<span class="age-hot" title="Open longer than ' + AGEING_DAYS + ' days">' + label + "</span>";
    return '<span title="Days open">' + label + "</span>";
  }

  function linkCountBadge(caseNumber) {
    if (!STATE.relations) return "";
    var cn = String(caseNumber);
    var n = (STATE.relations.mentions[cn] || []).length +
      (STATE.relations.mentionedBy[cn] || []).length +
      (STATE.relations.entityLinks[cn] || []).reduce(function (a, l) { return a + l.others.length; }, 0);
    if (!n) return "";
    return ' <span class="pill linked" title="' + plural(n, "detected link") + ' to other cases">🔗 ' + n + "</span>";
  }

  function renderTable() {
    var filtered = sortData(applyFilters());
    var countEl = document.getElementById("resultCount");
    countEl.textContent = filtered.length + " of " + STATE.cases.length + " cases shown";
    var tbody = document.getElementById("tbody");
    var rows = [];
    filtered.forEach(function (r) {
      var isExpanded = STATE.expandedCase === String(r.case_number);
      var statusVal = r.status || "";
      rows.push(
        '<tr class="case-row' + (isExpanded ? " expanded" : "") + '" data-case="' + escapeHtml(r.case_number) + '">' +
          '<td class="num"><span class="chev">›</span>' + escapeHtml(r.case_number) + " " + syncBadge(r) + linkCountBadge(r.case_number) + '</td>' +
          '<td class="subject">' + escapeHtml(r.subject || "(awaiting sync)") + '</td>' +
          '<td><span class="pill"><span class="dot" style="background:' + (STATUS_COLOR_MAP[statusVal] || "var(--status-neutral)") + '"></span>' + escapeHtml(STATUS_LABELS[statusVal] || statusVal) + '</span>' + (isReopened(r) ? ' <span class="pill reopened" title="Was closed on ' + escapeHtml(r.date_closed) + ', now back open">↺ Reopened</span>' : '') + '</td>' +
          '<td>' + (r.priority ? '<span class="pill"><span class="dot" style="background:' + (PRIORITY_COLOR_MAP[r.priority] || "var(--text-muted)") + '"></span>' + escapeHtml(r.priority) + '</span>' : '<span style="color:var(--text-muted)">—</span>') + '</td>' +
          '<td>' + escapeHtml(r.product_category || "—") + '</td>' +
          '<td class="num">' + escapeHtml(r.date_opened || "—") + '</td>' +
          '<td class="num">' + ageCell(r) + '</td>' +
        '</tr>'
      );
      if (isExpanded) rows.push(renderDetailRow(r));
    });
    tbody.innerHTML = rows.length ? rows.join("") : '<tr><td colspan="7" class="empty">No cases match these filters.</td></tr>';

    tbody.querySelectorAll("tr.case-row").forEach(function (tr) {
      tr.addEventListener("click", function () {
        var cn = tr.getAttribute("data-case");
        STATE.expandedCase = STATE.expandedCase === cn ? null : cn;
        renderTable();
      });
    });

    tbody.querySelectorAll("[data-action='resync']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!requireAdmin()) return;
        doResync(btn.getAttribute("data-case"));
      });
    });
    tbody.querySelectorAll("[data-action='copy-link']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        copyCaseLink(btn.getAttribute("data-case"));
      });
    });
    tbody.querySelectorAll("[data-action='save-note']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!requireAdmin()) return;
        var ta = tbody.querySelector("textarea.note-input[data-case='" + btn.getAttribute("data-case") + "']");
        doSaveNote(btn.getAttribute("data-case"), ta.value);
      });
    });
    tbody.querySelectorAll("[data-action='add-comment']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!requireAdmin()) return;
        var input = tbody.querySelector(".new-comment-input[data-case='" + btn.getAttribute("data-case") + "']");
        doAddComment(btn.getAttribute("data-case"), input.value);
      });
    });
    tbody.querySelectorAll(".new-comment-input").forEach(function (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.stopPropagation();
          if (!requireAdmin()) return;
          doAddComment(input.getAttribute("data-case"), input.value);
        }
      });
    });

    // Portal thread expand/collapse
    tbody.querySelectorAll("[data-action='toggle-thread']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var cn = btn.getAttribute("data-case");
        STATE.expandedThreads[cn] = !STATE.expandedThreads[cn];
        renderTable();
      });
    });

    // Weekly note editing
    tbody.querySelectorAll("[data-action='edit-comment']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!requireAdmin()) return;
        STATE.editingComment = Number(btn.getAttribute("data-id"));
        renderTable();
        var ta = tbody.querySelector(".note-edit-input[data-id='" + btn.getAttribute("data-id") + "']");
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      });
    });
    tbody.querySelectorAll("[data-action='cancel-edit-comment']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        STATE.editingComment = null;
        renderTable();
      });
    });
    tbody.querySelectorAll("[data-action='save-comment']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-id");
        var ta = tbody.querySelector(".note-edit-input[data-id='" + id + "']");
        doEditComment(id, ta.value);
      });
    });
    tbody.querySelectorAll("[data-action='delete-comment']").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-id");
        if (!window.confirm("Delete this weekly note? This can't be undone.")) return;
        doDeleteComment(id);
      });
    });
    tbody.querySelectorAll(".note-edit-input").forEach(function (ta) {
      ta.addEventListener("keydown", function (e) {
        // Enter saves, Shift+Enter makes a new line, Escape cancels.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          doEditComment(ta.getAttribute("data-id"), ta.value);
        } else if (e.key === "Escape") {
          STATE.editingComment = null;
          renderTable();
        }
      });
    });

    tbody.querySelectorAll(".note-input, .new-comment-input, .note-edit-input").forEach(function (el) {
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    });
    // Anchors inside a row must not toggle the row open/closed.
    tbody.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function (e) { e.stopPropagation(); });
    });
    wireCaseChips(tbody);
  }

  function copyCaseLink(caseNumber) {
    var url = window.location.origin + window.location.pathname + "#case=" + caseNumber;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { toast("Link copied — paste it anywhere to open this case."); },
        function () { toast(url); }
      );
    } else {
      toast(url);
    }
  }

  // ---------- Activity view ----------
  var activitySearch = document.getElementById("activitySearch");
  var activityAuthor = document.getElementById("activityAuthor");
  var activityRange = document.getElementById("activityRange");

  function populateActivityAuthors() {
    while (activityAuthor.options.length > 1) activityAuthor.remove(1);
    var set = {};
    STATE.allComments.forEach(function (c) { if (c.author) set[c.author] = true; });
    Object.keys(set).sort().forEach(function (a) {
      var o = document.createElement("option"); o.value = a; o.textContent = a;
      activityAuthor.appendChild(o);
    });
  }

  function filteredComments() {
    var q = activitySearch.value.trim().toLowerCase();
    var author = activityAuthor.value;
    var days = activityRange.value ? Number(activityRange.value) : null;
    var cutoff = days ? new Date(Date.now() - days * 86400000) : null;
    return STATE.allComments.filter(function (c) {
      if (author && c.author !== author) return false;
      if (cutoff && !(c._at && c._at >= cutoff)) return false;
      if (q) {
        var r = STATE.byNumber[String(c.case_number)];
        var hay = [c.comment, c.author, c.case_number, r && r.subject].filter(Boolean).join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // Groups the feed by ISO week so a Wednesday sync-up reads as one block —
  // that's the cadence the notes are actually written on.
  function weekKey(d) {
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); // back to Monday
    return t;
  }

  function renderActivity() {
    var all = STATE.allComments;
    var shown = filteredComments();

    document.getElementById("activitySummary").textContent =
      all.length
        ? plural(all.length, "note") + " across " + plural(Object.keys(STATE.commentsByCase).length, "case") +
          " · showing " + shown.length
        : "No sync-up notes have been logged yet.";

    // Digest: who's writing, how recently, and which cases get the most
    // discussion — the questions you actually ask walking into the meeting.
    var byAuthor = {};
    var byCase = {};
    var latest = null;
    all.forEach(function (c) {
      byAuthor[c.author || "unknown"] = (byAuthor[c.author || "unknown"] || 0) + 1;
      byCase[c.case_number] = (byCase[c.case_number] || 0) + 1;
      if (c._at && (!latest || c._at > latest)) latest = c._at;
    });
    var thisWeek = all.filter(function (c) { return c._at && c._at >= mostRecentWednesday(new Date()); }).length;
    var topAuthor = Object.keys(byAuthor).sort(function (a, b) { return byAuthor[b] - byAuthor[a]; })[0];
    var topCase = Object.keys(byCase).sort(function (a, b) { return byCase[b] - byCase[a]; })[0];

    document.getElementById("activityDigest").innerHTML = [
      { label: "Notes logged", value: all.length, sub: plural(Object.keys(byCase).length, "case") + " discussed" },
      { label: "Since last Wednesday", value: thisWeek, sub: latest ? "latest " + relativeTime(latest) : "—" },
      // Name-first for these two: "Sameer · 5 notes" reads properly, where a
      // bare "5" under "Most active author" does not.
      { label: "Most active author", value: topAuthor || "—", sub: topAuthor ? plural(byAuthor[topAuthor], "note") : "—" },
      { label: "Most discussed case", value: topCase || "—", sub: topCase ? plural(byCase[topCase], "note") : "—" },
    ].map(function (t) {
      return '<div class="tile"><p class="label">' + escapeHtml(t.label) + '</p><p class="value">' + escapeHtml(String(t.value)) + '</p><p class="sub">' + escapeHtml(t.sub) + '</p></div>';
    }).join("");

    var feed = document.getElementById("activityFeed");
    if (!shown.length) {
      feed.innerHTML = '<p class="empty-panel">' + (all.length ? "No notes match these filters." : "No notes yet — add one from any case's detail panel.") + "</p>";
      return;
    }

    var groups = [];
    var currentKey = null;
    shown.forEach(function (c) {
      var k = c._at ? weekKey(c._at).getTime() : 0;
      if (k !== currentKey) { groups.push({ key: k, at: c._at, items: [] }); currentKey = k; }
      groups[groups.length - 1].items.push(c);
    });

    feed.innerHTML = groups.map(function (g) {
      var heading = g.at
        ? "Week of " + weekKey(g.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
        : "Undated";
      return '<div class="feed-group">' +
        '<div class="feed-week"><span>' + escapeHtml(heading) + '</span><span class="muted">' + plural(g.items.length, "note") + '</span></div>' +
        g.items.map(function (c) {
          var r = STATE.byNumber[String(c.case_number)] || {};
          var statusVal = r.status || "";
          return '<div class="feed-item">' +
            '<div class="feed-meta">' +
              '<button class="case-chip tight" data-open-case="' + escapeHtml(c.case_number) + '">' +
                '<span class="dot" style="background:' + (STATUS_COLOR_MAP[statusVal] || "var(--status-neutral)") + '"></span>' +
                '<b>' + escapeHtml(c.case_number) + '</b>' +
              '</button>' +
              '<span class="feed-subject">' + escapeHtml(r.subject || "(awaiting sync)") + '</span>' +
              '<span class="feed-when">' + escapeHtml(c.author || "unknown") + ' · ' + escapeHtml(c._at ? c._at.toLocaleString() : c.timestamp) + '</span>' +
            '</div>' +
            '<div class="feed-text">' + escapeHtml(c.comment) + '</div>' +
          '</div>';
        }).join("") +
        '</div>';
    }).join("");
    wireCaseChips(feed);
  }

  [activitySearch].forEach(function (el) { el.addEventListener("input", renderActivity); });
  [activityAuthor, activityRange].forEach(function (el) { el.addEventListener("change", renderActivity); });
  document.getElementById("activityReset").addEventListener("click", function () {
    activitySearch.value = ""; activityAuthor.value = ""; activityRange.value = "";
    renderActivity();
  });

  // ---------- Related cases view ----------
  var relatedSearch = document.getElementById("relatedSearch");
  var relatedLinkType = document.getElementById("relatedLinkType");

  function renderRelated() {
    var rel = STATE.relations;
    var statsEl = document.getElementById("relatedStats");
    var clustersEl = document.getElementById("relatedClusters");
    var untrackedEl = document.getElementById("relatedUntracked");
    if (!rel) { clustersEl.innerHTML = ""; return; }

    var kind = relatedLinkType.value;
    var edges = rel.edges.filter(function (e) {
      if (kind === "mention") return !!e.kinds.mention;
      if (kind === "entity") return !!e.kinds.entity;
      return true;
    });
    var clusters = buildClusters(edges);

    var mentionEdges = rel.edges.filter(function (e) { return e.kinds.mention; }).length;
    var entityEdges = rel.edges.filter(function (e) { return e.kinds.entity; }).length;
    var linkedCases = {};
    edges.forEach(function (e) { linkedCases[e.a] = true; linkedCases[e.b] = true; });
    var biggest = clusters[0];

    statsEl.innerHTML = [
      { label: "Linked cases", value: Object.keys(linkedCases).length, sub: "of " + STATE.cases.length + " tracked" },
      { label: "Case-number mentions", value: mentionEdges, sub: "one case citing another" },
      { label: "Shared loan / transaction", value: entityEdges, sub: plural(rel.sharedEntities.length, "shared record") },
      { label: "Clusters", value: clusters.length, sub: biggest ? "largest has " + plural(biggest.members.length, "case") : "—" },
    ].map(function (t) {
      return '<div class="tile"><p class="label">' + escapeHtml(t.label) + '</p><p class="value">' + escapeHtml(String(t.value)) + '</p><p class="sub">' + escapeHtml(t.sub) + '</p></div>';
    }).join("");

    var q = relatedSearch.value.trim().toLowerCase();
    var visible = clusters.filter(function (c) {
      if (!q) return true;
      return c.members.some(function (m) {
        var r = STATE.byNumber[m] || {};
        return m.toLowerCase().indexOf(q) !== -1 || (r.subject || "").toLowerCase().indexOf(q) !== -1;
      });
    });

    if (!visible.length) {
      clustersEl.innerHTML = '<p class="empty-panel">' + (clusters.length ? "No cluster matches that search." : "No links detected between the tracked cases.") + "</p>";
    } else {
      clustersEl.innerHTML = visible.map(function (c, idx) {
        // Ordered by how connected each case is, so the hub of the cluster —
        // usually the root-cause case everything else points at — reads first.
        var degree = {};
        c.edges.forEach(function (e) { degree[e.a] = (degree[e.a] || 0) + 1; degree[e.b] = (degree[e.b] || 0) + 1; });
        var members = c.members.slice().sort(function (a, b) { return (degree[b] || 0) - (degree[a] || 0); });
        var openCount = members.filter(function (m) { return STATE.byNumber[m] && !isClosed(STATE.byNumber[m]); }).length;
        // Show the written-out link list up front only when it's short, or
        // when there's no diagram to read the structure off instead.
        var showEdges = !STATE.graphMode || c.edges.length <= 6 || STATE.expandedEdges[idx];

        return '<div class="cluster-card">' +
          '<div class="cluster-head">' +
            '<h3>Cluster ' + (idx + 1) + ' <span class="muted">· ' + plural(members.length, "case") + ", " + plural(c.edges.length, "link") + "</span></h3>" +
            '<span class="pill' + (openCount ? " reopened" : "") + '">' + (openCount ? openCount + " still open" : "all closed") + "</span>" +
          "</div>" +
          (STATE.graphMode ? clusterDiagram(c, rel) : "") +
          '<div class="chip-row">' + members.map(function (m) {
            return caseChip(m, degree[m] > 1 ? degree[m] + " links" : null);
          }).join("") + "</div>" +
          // With a diagram above, a 44-row list of every link is noise by
          // default — but it's the only place the exact relationship is
          // spelled out in words, so it stays one click away.
          (showEdges
            ? ""
            : '<button class="btn small edge-toggle" data-expand-edges="' + idx + '">▸ List all ' +
                plural(c.edges.length, "link") + " in words</button>") +
          '<div class="edge-list"' + (showEdges ? "" : ' style="display:none;"') + ">" + c.edges.map(function (e) {
            var aMentionsB = (rel.mentions[e.a] || []).indexOf(e.b) !== -1;
            var bMentionsA = (rel.mentions[e.b] || []).indexOf(e.a) !== -1;
            var how = [];
            if (e.kinds.mention) {
              how.push(aMentionsB && bMentionsA ? "mention each other" : aMentionsB ? "mentions" : "is mentioned by");
            }
            if (e.kinds.entity) how.push("share " + e.entities.join(", "));
            // One-way mentions get a direction; mutual mentions and
            // shared-record links are symmetric, so they get a double arrow.
            var arrow = !e.kinds.mention || (aMentionsB && bMentionsA) ? "⇄" : aMentionsB ? "→" : "←";
            return '<div class="edge-row">' +
              '<button class="edge-case" data-open-case="' + escapeHtml(e.a) + '">' + escapeHtml(e.a) + "</button>" +
              '<span class="edge-arrow">' + arrow + "</span>" +
              '<button class="edge-case" data-open-case="' + escapeHtml(e.b) + '">' + escapeHtml(e.b) + "</button>" +
              '<span class="edge-how">' + escapeHtml(how.join(" · ")) + "</span>" +
              "</div>";
          }).join("") + "</div>" +
          "</div>";
      }).join("");
    }
    clustersEl.querySelectorAll("[data-expand-edges]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-expand-edges");
        STATE.expandedEdges[key] = !STATE.expandedEdges[key];
        renderRelated();
      });
    });
    wireCaseChips(clustersEl);

    // Case numbers our cases cite that aren't in the tracker at all — each one
    // is a candidate to add, and the reason we know about it is right there.
    var untrackedKeys = Object.keys(rel.untracked).sort();
    if (!untrackedKeys.length) {
      untrackedEl.innerHTML = "";
    } else {
      untrackedEl.innerHTML = '<div class="cluster-card subtle">' +
        "<h3>Referenced but not tracked <span class=\"muted\">· " + plural(untrackedKeys.length, "case number") + "</span></h3>" +
        '<p class="panel-sub">These case numbers are quoted inside cases you track, but aren\'t in the tracker themselves — likely worth adding.</p>' +
        '<div class="untracked-list">' + untrackedKeys.map(function (k) {
          return '<div class="untracked-row"><code>' + escapeHtml(k) + "</code><span class=\"muted\">cited by</span>" +
            '<div class="chip-row inline">' + rel.untracked[k].map(function (m) {
              return '<button class="edge-case" data-open-case="' + escapeHtml(m) + '">' + escapeHtml(m) + "</button>";
            }).join("") + "</div></div>";
        }).join("") + "</div></div>";
      wireCaseChips(untrackedEl);
    }
  }

  relatedSearch.addEventListener("input", renderRelated);
  relatedLinkType.addEventListener("change", renderRelated);
  document.getElementById("relatedReset").addEventListener("click", function () {
    relatedSearch.value = ""; relatedLinkType.value = "all";
    renderRelated();
  });
  var graphToggle = document.getElementById("graphToggle");
  graphToggle.classList.toggle("active", STATE.graphMode);
  graphToggle.addEventListener("click", function () {
    STATE.graphMode = !STATE.graphMode;
    graphToggle.classList.toggle("active", STATE.graphMode);
    renderRelated();
  });

  // ---------- Sync health view ----------
  function renderSyncHealth() {
    var cases = STATE.cases;
    var failed = cases.filter(function (r) { return r.sync_status === "error"; });
    var pending = cases.filter(function (r) { return r.sync_status === "pending"; });
    var synced = cases.filter(function (r) { return r.sync_status !== "error" && r.sync_status !== "pending"; });
    var stale = synced.filter(function (r) {
      return !r._syncedAt || daysBetween(r._syncedAt, new Date()) > STALE_SYNC_DAYS;
    });
    var lastSuccess = synced.reduce(function (max, r) {
      return r._syncedAt && (!max || r._syncedAt > max) ? r._syncedAt : max;
    }, null);

    document.getElementById("syncStats").innerHTML = [
      { label: "Synced OK", value: synced.length, sub: lastSuccess ? "most recent " + relativeTime(lastSuccess) : "—" },
      { label: "Failed", value: failed.length, sub: failed.length ? "retryable below" : "none" },
      { label: "Queued", value: pending.length, sub: pending.length ? "waiting on the scraper" : "none" },
      { label: "Stale (>" + STALE_SYNC_DAYS + "d)", value: stale.length, sub: "succeeded, but a while ago" },
    ].map(function (t) {
      return '<div class="tile"><p class="label">' + escapeHtml(t.label) + '</p><p class="value">' + escapeHtml(String(t.value)) + '</p><p class="sub">' + escapeHtml(t.sub) + '</p></div>';
    }).join("");

    document.getElementById("retryAllFailed").style.display = failed.length ? "" : "none";

    var failEl = document.getElementById("syncFailures");
    if (!failed.length) {
      failEl.innerHTML = '<p class="empty-panel">✓ Every case pulled from the portal without an error.</p>';
    } else {
      // Identical failure messages almost always share one root cause (expired
      // portal credentials, a changed login form), so they're grouped rather
      // than listed 60 times.
      var groups = {};
      failed.forEach(function (r) {
        var key = r.sync_error || "No reason recorded";
        (groups[key] = groups[key] || []).push(r);
      });
      failEl.innerHTML = Object.keys(groups)
        .sort(function (a, b) { return groups[b].length - groups[a].length; })
        .map(function (reason) {
          var rows = groups[reason];
          return '<div class="fail-card">' +
            '<div class="fail-head"><span class="fail-badge">✕ ' + plural(rows.length, "case") + "</span>" +
              '<code class="fail-reason">' + escapeHtml(reason) + "</code></div>" +
            '<div class="chip-row">' + rows.map(function (r) {
              return caseChip(r.case_number, r._syncedAt ? relativeTime(r._syncedAt) : null);
            }).join("") + "</div>" +
            '<button class="btn small" data-retry-group="' + escapeHtml(reason) + '">🔄 Retry these ' + rows.length + "</button>" +
            "</div>";
        }).join("");
      failEl.querySelectorAll("[data-retry-group]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (!requireAdmin()) return;
          retryMany(groups[btn.getAttribute("data-retry-group")].map(function (r) { return r.case_number; }));
        });
      });
      wireCaseChips(failEl);
    }

    // Full per-case ledger, worst first: failures, then queued, then the
    // longest-stale successes.
    function rank(r) {
      if (r.sync_status === "error") return 0;
      if (r.sync_status === "pending") return 1;
      return 2;
    }
    var ordered = cases.slice().sort(function (a, b) {
      var d = rank(a) - rank(b);
      if (d) return d;
      var at = a._syncedAt ? a._syncedAt.getTime() : 0;
      var bt = b._syncedAt ? b._syncedAt.getTime() : 0;
      return at - bt;
    });

    document.getElementById("syncTable").innerHTML =
      '<div class="table-card" style="margin-top:16px;"><table><thead><tr>' +
        "<th>Case #</th><th>Subject</th><th>Result</th><th>Last attempt</th><th>Reason (if failed)</th><th></th>" +
      "</tr></thead><tbody>" +
      ordered.map(function (r) {
        var result = r.sync_status === "error"
          ? '<span class="pill err"><span class="dot" style="background:var(--status-critical)"></span>Failed</span>'
          : r.sync_status === "pending"
          ? '<span class="pill"><span class="dot" style="background:var(--status-warning)"></span>Queued</span>'
          : '<span class="pill ok"><span class="dot" style="background:var(--status-good)"></span>Success</span>';
        return "<tr>" +
          '<td class="num"><button class="edge-case" data-open-case="' + escapeHtml(r.case_number) + '">' + escapeHtml(r.case_number) + "</button></td>" +
          '<td class="subject">' + escapeHtml(r.subject || "(awaiting sync)") + "</td>" +
          "<td>" + result + "</td>" +
          '<td class="num" title="' + escapeHtml(r._syncedAt ? r._syncedAt.toLocaleString() : "") + '">' + escapeHtml(r._syncedAt ? relativeTime(r._syncedAt) : "never") + "</td>" +
          '<td class="reason-cell">' + (r.sync_error ? escapeHtml(r.sync_error) : '<span style="color:var(--text-muted)">—</span>') + "</td>" +
          '<td><button class="btn small" data-action="resync-row" data-case="' + escapeHtml(r.case_number) + '">Retry</button></td>' +
          "</tr>";
      }).join("") +
      "</tbody></table></div>";

    var syncTable = document.getElementById("syncTable");
    syncTable.querySelectorAll("[data-action='resync-row']").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!requireAdmin()) return;
        doResync(btn.getAttribute("data-case"));
      });
    });
    wireCaseChips(syncTable);
  }

  document.getElementById("retryAllFailed").addEventListener("click", function () {
    if (!requireAdmin()) return;
    retryMany(STATE.cases.filter(function (r) { return r.sync_status === "error"; }).map(function (r) { return r.case_number; }));
  });

  // Re-dispatches sequentially — each one fires a GitHub Actions run, and
  // firing 60 at once would just get rate-limited.
  async function retryMany(caseNumbers) {
    if (!caseNumbers.length) return;
    toast("Re-queueing " + plural(caseNumbers.length, "case") + "…");
    var failures = 0;
    for (var i = 0; i < caseNumbers.length; i++) {
      try {
        await apiFetch(API_CASE_UPDATE, { method: "POST", auth: true, body: JSON.stringify({ case_number: caseNumbers[i] }) });
      } catch (err) {
        failures++;
      }
    }
    toast(failures ? plural(failures, "case") + " could not be re-queued." : "All re-queued — refresh in a few minutes.", !!failures);
    await loadData();
  }

  // ---------- Mutations ----------
  async function doResync(caseNumber) {
    try {
      var res = await apiFetch(API_CASE_UPDATE, { method: "POST", auth: true, body: JSON.stringify({ case_number: caseNumber }) });
      if (res.dispatch && res.dispatch.dispatched === false) {
        toast("Couldn't queue the scrape: " + res.dispatch.reason, true);
      } else {
        toast("Re-sync requested for " + caseNumber + " — refresh in a minute.");
      }
      await loadData();
    } catch (err) { toast(err.message, true); }
  }
  async function doSaveNote(caseNumber, note) {
    try {
      await apiFetch(API_CASE_UPDATE, { method: "PATCH", auth: true, body: JSON.stringify({ case_number: caseNumber, current_status_note: note }) });
      toast("Saved.");
      await loadData();
    } catch (err) { toast(err.message, true); }
  }
  async function doAddComment(caseNumber, text) {
    text = (text || "").trim();
    if (!text) return;
    try {
      await apiFetch(API_COMMENTS, { method: "POST", auth: true, body: JSON.stringify({ case_number: caseNumber, comment: text, author: STATE.adminName }) });
      toast("Note added.");
      await loadData();
    } catch (err) { toast(err.message, true); }
  }
  async function doEditComment(id, text) {
    text = (text || "").trim();
    if (!text) { toast("A note can't be empty — use Delete to remove it.", true); return; }
    if (!requireAdmin()) return;
    try {
      await apiFetch(API_COMMENTS, { method: "PATCH", auth: true, body: JSON.stringify({ id: Number(id), comment: text }) });
      STATE.editingComment = null;
      toast("Note updated.");
      await loadData();
    } catch (err) { toast(err.message, true); }
  }
  async function doDeleteComment(id) {
    if (!requireAdmin()) return;
    try {
      await apiFetch(API_COMMENTS, { method: "DELETE", auth: true, body: JSON.stringify({ id: Number(id) }) });
      STATE.editingComment = null;
      toast("Note deleted.");
      await loadData();
    } catch (err) { toast(err.message, true); }
  }

  // ---------- Sync all ----------
  async function doSyncAll() {
    if (!requireAdmin()) return;
    var open = STATE.cases.filter(function (r) { return !isClosed(r); }).length;
    if (!window.confirm(
      "Re-pull all " + STATE.cases.length + " cases from the Q2 portal?\n\n" +
      "This starts one GitHub Actions run that works through every case, closed ones " +
      "included, and usually takes several minutes. The " + open + " open cases will show " +
      "as queued until it finishes."
    )) return;
    var btn = document.getElementById("syncAllBtn");
    btn.disabled = true;
    var original = btn.innerHTML;
    btn.innerHTML = "⏳ Queueing…";
    try {
      var res = await apiFetch(API_SYNC_ALL, { method: "POST", auth: true, body: "{}" });
      toast("Full refresh queued for " + plural(res.queued, "case") + " — this takes a few minutes.");
      await loadData();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
  document.getElementById("syncAllBtn").addEventListener("click", doSyncAll);

  // ---------- CSV export ----------
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    // A leading =, +, - or @ makes Excel treat the cell as a formula. Prefix
    // with an apostrophe so portal text is always read as text.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    var rows = sortData(applyFilters());
    if (!rows.length) { toast("Nothing to export with these filters.", true); return; }
    var cols = [
      ["case_number", "Case #"], ["subject", "Subject"], ["status", "Status"], ["priority", "Priority"],
      ["product_category", "Category"], ["product", "Product"], ["type", "Type"], ["owner", "Owner"],
      ["contact_name", "Contact"], ["date_opened", "Opened"], ["date_closed", "Closed"],
      ["age_days", "Age (days)"], ["exec_summary", "Your summary"], ["current_status_note", "Status note"],
      ["sync_status", "Sync result"], ["last_synced_at", "Last synced"], ["sync_error", "Sync error"],
    ];
    var lines = [cols.map(function (c) { return csvCell(c[1]); }).concat([csvCell("Notes logged"), csvCell("Related cases")]).join(",")];
    rows.forEach(function (r) {
      var cn = String(r.case_number);
      var related = STATE.relations
        ? (STATE.relations.mentions[cn] || [])
            .concat(STATE.relations.mentionedBy[cn] || [])
            .concat((STATE.relations.entityLinks[cn] || []).reduce(function (a, l) { return a.concat(l.others); }, []))
        : [];
      var uniqRelated = related.filter(function (v, i) { return related.indexOf(v) === i; });
      lines.push(
        cols.map(function (c) { return csvCell(r[c[0]]); })
          .concat([csvCell((STATE.commentsByCase[cn] || []).length), csvCell(uniqRelated.join(" "))])
          .join(",")
      );
    });
    // ﻿ so Excel opens it as UTF-8 rather than mangling the £ signs.
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "symphonix-cases-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Exported " + plural(rows.length, "case") + ".");
  }
  document.getElementById("exportCsv").addEventListener("click", exportCsv);

  // ---------- Sorting header clicks (Cases view) ----------
  document.querySelectorAll("#view-cases thead th").forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-key");
      if (!key) return;
      if (STATE.sort.key === key) STATE.sort.dir = STATE.sort.dir === "asc" ? "desc" : "asc";
      else STATE.sort = { key: key, dir: "asc" };
      document.querySelectorAll("#view-cases thead th .arrow").forEach(function (a) { a.textContent = ""; });
      th.querySelector(".arrow").textContent = STATE.sort.dir === "asc" ? "▲" : "▼";
      renderTable();
    });
  });

  // Search box: "input" only. Deliberately NOT "change" — a text input's
  // change event fires on blur if the value differs from when it gained
  // focus, which means clicking from the search box into any other field
  // (e.g. a comment box in an expanded row) would re-render the table out
  // from under that click and steal focus right back. The dropdowns don't
  // have that failure mode, so "change" is fine there.
  searchInput.addEventListener("input", renderTable);
  [statusFilter, priorityFilter, categoryFilter].forEach(function (el) {
    el.addEventListener("change", renderTable);
  });

  function wireToggle(id, stateKey) {
    var el = document.getElementById(id);
    el.addEventListener("click", function () {
      STATE[stateKey] = !STATE[stateKey];
      el.classList.toggle("active", STATE[stateKey]);
      renderTable();
    });
  }
  wireToggle("syncFilterToggle", "syncFilterOnly");
  wireToggle("agedFilterToggle", "agedFilterOnly");
  wireToggle("linkedFilterToggle", "linkedFilterOnly");

  function clearFilters() {
    searchInput.value = ""; statusFilter.value = ""; priorityFilter.value = ""; categoryFilter.value = "";
    STATE.syncFilterOnly = false;
    STATE.agedFilterOnly = false;
    STATE.linkedFilterOnly = false;
    ["syncFilterToggle", "agedFilterToggle", "linkedFilterToggle"].forEach(function (id) {
      document.getElementById(id).classList.remove("active");
    });
  }
  document.getElementById("resetFilters").addEventListener("click", function () {
    clearFilters();
    renderTable();
  });
  document.getElementById("refreshHint").addEventListener("click", loadData);

  // ---------- Deep links ----------
  function applyHash() {
    var m = (window.location.hash || "").match(/^#case=(\w+)/);
    if (m && STATE.byNumber[m[1]]) { openCase(m[1], false); return true; }
    var v = (window.location.hash || "").match(/^#view=(\w+)/);
    if (v) { setView(v[1]); return true; }
    return false;
  }
  window.addEventListener("hashchange", applyHash);

  // ---------- Data load ----------
  async function loadData() {
    try {
      var results = await Promise.all([apiFetch(API_CASES), apiFetch(API_COMMENTS)]);
      STATE.cases = enrichCases(results[0].cases || []);
      STATE.byNumber = {};
      STATE.cases.forEach(function (r) { STATE.byNumber[String(r.case_number)] = r; });

      STATE.allComments = (results[1].comments || []).map(function (c) {
        var at = new Date(c.timestamp);
        c._at = isNaN(at.getTime()) ? null : at;
        return c;
      }).sort(function (a, b) { return (b._at || 0) - (a._at || 0); });

      STATE.commentsByCase = {};
      STATE.allComments.forEach(function (c) {
        (STATE.commentsByCase[c.case_number] = STATE.commentsByCase[c.case_number] || []).push(c);
      });

      STATE.relations = buildRelations(STATE.cases);

      document.getElementById("metaLine").textContent =
        plural(STATE.cases.length, "case") + " tracked · " + plural(STATE.allComments.length, "sync-up note") + " · Source: customerportal.q2.com";

      document.getElementById("tabCountActivity").textContent = STATE.allComments.length || "";
      document.getElementById("tabCountRelated").textContent = STATE.relations.edges.length || "";
      var failedCount = STATE.cases.filter(function (r) { return r.sync_status === "error"; }).length;
      var syncTab = document.getElementById("tabCountSync");
      syncTab.textContent = failedCount || "";
      syncTab.classList.toggle("bad", !!failedCount);

      populateFilterOptions();
      populateActivityAuthors();
      renderSyncBanner(STATE.cases);
      renderTiles(STATE.cases);
      renderCharts(STATE.cases);
      renderCurrentView();
    } catch (err) {
      document.getElementById("metaLine").textContent = "Failed to load: " + err.message;
      toast("Could not load case data: " + err.message, true);
    }
  }

  loadData().then(applyHash);
})();
