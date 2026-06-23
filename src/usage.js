// Global usage footer: the 5-hour rolling window and the weekly window for both
// Claude Code and Codex, read from the `usage_summary` backend command.
//
// The backend (usage_limits.rs) does the real work: Claude usage comes from the
// live `/api/oauth/usage` endpoint (keychain token), Codex usage from the most
// recent session rollout file on disk. Both come back already normalised to
// `{ available, fiveHour:{percent,resetsAt}, weekly:{percent,resetsAt}, plan }`,
// with `resetsAt` in unix SECONDS. This module only renders + refreshes.
//
// Refresh cadence: every 60s, plus when the window regains focus, plus on a click
// of the bar (manual refresh). It is best-effort — an unavailable provider shows
// a dash with the reason in its tooltip, never an error.
const { invoke } = window.__TAURI__.core;

const REFRESH_MS = 60_000;
// Event-driven refreshes (focus, tab-visible) get coalesced: a burst within
// DEBOUNCE_MS collapses to one call, and no event-driven call fires within
// MIN_INTERVAL_MS of the last refresh. This stops alt-tab spam from hammering the
// Claude usage endpoint (which 429s per account). The 60s timer and an explicit
// click bypass the guard — those are intentional, spaced calls.
const DEBOUNCE_MS = 300;
const MIN_INTERVAL_MS = 15_000;
// Severity thresholds (percent used). Below WARN is calm; at/above DANGER is hot.
const WARN_AT = 60;
const DANGER_AT = 85;

let bar = null;
let timer = null;
let lastRefreshAt = 0;
let debounceTimer = null;

// Map a percent to a severity class so the meter colours itself.
function severity(percent) {
  if (percent >= DANGER_AT) return "is-danger";
  if (percent >= WARN_AT) return "is-warn";
  return "is-ok";
}

// Human "resets in ..." text from a unix-second timestamp, for the tooltip. Shows
// a relative gap under a day ("resets in 2h 5m"), else the local date + time.
function resetText(resetsAt) {
  if (!resetsAt) return "";
  const ms = resetsAt * 1000;
  const diff = ms - Date.now();
  if (diff <= 0) return "resets now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `resets in ${hrs}h ${mins % 60}m`;
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `resets ${day} ${time}`;
}

// Build one window meter: a label, a fill bar, and the percent. `win` is the
// `{percent, resetsAt}` object, or null/undefined when the window is missing.
function meter(label, win) {
  const el = document.createElement("span");
  el.className = "usage-meter";

  const lab = document.createElement("span");
  lab.className = "usage-meter-label";
  lab.textContent = label;
  el.append(lab);

  if (!win || typeof win.percent !== "number") {
    const dash = document.createElement("span");
    dash.className = "usage-meter-val";
    dash.textContent = "—";
    el.append(dash);
    return el;
  }

  const percent = win.percent;
  const track = document.createElement("span");
  track.className = `usage-meter-track ${severity(percent)}`;
  const fill = document.createElement("span");
  fill.className = "usage-meter-fill";
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  track.append(fill);
  el.append(track);

  const val = document.createElement("span");
  val.className = "usage-meter-val";
  // Drop a trailing ".0" so it reads "11%" not "11.0%".
  val.textContent = `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
  el.append(val);

  const reset = resetText(win.resetsAt);
  el.title = `${label === "5h" ? "5-hour" : "weekly"} usage: ${val.textContent}${
    reset ? ` · ${reset}` : ""
  }`;
  return el;
}

// Build one provider group: name + two meters, or name + reason when unavailable.
function group(name, data) {
  const g = document.createElement("div");
  g.className = "usage-group";

  const tag = document.createElement("span");
  tag.className = "usage-agent";
  tag.textContent = name;
  if (data && data.plan) tag.title = `${name} · ${data.plan} plan`;
  g.append(tag);

  if (!data || !data.available) {
    const note = document.createElement("span");
    note.className = "usage-note";
    note.textContent = "—";
    note.title = (data && data.note) || "usage not available";
    g.append(note);
    return g;
  }

  g.append(meter("5h", data.fiveHour), meter("wk", data.weekly));
  return g;
}

// Render the whole bar from a summary `{ claude, codex }`.
function render(summary) {
  if (!bar) return;
  bar.replaceChildren();

  bar.append(group("Claude", summary && summary.claude));

  const sep = document.createElement("span");
  sep.className = "usage-sep";
  bar.append(sep);

  bar.append(group("Codex", summary && summary.codex));
}

// Pull a fresh summary and render it. Any failure renders an empty (dashed) bar
// rather than throwing — the footer must never break the app. Stamps the call
// time up front so concurrent triggers within the await window are also guarded.
async function refresh() {
  lastRefreshAt = Date.now();
  try {
    const summary = await invoke("usage_summary");
    render(summary);
  } catch {
    render(null);
  }
}

// Event-driven refresh: debounced (a focus + visibilitychange double-fire becomes
// one call) and rate-limited (skips if we refreshed under MIN_INTERVAL_MS ago).
function softRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (Date.now() - lastRefreshAt >= MIN_INTERVAL_MS) refresh();
  }, DEBOUNCE_MS);
}

function start() {
  bar = document.getElementById("usage-bar");
  if (!bar) return;

  // Click the bar to force a refresh (handy right after a heavy session).
  bar.addEventListener("click", refresh);
  bar.title = "Click to refresh usage";

  refresh();
  timer = setInterval(refresh, REFRESH_MS);

  // Re-pull when the user returns to the window — the numbers may have moved.
  // Goes through softRefresh so a focus + visibilitychange burst is one call.
  window.addEventListener("focus", softRefresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) softRefresh();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
