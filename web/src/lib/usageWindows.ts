// What the host's `usage_summary` says, read for the two places that draw it:
// the phone's one number (the fullest window) and the desktop's row (every
// window). Pure: the polling is `lib/usageFeed`, the drawing `components/Usage`.

export type UsageWindow = { percent: number; resetsAt?: number | null };
export type UsageProvider = {
  available: boolean;
  fiveHour?: UsageWindow | null;
  weekly?: UsageWindow | null;
  models?: { name: string; percent: number; resetsAt?: number | null }[];
  plan?: string;
  note?: string;
};
export type UsageProviderId = "claude" | "codex";
export type UsageData = Record<UsageProviderId, UsageProvider | null>;
export type UsageStale = Record<UsageProviderId, boolean>;

/** Percent used at which the meter stops being calm, and at which it is hot. */
export const WARN_AT = 60;
export const DANGER_AT = 85;

export const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" } as const;

export function severity(percent: number): "" | "is-warn" | "is-danger" {
  if (percent >= DANGER_AT) return "is-danger";
  if (percent >= WARN_AT) return "is-warn";
  return "";
}

const clamp = (percent: number) => Math.min(100, Math.max(0, percent));

/** "resets in 2h 40m" — the useful half of a reset time. Past its moment it
 *  reads as "resetting", since the next poll will say so properly. */
export function resetIn(resetsAt?: number | null, now = Date.now()): string {
  if (!resetsAt) return "";
  const seconds = resetsAt - now / 1000;
  if (seconds <= 0) return "resetting";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

/** One agent's fullest reported usage window.
 *
 *  A provider can report five-hour, weekly, and model-specific windows. Only
 *  one number fits at a glance, so show whichever percentage is highest and
 *  label its window. This is especially important for Claude, whose five-hour
 *  limit can be closer to exhausted than its weekly limit.
 *
 *  A number, not a bar. A bar has to be wide enough to read, and the colour
 *  carries "how bad is it" on its own. */
export function barWindow(p: UsageProvider | null): { label: string; window: UsageWindow } | null {
  const windows: { label: string; window: UsageWindow }[] = [];
  if (p?.fiveHour) windows.push({ label: "5h", window: p.fiveHour });
  if (p?.weekly) windows.push({ label: "7d", window: p.weekly });
  for (const m of p?.models ?? []) windows.push({ label: m.name, window: m });
  if (windows.length === 0) return null;
  return windows.reduce((highest, candidate) =>
    candidate.window.percent > highest.window.percent ? candidate : highest,
  );
}

/** The fullest window across both agents: the one number a phone shows. */
export function usageSummary(data: UsageData): { provider: UsageProviderId; label: string; percent: number } | null {
  let best: { provider: UsageProviderId; label: string; percent: number } | null = null;
  for (const provider of ["claude", "codex"] as const) {
    const shown = barWindow(data[provider]);
    if (!shown) continue;
    const percent = clamp(shown.window.percent);
    if (!best || percent > best.percent) best = { provider, label: shown.label, percent };
  }
  return best;
}

/** What the entry says to a screen reader: every agent's fullest window, not
 *  only the one number drawn. */
export function usageLabel(data: UsageData): string {
  const parts = (["claude", "codex"] as const).flatMap((provider) => {
    const shown = barWindow(data[provider]);
    return shown ? [`${PROVIDER_NAMES[provider]} ${shown.label} ${Math.round(clamp(shown.window.percent))}%`] : [];
  });
  return parts.length ? `Plan usage: ${parts.join(", ")}` : "Plan usage: no reading yet";
}

/** One cell of the desktop row: a window the host reports, or an agent it
 *  has no reading for. */
export type UsageCell = {
  key: string;
  provider: UsageProviderId;
  /** `Claude 5h`, `Opus week`: short enough to sit beside a bar. */
  label: string;
  /** The same window in words, for the tooltip and a screen reader. */
  name: string;
  /** Percent used, 0 to 100, or null where there is no reading to draw. */
  percent: number | null;
  resetsAt?: number | null;
  /** The last good reading, shown because the newest ask failed. */
  stale: boolean;
  /** The host's own sentence about this agent. */
  note?: string;
};

const NO_READING = "No reading yet.";

/** A model's name as a label: the host's word with a capital. */
function modelLabel(name: string): string {
  const word = name.trim();
  return word ? word[0].toUpperCase() + word.slice(1) : "Model";
}

/** Every window the host reports, in the row's order: each agent's five-hour
 *  window, its week, then its week per model. An agent with nothing to draw
 *  is one cell with no number and the host's note. Antigravity has no limits
 *  and is never a cell. */
export function usageCells(data: UsageData, stale: UsageStale): UsageCell[] {
  const cells: UsageCell[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const agent = PROVIDER_NAMES[provider];
    const p = data[provider];
    const base = { provider, stale: stale[provider], note: p?.note || undefined };
    const before = cells.length;
    if (p?.fiveHour) {
      cells.push({ ...base, key: `${provider}:5h`, label: `${agent} 5h`, name: `${agent} 5-hour window`,
        percent: clamp(p.fiveHour.percent), resetsAt: p.fiveHour.resetsAt });
    }
    if (p?.weekly) {
      cells.push({ ...base, key: `${provider}:week`, label: `${agent} week`, name: `${agent} weekly window`,
        percent: clamp(p.weekly.percent), resetsAt: p.weekly.resetsAt });
    }
    for (const model of p?.models ?? []) {
      const word = modelLabel(model.name);
      cells.push({ ...base, key: `${provider}:week:${model.name}`, label: `${word} week`,
        name: `${agent} weekly window for ${word}`, percent: clamp(model.percent), resetsAt: model.resetsAt });
    }
    if (cells.length === before) {
      cells.push({ provider, key: provider, label: agent, name: agent, percent: null, stale: false,
        note: p?.note || (p ? "Plan usage is not available." : NO_READING) });
    }
  }
  return cells;
}

/** A percent as the row and the popup write it. */
export function percentText(percent: number): string {
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** The whole of one cell in a line: its tooltip, and what it is called. */
export function cellTitle(cell: UsageCell, now = Date.now()): string {
  if (cell.percent === null) return `${cell.name}: ${cell.note ?? NO_READING}`;
  return [
    `${cell.name}: ${percentText(cell.percent)} used`,
    resetIn(cell.resetsAt, now),
    cell.stale ? "last known" : "",
    cell.note ?? "",
  ].filter(Boolean).join(" · ");
}

/** The row as one sentence, for the control that opens the full breakdown. */
export function usageRowLabel(cells: readonly UsageCell[], now = Date.now()): string {
  return cells.length ? `Plan usage. ${cells.map((cell) => cellTitle(cell, now)).join(". ")}` : "Plan usage: no reading yet";
}
