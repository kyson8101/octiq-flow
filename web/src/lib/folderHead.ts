// Where a run of file cards is, said once above them instead of on every card.
//
// A turn that touches six files in one folder used to print the folder six
// times — once in each card's detail, always ellipsised from the left, so what
// you actually read six times was the tail end of the same path. The location
// is one fact about the whole run, and the moment it is worth telling a reader
// is the moment it CHANGES.
//
// So: a header names the folder, the cards under it name only their files, and
// a run that moves somewhere else gets a new header. Nothing here decides how
// any of that is drawn — see `FolderHead` in components/MessageList, and
// `folder` on components/ToolCard.
import type { Row, Tool } from "./toolGroups";

/** The file a call names, or "" when it does not name one.
 *
 *  Deliberately narrower than `toolDetail`, which is what the card's own detail
 *  line uses: that one falls back through `pattern`, `command`, `query` and
 *  `url` to find SOMETHING to show, and a folder header built out of
 *  `rg -n foo` or `https://…` is nonsense. Only the keys that are a path.
 *
 *  `details.filePath` first, for the same reason `fileDiff` prefers it: it is
 *  what the call actually resolved to, where the argument is only what it was
 *  asked for. */
export function filePath(tool: Tool): string {
  const a = tool.args as Record<string, unknown> | undefined;
  const d = tool.details as Record<string, unknown> | undefined;
  for (const v of [d?.filePath, a?.file_path, a?.path, a?.notebook_path]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Everything before the last separator, or "" when there is nothing before it.
 *
 *  Both separators, always: a path in a transcript came from whatever machine
 *  the agent was running on, which is not necessarily this one.
 *
 *  `cut <= 0` rather than `< 0` on purpose — "/etc/hosts" cuts at 0 and would
 *  leave the empty string as a folder name, and a file at the filesystem root
 *  has no folder worth announcing anyway. */
export function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** Everything after the last separator. A path with none is already a name. */
export function baseOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The folder one row is in, or "" when it is in none — because it named no
 *  file, because it is not a tool at all, or because it is a folded run whose
 *  calls do not agree on one.
 *
 *  A run has to agree UNANIMOUSLY. A header over a group is a claim about every
 *  call inside it, and a group that read two files here and one somewhere else
 *  has no honest single answer; saying the majority's folder would file the
 *  odd one out under a place it was never in. */
export function rowFolder(row: Row): string {
  if (row.kind === "block") {
    return row.block.kind === "tool" ? dirOf(filePath(row.block)) : "";
  }
  const dirs = [...row.tools, row.newest].map((t) => dirOf(filePath(t)));
  if (!dirs.length || dirs.some((d) => !d)) return "";
  return dirs.every((d) => d === dirs[0]) ? dirs[0] : "";
}

/** The folder each row is in, in the order the rows are drawn.
 *
 *  A header goes above row `i` when `folders[i]` is set and differs from
 *  `folders[i - 1]`, which is one comparison the caller makes for itself — the
 *  same array then tells each CARD which folder is already named above it, so
 *  it can show its file's name alone.
 *
 *  A row that names no file gets "", and that "" breaks the run rather than
 *  being stepped over. It has to: the header groups the cards DIRECTLY beneath
 *  it, and a paragraph of prose between two edits in the same folder ends what
 *  the header sits above. Carried across, it would be claiming files that are
 *  no longer under it. */
export function rowFolders(rows: Row[]): string[] {
  return rows.map(rowFolder);
}

/** What the header CALLS a folder: the end of the path, not the whole of it.
 *
 *  A transcript's paths are usually absolute, and a header reading
 *  `/Users/someone/projects/thing/web/src/lib` is a line of chrome wider than
 *  anything it sits above. The whole path stays on the element's `title` for
 *  the reader who wants it.
 *
 *  TWO segments, not one, and the reason is what the last one usually is. Real
 *  folders are called `src`, `lib`, `components`, `tests` — a header saying
 *  `src` over one run and `src` over another is not telling the reader the
 *  location changed, it is telling them it did not, which is the opposite of
 *  the truth. `src-tauri/src` and `web/src` are distinct at a glance and still
 *  short enough to read as a label. */
export function folderLabel(dir: string): string {
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join("/") || dir;
}
