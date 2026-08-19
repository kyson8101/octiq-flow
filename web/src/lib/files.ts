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
// Both sources collect everything, source files included. What the list SHOWS
// before it is expanded is a smaller thing — see `isShown`.
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

/** The non-image files the list is willing to show.
 *
 *  A collapsed list is a footnote to an answer, not a record of the work. A
 *  reply that edits twenty source files buries the one screenshot it made, and
 *  the source files are the least useful part of it: they are already the
 *  subject of the answer, and the tool cards above show them being written. So
 *  the footnote holds what you would OPEN to LOOK at — a picture, a PDF, a
 *  note. The rest is still there, one click into "show more".
 *
 *  Every extension here is one the app can actually display: an image or PDF in
 *  the viewer, the rest as text in the side panel. Adding one neither of them
 *  can render only buys a dead click. */
const DOC_EXT = new Set(["pdf", "md", "markdown", "mdx", "txt", "csv", "tsv"]);

function extension(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function isImage(path: string): boolean {
  return IMAGE_EXT.has(extension(path));
}

export function isPdf(path: string): boolean {
  return extension(path) === "pdf";
}

/** Notes that pass the test above but do not earn the footnote. An agent reads
 *  these at the start of almost every turn, so they would sit near the top of
 *  almost every list without once being the thing the answer was about. Matched
 *  on the name alone, so a README in any folder is caught. Like source files,
 *  they come back when the list is expanded. */
const NEVER_SHOWN = new Set(["claude.md", "readme.md", "agents.md"]);

/** Whether a path earns a line in the COLLAPSED list under a reply.
 *  Expanding shows every path, so this filters, it does not discard. */
export function isShown(path: string): boolean {
  if (NEVER_SHOWN.has(baseName(path).toLowerCase())) return false;
  const ext = extension(path);
  return IMAGE_EXT.has(ext) || DOC_EXT.has(ext);
}

export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
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
