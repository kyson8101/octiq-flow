import { diskBytes } from "./diskReport";

export type WorktreeOwner = { kind: "task" | "mission" | "chat" | "validation" | "unknown"; label: string; runId?: string; taskId?: string; chatKey?: string };
export type LifespanItem = {
  key: string; path: string; repo: string; branch: string | null; head: string; statusHash: string;
  owner: WorktreeOwner; state: "active" | "idle" | "finished" | "abandoned"; pinned: boolean; idleDays: number;
  bytes: number | null; buildBytes: number | null; dirtyFiles: number; untrackedFiles: number; unmergedCommits: number; pushed: boolean | null;
  ignoredFiles: number | null; ignoredBytes: number | null;
  stripAt: number | null; removeAt: number | null; why: string;
};
export type WorktreeArchive = { key: string; ref: string; repo: string; branch: string | null; path: string; archivedAt: number; files: number; restoredAt: number | null };
export type WorktreeSweep = { at: number; stripped: number; removed: { path: string; branch: string | null; owner: WorktreeOwner; bytes: number | null }[]; freedBytes: number; failed: { path: string; why: string }[] };
export type LifespanSettings = { enabled: boolean; buildAfterDays: number; removeAfterDays: number };
export type WorktreeLifespan = { settings: LifespanSettings; lastSweepAt: number | null; scanning: boolean; items: LifespanItem[]; archives: WorktreeArchive[]; history: WorktreeSweep[] };
export const DEFAULT_LIFESPAN_SETTINGS: LifespanSettings = { enabled: true, buildAfterDays: 3, removeAfterDays: 14 };
export const worktreeFlight = (key: string) => `worktree-lifespan:${key}`;
export type WorktreeGroup = "Needs you" | "Waiting to clear" | "Kept" | "In use";
export const WORKTREE_GROUPS: WorktreeGroup[] = ["Needs you", "Waiting to clear", "Kept", "In use"];
export function worktreeGroup(item: LifespanItem): WorktreeGroup {
  if (item.owner.kind === "unknown") return "In use";
  if (item.pinned) return "Kept";
  if (item.state === "abandoned") return "Needs you";
  if (item.state === "finished" || item.state === "idle") return "Waiting to clear";
  return "In use";
}
export function nextClearAt(item: LifespanItem): number | null {
  const dates = [item.stripAt, item.removeAt].filter((at): at is number => at !== null);
  return dates.length ? Math.min(...dates) : null;
}
export function groupWorktrees(items: LifespanItem[]) {
  return WORKTREE_GROUPS.map(label => ({ label, items: items.filter(item => worktreeGroup(item) === label).sort((a, b) =>
    (label === "Waiting to clear" ? (nextClearAt(a) ?? Infinity) - (nextClearAt(b) ?? Infinity) : 0) || a.owner.label.localeCompare(b.owner.label) || a.key.localeCompare(b.key)) })).filter(group => group.items.length);
}
export function lifespanDate(at: number): string {
  return new Date(at).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export const idleWords = (days: number) => `${days} idle ${days === 1 ? "day" : "days"}`;
export const ignoredFilesUnchecked = "The host could not check for ignored files. Archive and remove is unavailable.";
function ignoredFileStakes(item: LifespanItem): string {
  return item.ignoredFiles != null && item.ignoredFiles > 0 ? `${item.ignoredFiles} ignored ${item.ignoredFiles === 1 ? "file" : "files"}${item.ignoredBytes != null ? ` (${diskBytes(item.ignoredBytes)})` : ""}` : "";
}
export function worktreeStakes(item: LifespanItem): string {
  return [item.dirtyFiles > 0 && `${item.dirtyFiles} changed`, item.untrackedFiles > 0 && `${item.untrackedFiles} new ${item.untrackedFiles === 1 ? "file" : "files"}`,
    ignoredFileStakes(item),
    item.unmergedCommits > 0 && `${item.unmergedCommits} ${item.unmergedCommits === 1 ? "commit" : "commits"} not merged`, item.pushed === false && "Not pushed"].filter(Boolean).join(" · ");
}
export function worktreeFact(item: LifespanItem, enabled = true): string {
  if (item.owner.kind === "unknown") return "Unknown owner · OctiqFlow leaves it alone";
  if (item.pinned) return "Kept · Automatic clearing paused";
  if (item.state === "active") return "In use";
  if (item.state === "abandoned") return "Abandoned · Waiting for you";
  const state = item.state === "finished" ? "Finished" : "Idle";
  if (!enabled) return `${state} · Automatic clearing off`;
  const dates = [item.stripAt !== null && `Build output clears ${lifespanDate(item.stripAt)}`, item.removeAt !== null && `Folder clears ${lifespanDate(item.removeAt)}`].filter(Boolean);
  return [state, ...dates.length ? dates : ["No clearing scheduled"]].join(" · ");
}
/** Never call a partial sum the total. Unknown sizes stay absent. */
export function worktreeTotal(items: LifespanItem[]): number | null {
  return items.some(item => item.bytes === null) ? null : items.reduce((total, item) => total + item.bytes!, 0);
}
export function sweepWords(sweep: WorktreeSweep, last = false): string {
  return `${last ? "Last sweep" : "Sweep"} removed ${sweep.removed.length} and freed ${diskBytes(sweep.freedBytes)}${sweep.stripped > 0 ? ` · ${sweep.stripped} build ${sweep.stripped === 1 ? "output" : "outputs"} cleared` : ""}`;
}
export function validateLifespanSettings(build: string, remove: string): string | null {
  if (!/^\d+$/.test(build) || !/^\d+$/.test(remove) || !Number.isSafeInteger(Number(build)) || !Number.isSafeInteger(Number(remove)) || Number(build) < 1 || Number(remove) < 1) return "Use a whole number of at least 1 day for each window.";
  if (Number(build) > Number(remove)) return "Build output must clear no later than folders.";
  return null;
}
export function archiveQuestion(item: LifespanItem) {
  const ignored = ignoredFileStakes(item);
  const warning = item.ignoredFiles == null ? ignoredFilesUnchecked : ignored ? `${ignored} will be deleted and ${item.ignoredFiles === 1 ? "is" : "are"} not in the archive.` : "";
  return { title: `Archive and remove ${item.owner.label}?`, body: `${warning ? `${warning}\n` : ""}${item.path}\n${worktreeStakes(item) || "No changed files or unmerged commits reported."}\nThe archive keeps tracked changes and new files before removing this worktree.${!warning ? " Ignored files are not kept." : ""}`, confirmLabel: "Archive and remove", cancelLabel: "Keep worktree", decision: true };
}
export const lifespanUnavailable = (message: string) => /'worktree_lifespan_\w+' is not available on this backend/.test(message);
