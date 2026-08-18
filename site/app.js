(function () {
  "use strict";

  // ---------- Config ----------
  var API_CASES = "/api/cases";
  var API_CASE_UPDATE = "/api/case-update";
  var API_COMMENTS = "/api/comments";
  var API_AUTH_CHECK = "/api/auth-check";

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

  // ---------- State ----------
  var STATE = {
    cases: [],
    commentsByCase: {},
    expandedCase: null,
    sort: { key: "case_number", dir: "desc" },
    adminPasscode: sessionStorage.getItem("f2f_admin_passcode") || null,
    adminName: sessionStorage.getItem("f2f_admin_name") || "",
    syncFilterOnly: false,
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
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    if (r.status === "90-Closed") return false;
    var cutoff = mostRecentWednesday(new Date());
    var latest = latestCommentAt(r.case_number);
    return !latest || latest < cutoff;
  }

  function isReopened(r) {
    return !!r.date_closed && r.status !== "90-Closed";
  }

  function renderSyncBanner(cases) {
    var open = cases.filter(function (r) { return r.status !== "90-Closed"; });
    var needing = open.filter(needsWeeklySync);
    var el = document.getElementById("syncBanner");
    var toggle = document.getElementById("syncFilterToggle");
    toggle.textContent = "🗓 Needs sync-up (" + needing.length + ")";
    if (!open.length || !needing.length) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.innerHTML =
      "📅 <b>" + needing.length + " of " + open.length + "</b> open cases still need this week's sync-up note — " +
      '<span class="link" id="syncBannerLink">show them</span>.';
    var link = document.getElementById("syncBannerLink");
    if (link) {
      link.addEventListener("click", function () {
        STATE.syncFilterOnly = true;
        renderTable();
        document.querySelector(".table-card").scrollIntoView({ behavior: "smooth" });
      });
    }
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
    adminToggle.innerHTML = STATE.adminPasscode ? ("🔓 " + (STATE.adminName || "Admin")) : "🔒 Admin";
  }
  setAdminUi();

  var unlockModal = document.getElementById("unlockModal");
  var unlockInput = document.getElementById("unlockInput");
  var unlockError = document.getElementById("unlockError");

  adminToggle.addEventListener("click", function () {
    if (STATE.adminPasscode) {
      STATE.adminPasscode = null;
      STATE.adminName = "";
      sessionStorage.removeItem("f2f_admin_passcode");
      sessionStorage.removeItem("f2f_admin_name");
      setAdminUi();
      toast("Editing locked.");
      renderTable();
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
      sessionStorage.setItem("f2f_admin_passcode", passcode);
      sessionStorage.setItem("f2f_admin_name", STATE.adminName);
      setAdminUi();
      unlockModal.style.display = "none";
      toast("Editing unlocked as " + (STATE.adminName || "Admin") + ".");
      renderTable();
    } catch (err) {
      unlockError.textContent = err.message;
      unlockError.style.display = "block";
    }
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
    var closed = cases.filter(function (r) { return r.status === "90-Closed"; }).length;
    var open = total - closed;
    var high = cases.filter(function (r) { return r.priority === "High"; }).length;
    var pending = cases.filter(function (r) { return r.sync_status === "pending"; }).length;
    var needsSync = cases.filter(needsWeeklySync).length;
    var reopened = cases.filter(isReopened).length;

    var tiles = [
      { label: "Total cases", value: total, sub: pending ? pending + " pending sync" : "all synced" },
      { label: "Closed", value: closed, sub: total ? Math.round(closed / total * 100) + "% of all cases" : "—" },
      { label: "Open / in review", value: open, sub: (reopened ? reopened + " reopened · " : "") + open + " active" },
      { label: "High priority", value: high, sub: total ? Math.round(high / total * 100) + "% of all cases" : "—" },
      { label: "Needs this week's update", value: needsSync, sub: open ? needsSync + " of " + open + " open cases" : "—" },
      { label: "Weekly comments logged", value: Object.values(STATE.commentsByCase).reduce(function (a, c) { return a + c.length; }, 0), sub: "across all cases" },
    ];
    document.getElementById("tiles").innerHTML = tiles.map(function (t) {
      return '<div class="tile"><p class="label">' + t.label + '</p><p class="value">' + t.value + '</p><p class="sub">' + t.sub + '</p></div>';
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

  // ---------- Filters ----------
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
    var s = statusFilter.value, p = priorityFilter.value, c = categoryFilter.value;
    return STATE.cases.filter(function (r) {
      if (statusFilter.value !== "" || s !== "") { if (s !== (r.status || "") && statusFilter.selectedIndex !== 0) return false; }
      if (priorityFilter.selectedIndex !== 0 && p !== (r.priority || "")) return false;
      if (categoryFilter.selectedIndex !== 0 && c !== (r.product_category || "")) return false;
      if (statusFilter.selectedIndex !== 0 && s !== (r.status || "")) return false;
      if (STATE.syncFilterOnly && !needsWeeklySync(r)) return false;
      if (q) {
        var hay = [r.subject, r.description, r.exec_summary, r.raw_comments, r.current_status_note, r.case_number, r.contact_name].join(" ").toLowerCase();
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
      av = av == null ? "" : av; bv = bv == null ? "" : bv;
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });
  }

  // ---------- Table + detail ----------
  function syncBadge(status) {
    if (status === "pending") return '<span class="pill"><span class="dot" style="background:var(--status-warning)"></span>Pending</span>';
    if (status === "error") return '<span class="pill"><span class="dot" style="background:var(--status-critical)"></span>Sync error</span>';
    return "";
  }

  function renderDetailRow(r) {
    var comments = STATE.commentsByCase[r.case_number] || [];
    var commentsHtml = comments.length
      ? comments.map(function (c) {
          return '<div class="comment-item"><div class="who"><span>' + escapeHtml(c.author) + '</span><span>' + escapeHtml(new Date(c.timestamp).toLocaleString()) + '</span></div><div class="txt">' + escapeHtml(c.comment) + '</div></div>';
        }).join("")
      : '<p style="color:var(--text-muted); font-size:12px;">No weekly notes yet.</p>';

    var isAdmin = !!STATE.adminPasscode;

    return (
      '<tr class="detail-row"><td colspan="7">' +
        '<div class="detail-meta">' +
          '<span><b>Type:</b> ' + escapeHtml(r.type) + '</span>' +
          '<span><b>Origin:</b> ' + escapeHtml(r.case_origin) + '</span>' +
          '<span><b>Owner:</b> ' + escapeHtml(r.owner) + '</span>' +
          '<span><b>Contact:</b> ' + escapeHtml(r.contact_name) + '</span>' +
          '<span><b>Account:</b> ' + escapeHtml(r.account_name) + '</span>' +
          '<span><b>Product:</b> ' + escapeHtml(r.product) + '</span>' +
          '<span><b>Added by:</b> ' + escapeHtml(r.added_by) + '</span>' +
          '<span><b>Last synced:</b> ' + (r.last_synced_at ? escapeHtml(new Date(r.last_synced_at).toLocaleString()) : "never") + '</span>' +
        '</div>' +
        '<div class="detail-actions">' +
          '<button class="btn small" data-action="resync" data-case="' + escapeHtml(r.case_number) + '">🔄 Refresh from portal</button>' +
        '</div>' +
        '<div class="detail-grid">' +
          '<div class="detail-block"><h4>Description (auto-pulled)</h4><p>' + (escapeHtml(r.description) || '<em style="color:var(--text-muted)">Not synced yet.</em>') + '</p></div>' +
          '<div class="detail-block"><h4>Your summary</h4><p>' + (escapeHtml(r.exec_summary) || '<em style="color:var(--text-muted)">None provided.</em>') + '</p></div>' +
          '<div class="detail-block" style="grid-column: 1 / -1;"><h4>Raw comment thread (auto-pulled)</h4><p>' + (escapeHtml(r.raw_comments) || '<em style="color:var(--text-muted)">Not synced yet.</em>') + '</p></div>' +
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

  function renderTable() {
    var filtered = sortData(applyFilters());
    document.getElementById("resultCount").textContent = filtered.length + " of " + STATE.cases.length + " cases shown";
    var tbody = document.getElementById("tbody");
    var rows = [];
    filtered.forEach(function (r) {
      var isExpanded = STATE.expandedCase === r.case_number;
      var statusVal = r.status || "";
      rows.push(
        '<tr class="case-row' + (isExpanded ? " expanded" : "") + '" data-case="' + escapeHtml(r.case_number) + '">' +
          '<td class="num"><span class="chev">›</span>' + escapeHtml(r.case_number) + " " + syncBadge(r.sync_status) + '</td>' +
          '<td class="subject">' + escapeHtml(r.subject || "(awaiting sync)") + '</td>' +
          '<td><span class="pill"><span class="dot" style="background:' + (STATUS_COLOR_MAP[statusVal] || "var(--status-neutral)") + '"></span>' + escapeHtml(STATUS_LABELS[statusVal] || statusVal) + '</span>' + (isReopened(r) ? ' <span class="pill reopened" title="Was closed on ' + escapeHtml(r.date_closed) + ', now back open">↺ Reopened</span>' : '') + '</td>' +
          '<td>' + (r.priority ? '<span class="pill"><span class="dot" style="background:' + (PRIORITY_COLOR_MAP[r.priority] || "var(--text-muted)") + '"></span>' + escapeHtml(r.priority) + '</span>' : '<span style="color:var(--text-muted)">—</span>') + '</td>' +
          '<td>' + escapeHtml(r.product_category || "—") + '</td>' +
          '<td class="num">' + escapeHtml(r.date_opened || "—") + '</td>' +
          '<td class="num">' + escapeHtml(r.date_closed || "—") + '</td>' +
        '</tr>'
      );
      if (isExpanded) rows.push(renderDetailRow(r));
    });
    tbody.innerHTML = rows.join("");

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
    tbody.querySelectorAll(".note-input, .new-comment-input").forEach(function (el) {
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    });
  }

  async function doResync(caseNumber) {
    try {
      await apiFetch(API_CASE_UPDATE, { method: "POST", auth: true, body: JSON.stringify({ case_number: caseNumber }) });
      toast("Re-sync requested for " + caseNumber + " — refresh in a minute.");
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

  // ---------- Sorting header clicks ----------
  document.querySelectorAll("thead th").forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-key");
      if (STATE.sort.key === key) STATE.sort.dir = STATE.sort.dir === "asc" ? "desc" : "asc";
      else STATE.sort = { key: key, dir: "asc" };
      document.querySelectorAll("thead th .arrow").forEach(function (a) { a.textContent = ""; });
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
  var syncFilterToggle = document.getElementById("syncFilterToggle");
  syncFilterToggle.addEventListener("click", function () {
    STATE.syncFilterOnly = !STATE.syncFilterOnly;
    syncFilterToggle.classList.toggle("active", STATE.syncFilterOnly);
    renderTable();
  });
  document.getElementById("resetFilters").addEventListener("click", function () {
    searchInput.value = ""; statusFilter.value = ""; priorityFilter.value = ""; categoryFilter.value = "";
    STATE.syncFilterOnly = false;
    syncFilterToggle.classList.remove("active");
    renderTable();
  });
  document.getElementById("refreshHint").addEventListener("click", loadData);

  // ---------- Data load ----------
  async function loadData() {
    try {
      var casesRes = await apiFetch(API_CASES);
      var commentsRes = await apiFetch(API_COMMENTS);
      STATE.cases = casesRes.cases || [];
      STATE.commentsByCase = {};
      (commentsRes.comments || []).forEach(function (c) {
        (STATE.commentsByCase[c.case_number] = STATE.commentsByCase[c.case_number] || []).push(c);
      });

      var oldest = STATE.cases.reduce(function (min, c) { return (!min || (c.date_opened && c.date_opened < min)) ? c.date_opened : min; }, null);
      document.getElementById("metaLine").textContent = STATE.cases.length + " cases tracked · Source: customerportal.q2.com";

      populateFilterOptions();
      renderSyncBanner(STATE.cases);
      renderTiles(STATE.cases);
      renderCharts(STATE.cases);
      renderTable();
    } catch (err) {
      document.getElementById("metaLine").textContent = "Failed to load: " + err.message;
      toast("Could not load case data: " + err.message, true);
    }
  }

  loadData();
})();
