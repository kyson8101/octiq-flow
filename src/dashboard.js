// Dashboard mode frontend (cards 10 + 11). A read-only grid of widget blocks.
//
// Card 10 — git status block: one block per project folder showing its base
// name, branch, changed-file count, and ahead/behind of upstream.
//
// Card 11 adds two more block kinds:
//   * Active terminals — a single block that counts every live PTY app-wide and
//     groups the counts by owner (a project, the Chat area, or Utilities). PTY
//     ids are namespaced "<prefix>:<seq>" by terminals.js: the prefix is the
//     workspace id for project terminals, or the literal "chat" / "util". A
//     project row jumps to that project on click.
//   * Docs — one block per workspace that set a docs root, listing the file
//     names found directly under that folder.
//
// Where the paths come from: invoke("list_workspaces") returns every workspace
// with a `primary_path`, a `paths[]`, and a `docs_path`. The git block flattens
// the folder paths into one de-duplicated list; the docs block uses docs_path.
//
// When it refreshes: on first load, on the Refresh button, and whenever the
// Dashboard view becomes visible. modes.js toggles the `.hidden`/`.view-active`
// classes on #view-dashboard but fires no custom event, so we watch its class
// attribute with a MutationObserver and refresh when it turns visible.
const { invoke } = window.__TAURI__.core;

// Grab the mount points placed in index.html by this card.
const view = document.querySelector("#view-dashboard");
const grid = document.querySelector("#dashboard-grid");
const refreshBtn = document.querySelector("#dashboard-refresh");

// Guard against overlapping refreshes (e.g. fast clicks + a visibility change).
let loading = false;

/**
 * Collect every workspace folder path into one ordered, de-duplicated list.
 * Each workspace contributes its primary_path first, then its extra paths.
 */
