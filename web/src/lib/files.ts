// The files a reply touched.
//
// An agent names files constantly — in the arguments of the tools it runs, and
// in the prose explaining what it did. Collecting them into one list at the end
// of the turn saves re-reading the answer to find out what it actually changed.
//
// Two sources, in order of trust:
//
//   1. TOOL ARGUMENTS. `Read`, `Write`, `Edit` and friends carry a real path in
//      a known field. These are certain.
//   2. PROSE. Anything that looks like a path with a file extension. These are
//      guesses, and are treated as such: every candidate is passed to the
//      backend's `resolve_paths`, which answers with an absolute path only for
//      the ones that EXIST. A word that merely looks like a filename never
//      makes it into the list.
//
// Both sources collect everything, source files included. WHICH of them to show
// is the panel's business, not this file's — see components/SessionFiles. What
// does live here is the vocabulary that panel filters and labels with: a file's
// type, the types present in a list, and how a modified time is written short
// enough to fit beside a name.
import type { Block, Message } from "./chat";

/** Tool argument fields that hold a path. */
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file"];

/** A path-ish run of characters ending in a file extension: `src/lib/a.ts`,
 *  `/tmp/shot.png`, `./x.rs`, `~/notes.md`. */
const PROSE_PATH = /(?:^|[\s`'"(\[])((?:~|\.{1,2})?[\w./@+-]*\/[\w.@+-]+\.\w{1,8})(?=[\s`'").,;:\]]|$)/g;

/** A BARE filename with no directory: `octiq-flow-32.png`.
 *
 *  These are how an answer usually names files — `ls` prints basenames and the
 *  directory lives in the command above it — so ignoring them misses most of
 *  what a reply is about. On their own they resolve against nothing, which is
 *  what DIRECTORY_HINT below is for. */
const BARE_FILE = /(?:^|[\s`'"(\[])([\w][\w.@+-]*\.\w{1,8})(?=[\s`'").,;:\]]|$)/g;

/** A directory mentioned anywhere in the turn — the `ls` argument, a path in
 *  the prose. Bare filenames are tried inside each of these. */
const DIRECTORY_HINT = /(?:^|[\s`'"(\[])((?:~|\.{1,2})?(?:\/[\w.@+-]+){2,})(?=[\s`'").,;:\]]|$)/g;

/** Ceiling on directory × filename guesses, so a turn that mentions many of
 *  both cannot turn into a thousand-path existence check. */
const MAX_GUESSES = 240;

/** How much of a tool result to scan. A `ls` or a grep can return a great deal
 *  of text and the paths worth having are at the start of it. */
const RESULT_SCAN_LIMIT = 4000;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** A file's kind, lowercased and without the dot: `main.rs` → `rs`.
 *
 *  Read off the NAME rather than the whole path, so a dot in a folder
 *  (`~/.config/octiq/notes`) is not mistaken for one. A leading dot is a
 *  dotfile, not an extension — `.gitignore` has no type, the same answer every
 *  other tool gives for it. Empty string means "no type", which is a bucket the
 *  filter offers rather than a failure. */
export function fileExt(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImage(path: string): boolean {
  return IMAGE_EXT.has(fileExt(path));
}

export function isPdf(path: string): boolean {
  return fileExt(path) === "pdf";
}

/** Every kind present in a list of paths, with how many there are of it.
 *
 *  Commonest first, because the type worth filtering to is usually the one the
 *  session is full of, and a list ordered by name puts `.css` above `.ts` for
 *  no reason anybody cares about. Ties break by name so the order is fixed. The
 *  typeless bucket sorts last whatever its count: it is a leftovers pile, not a
 *  kind of file. */
export function fileTypes(paths: string[]): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const ext = fileExt(path);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => {
      if ((a.ext === "") !== (b.ext === "")) return a.ext === "" ? 1 : -1;
      return b.count - a.count || a.ext.localeCompare(b.ext);
    });
}

/** What to call a kind in the filter. A bare `ts` reads as a word; `.ts` reads
 *  as a file type. */
export function typeLabel(ext: string): string {
  return ext === "" ? "no extension" : `.${ext}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** When a file was last written, short enough for a column 340px wide.
 *
 *  Today it is a clock time, because within a working day the hour is the thing
 *  that separates "the file we just changed" from "the file we opened this
 *  morning". Any other day it is a date, even when that date was forty minutes
 *  ago at 23:59 — a bare "23:59" sitting under a row that says "14:40" would be
 *  read as later today. A different year gets the year, since "31 Dec" alone is
 *  a date two Decembers share.
 *
 *  `now` is a parameter so this is testable without freezing the clock. */
export function formatModified(ms: number | null | undefined, now: Date = new Date()): string {
  if (ms == null) return "";
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return "";

  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;

  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date} ${at.getFullYear()}`;
}

/** The whole stamp, for the row's hover text — the short form above drops the
 *  year, the date or the clock time, and hovering is how you get them back. */
export function modifiedTitle(ms: number | null | undefined): string {
  if (ms == null) return "";
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return "";
  return (
    `Modified ${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}` +
    ` at ${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** Every path-looking string in a turn, in the order it was mentioned, without
 *  duplicates. Resolution and existence are the caller's next step. */
export function candidatePaths(messages: Message[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const dirs = new Set<string>();
  const bare = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const path = value.trim();
    if (!path || path.length > 400 || seen.has(path)) return;
    seen.add(path);
    out.push(path);
    // Anything with a directory part also tells us where to look for the bare
    // filenames mentioned around it.
    const at = path.lastIndexOf("/");
    if (at > 0) dirs.add(path.slice(0, at));
  };

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      collectFromBlock(block, add, dirs, bare);
    }
  }

  // Try each bare filename inside every directory the turn mentioned. Most of
  // these will not exist; resolve_paths throws those away, which is exactly the
  // job it already does for prose.
  let guesses = 0;
  for (const name of bare) {
    if (seen.has(name)) continue;
    for (const dir of dirs) {
      if (guesses >= MAX_GUESSES) break;
      guesses++;
      add(`${dir}/${name}`);
    }
    // Also as-is, which resolves against the project folder.
    add(name);
  }
  return out;
}

/** The files to actually show, out of every candidate the transcript named.
 *
 *  `resolved` is the panel's cache: candidate → the real file it turned out to
 *  be, or `null` for "no such file". A candidate missing from it has not been
 *  asked about yet and is simply left out; the next scan puts it in.
 *
 *  Newest first — the file worth opening is nearly always the one the last turn
 *  was about — and one row per real file, so a path named in thirty turns is
 *  one row at its newest mention rather than thirty.
 *
 *  `limit` is a hard cap on the answer, and it counts ROWS rather than
 *  candidates: prose throws far more words that merely look like filenames at
 *  this than there are files, and letting those eat slots would show a handful
 *  of rows and call it a full list.
 */
export function newestFiles(
  candidates: string[],
  resolved: Map<string, string | null>,
  limit: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = candidates.length - 1; i >= 0 && out.length < limit; i--) {
    const real = resolved.get(candidates[i]);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/** How two names are put in order: case ignored, and runs of digits counted
 *  rather than compared character by character, so `card-2` comes before
 *  `card-10`. The same order the file tree arrives in — `fsbrowse.rs` sorts its
 *  rows the same way, and one list that disagrees with the other about where a
 *  name belongs is a list you have to re-read. */
const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** A list of paths in the order a person looks for a NAME in: A to Z by the
 *  file's own name, whatever folder it sits in.
 *
 *  It orders a list that recency CHOSE — `newestFiles` still decides which
 *  files the panel holds, so a long session keeps showing what it is currently
 *  about. This only decides how those rows are drawn, and a name is what the
 *  eye scans a column for; "which of these is newest" is what the modified time
 *  beside each row answers.
 *
 *  Two files can share a name and not be the same file (`mod.rs`, `index.ts`),
 *  so the whole path breaks the tie — and a plain comparison breaks THAT one,
 *  because the collator above calls `A.ts` and `a.ts` equal and a sort left to
 *  decide for itself could hand back either order. Returns a new array; the
 *  caller's list is left alone.
 */
export function byName(paths: string[]): string[] {
  return [...paths].sort(
    (a, b) =>
      NAME_ORDER.compare(baseName(a), baseName(b)) ||
      NAME_ORDER.compare(a, b) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
}

function collectFromBlock(
  block: Block,
  add: (v: unknown) => void,
  dirs: Set<string>,
  bare: Set<string>,
): void {
  if (block.kind === "tool") {
    const args = block.args as Record<string, unknown> | undefined;
    if (args && typeof args === "object") {
      for (const key of PATH_KEYS) add(args[key]);
      // A shell command is prose as far as paths go, and its directory
      // arguments are where its output's filenames live.
      if (typeof args.command === "string") fromText(args.command, add, dirs, bare);
    }
    // The RESULT is where a listing actually names things.
    if (block.result) fromText(block.result.slice(0, RESULT_SCAN_LIMIT), add, dirs, bare);
    return;
  }
  if (block.kind === "text") fromText(block.text, add, dirs, bare);
  // Thinking is the agent talking to itself: the files it settled on show up in
  // the tools it ran or the answer it gave.
}

function fromText(text: string, add: (v: unknown) => void, dirs: Set<string>, bare: Set<string>): void {
  for (const match of text.matchAll(PROSE_PATH)) add(match[1]);
  for (const match of text.matchAll(DIRECTORY_HINT)) {
    const hit = match[1];
    // A directory, not a file: no extension on the last segment.
    if (!/\.\w{1,8}$/.test(hit)) dirs.add(hit);
  }
  for (const match of text.matchAll(BARE_FILE)) bare.add(match[1]);
}