function collectPaths(workspaces) {
  const seen = new Set();
  const paths = [];
  for (const ws of workspaces ?? []) {
    const candidates = [ws.primary_path, ...(ws.paths ?? [])];
    for (const raw of candidates) {
      const path = (raw ?? "").trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

// The PTY id prefix for the Chat area's terminal group (see chat.js).
const CHAT_PREFIX = "chat";
// The PTY id prefix for the Utilities run terminals (see utilities.js).
const UTIL_PREFIX = "util";

// A PTY id is "<prefix>:<seq>"; the prefix is everything before the first ":".
function prefixOf(ptyId) {
  const i = ptyId.indexOf(":");
  return i === -1 ? ptyId : ptyId.slice(0, i);
}

// The folder's base name (last path segment), used as the block title.
function baseName(path) {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

// Plain text -> safe text node. Keeps user folder names out of innerHTML.
function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

// Build one git status block element from a GitStatus record.
function gitBlock(status) {
  const block = document.createElement("div");
  block.className = "dash-block";
  if (!status.is_repo) block.classList.add("dash-block-norepo");

  const head = textEl("div", "dash-block-head");
  head.append(textEl("span", "dash-block-title", baseName(status.path)));
  head.append(textEl("span", "dash-block-kind", "git"));
  block.append(head);

  // Full path as a quiet subtitle, with the native tooltip for long paths.
  const sub = textEl("div", "dash-block-sub", status.path);
  sub.title = status.path;
  block.append(sub);

  if (!status.is_repo) {
    block.append(textEl("div", "dash-norepo", "not a git repo"));
    return block;
  }

  // Branch line.
  const branchRow = textEl("div", "dash-row");
  branchRow.append(textEl("span", "dash-row-label", "branch"));
  branchRow.append(
    textEl("span", "dash-branch", status.branch || "(detached)"),
  );
  block.append(branchRow);

  // Changed-files line: a count badge, clean state when zero.
  const changedRow = textEl("div", "dash-row");
  changedRow.append(textEl("span", "dash-row-label", "changed"));
  if (status.changed > 0) {
    const badge = textEl("span", "dash-badge dash-badge-changed", String(status.changed));
    changedRow.append(badge);
  } else {
    changedRow.append(textEl("span", "dash-clean", "clean"));
  }
  block.append(changedRow);

  // Ahead/behind line, only shown when there is something to report.
  if (status.ahead > 0 || status.behind > 0) {
    const syncRow = textEl("div", "dash-row");
    syncRow.append(textEl("span", "dash-row-label", "sync"));
    const tracking = textEl("span", "dash-tracking");
    if (status.ahead > 0) {
      tracking.append(textEl("span", "dash-ahead", `↑${status.ahead}`));
    }
    if (status.behind > 0) {
      tracking.append(textEl("span", "dash-behind", `↓${status.behind}`));
    }
    syncRow.append(tracking);
    block.append(syncRow);
  }

  return block;
}

// --- Jump to a project ------------------------------------------------------
// The dashboard does not own workspace selection (workspaces.js does), and only
// dashboard.js is editable here. So to jump we drive the existing UI: click the
// Project mode button, then click the matching workspace row in #workspace-list.
// The rows render in workspace order, so we match by the workspace's index.
function jumpToProject(workspaceId, workspaces) {
  const index = (workspaces ?? []).findIndex((w) => w.id === workspaceId);
  if (index < 0) return;

  // Switch to Project mode (modes.js wires the click handler).
  document.querySelector('.modebtn[data-mode="project"]')?.click();

  // Click the matching workspace row. renderList() builds one <li> per
  // workspace in order, so the index lines up. Do it next frame so the click
  // above has finished its mode switch first.
  requestAnimationFrame(() => {
    const rows = document.querySelectorAll("#workspace-list .ws-item");
    rows[index]?.click();
  });
}

// --- Active-terminals block -------------------------------------------------
// Build a single block that counts every live PTY, grouped by owner. Each group
// is one row: a project (named, clickable to jump), the Chat area, or Utilities.
function activeTerminalsBlock(activeIds, workspaces) {
  const block = document.createElement("div");
  block.className = "dash-block dash-block-terminals";

  const head = textEl("div", "dash-block-head");
  head.append(textEl("span", "dash-block-title", "Active terminals"));
  head.append(textEl("span", "dash-block-kind", "live"));
  block.append(head);

  // Count ids per prefix. The prefix is the workspace id, "chat", or "util".
  const counts = new Map();
  for (const id of activeIds ?? []) {
    const prefix = prefixOf(id);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  // Total across all groups, shown as the block subtitle.
  const total = (activeIds ?? []).length;
  block.append(
    textEl(
      "div",
      "dash-block-sub",
      total === 1 ? "1 terminal running" : `${total} terminals running`,
    ),
  );

  if (total === 0) {
    block.append(textEl("div", "dash-empty", "No terminals running."));
    return block;
  }

  // A quick lookup from workspace id to its name.
  const nameById = new Map((workspaces ?? []).map((w) => [w.id, w.name]));

  // Render the well-known groups first (Chat, Utilities) in a fixed order, then
  // every project group, so the list reads consistently.
  const rows = [];
  if (counts.has(CHAT_PREFIX)) {
    rows.push(termRow("Chat", counts.get(CHAT_PREFIX), null, workspaces));
  }
  if (counts.has(UTIL_PREFIX)) {
    rows.push(termRow("Utilities", counts.get(UTIL_PREFIX), null, workspaces));
  }
  for (const [prefix, n] of counts) {
    if (prefix === CHAT_PREFIX || prefix === UTIL_PREFIX) continue;
    // A project group: the prefix is a workspace id. Use its name, or fall back
    // to the raw id for a workspace that no longer exists.
    const label = nameById.get(prefix) ?? prefix;
    rows.push(termRow(label, n, prefix, workspaces));
  }
  for (const row of rows) block.append(row);

  return block;
}

// One row inside the active-terminals block: a label, a count badge, and (for a
// project) a click that jumps to it.
function termRow(label, count, workspaceId, workspaces) {
  const row = document.createElement("div");
  row.className = "dash-row dash-term-row";

  row.append(textEl("span", "dash-row-label", label));
  row.append(
    textEl("span", "dash-badge dash-badge-term", String(count)),
  );

  // Project rows are clickable; Chat / Utilities rows are not.
  if (workspaceId) {
    row.classList.add("dash-term-jump");
    row.title = "Open this project";
    row.addEventListener("click", () => jumpToProject(workspaceId, workspaces));
  }
  return row;
}

// --- Agent usage block ------------------------------------------------------
// One block listing each captured agent session's token use and estimated cost
// (from agent_usage_all). Tokens are exact; cost is an estimate and may be
// missing ("—") or partial ("+") when a session used a model we have no price
// for. Sessions are pre-sorted by the backend, biggest first.

// Compact a token count: 1_234_567 -> "1.2M", 12_345 -> "12.3K", 850 -> "850".
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// Format an estimated cost. `complete` false means the figure is a lower bound
// (some tokens came from an unpriced model), shown with a trailing "+". A null
// cost (no priced model at all) renders as a dash.
function fmtCost(usd, complete) {
  if (usd == null) return "—";
  const dollars = usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2);
  return `$${dollars}${complete ? "" : "+"}`;
}

// Sum a numeric field across all usage rows.
function sumField(usages, field) {
  return (usages ?? []).reduce((acc, u) => acc + (Number(u[field]) || 0), 0);
}

function agentUsageBlock(usages) {
  const block = document.createElement("div");
  block.className = "dash-block dash-block-usage";

  const head = textEl("div", "dash-block-head");
  head.append(textEl("span", "dash-block-title", "Agent usage"));
  head.append(textEl("span", "dash-block-kind", "tokens"));
  block.append(head);

  const rows = usages ?? [];
  if (rows.length === 0) {
    block.append(
      textEl("div", "dash-block-sub", "Token use across agent sessions"),
    );
    block.append(
      textEl("div", "dash-empty", "No agent sessions tracked yet."),
    );
    return block;
  }

  // Subtitle: total tokens + summed known cost across all sessions. The cost is
  // marked partial if any single session's cost is partial or missing.
  const totalTokens = sumField(rows, "totalTokens");
  const knownCost = rows.reduce((acc, u) => acc + (u.costUsd ?? 0), 0);
  const allComplete = rows.every((u) => u.costComplete);
  block.append(
    textEl(
      "div",
      "dash-block-sub",
      `${fmtTokens(totalTokens)} tokens · ${fmtCost(knownCost, allComplete)} est.`,
    ),
  );

  for (const u of rows) {
    const row = textEl("div", "dash-row dash-usage-row");
    // Label: the working folder's base name + the agent, or just the agent when
    // no cwd was captured.
    const label = u.cwd ? `${baseName(u.cwd)} · ${u.agent}` : u.agent || "agent";
    const labelEl = textEl("span", "dash-row-label", label);
    labelEl.title = u.models?.length ? u.models.join(", ") : label;
    row.append(labelEl);

    const val = textEl("span", "dash-usage-val");
    val.append(textEl("span", "dash-usage-tokens", `${fmtTokens(u.totalTokens)} tok`));
    val.append(
      textEl("span", "dash-usage-cost", fmtCost(u.costUsd, u.costComplete)),
    );
    row.append(val);
    block.append(row);
  }

  return block;
}

// --- Docs block -------------------------------------------------------------
// Build one block per workspace that set a docs root, listing the file names
// found directly under that folder. Returns an array of block elements.
function docsBlocks(docsWorkspaces, docsEntries) {
  // Map each docs path to its returned files (same path key the backend echoes).
  const filesByPath = new Map(
    (docsEntries ?? []).map((e) => [e.path, e.files ?? []]),
  );

  return docsWorkspaces.map(({ name, docsPath }) => {
    const block = document.createElement("div");
    block.className = "dash-block dash-block-docs";

    const head = textEl("div", "dash-block-head");
    head.append(textEl("span", "dash-block-title", name));
    head.append(textEl("span", "dash-block-kind", "docs"));
    block.append(head);

    const sub = textEl("div", "dash-block-sub", docsPath);
    sub.title = docsPath;
    block.append(sub);

    const files = filesByPath.get(docsPath) ?? [];
    if (files.length === 0) {
      block.append(textEl("div", "dash-empty", "No files in docs folder."));
      return block;
    }

    const list = document.createElement("ul");
    list.className = "dash-doc-list";
    for (const file of files) {
      const li = textEl("li", "dash-doc-item", file);
      li.title = file;
      list.append(li);
    }
    block.append(list);
    return block;
  });
}

// Replace the grid contents with a single-line message block (empty / error).
function showMessage(text) {
  grid.replaceChildren(textEl("div", "dash-message", text));
}

// Pull data once, fetch every block kind, and (re)render the whole grid.
async function refresh() {
  if (loading) return;
  loading = true;
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const workspaces = (await invoke("list_workspaces")) ?? [];
    if (workspaces.length === 0) {
      showMessage("No workspaces yet. Add a workspace to see the dashboard here.");
      return;
    }

    // Workspaces that set a docs root; we list files under each.
    const docsWorkspaces = workspaces
      .map((w) => ({ name: w.name, docsPath: (w.docs_path ?? "").trim() }))
      .filter((w) => w.docsPath);
    const docsPaths = docsWorkspaces.map((w) => w.docsPath);

    // Fetch git summaries, the live PTY list, the agent usage readout, and the
    // docs listings together.
    const paths = collectPaths(workspaces);
    const [statuses, activeIds, usages, docsEntries] = await Promise.all([
      paths.length > 0 ? invoke("git_status_summary", { paths }) : [],
      invoke("pty_list_active"),
      invoke("agent_usage_all").catch(() => []),
      docsPaths.length > 0 ? invoke("list_docs", { paths: docsPaths }) : [],
    ]);

    const blocks = [
      activeTerminalsBlock(activeIds, workspaces),
      agentUsageBlock(usages),
      ...(statuses ?? []).map(gitBlock),
      ...docsBlocks(docsWorkspaces, docsEntries),
    ];
    grid.replaceChildren(...blocks);
  } catch (err) {
    showMessage(`Could not load the dashboard: ${err}`);
  } finally {
    loading = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

// True when the dashboard view is on screen (router uses the `.hidden` class).
function isVisible() {
  return view != null && !view.classList.contains("hidden");
}

if (view && grid) {
  refreshBtn?.addEventListener("click", refresh);

  // Refresh when the router switches into Dashboard mode. modes.js only toggles
  // classes, so we observe the class attribute and act on the hidden -> shown
  // transition.
  let wasVisible = isVisible();
  new MutationObserver(() => {
    const visible = isVisible();
    if (visible && !wasVisible) refresh();
    wasVisible = visible;
  }).observe(view, { attributes: true, attributeFilter: ["class"] });

  // First load: fill it now if the dashboard is already the active mode,
  // otherwise the observer above handles the first time it is shown.
  if (isVisible()) refresh();
}
