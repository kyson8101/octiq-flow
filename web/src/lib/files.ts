// How a file is named, typed and dated in the files column.
//
// This file used to be the SCRAPER too: it read every path-shaped word out of
// a transcript, guessed at bare filenames against every directory the turn
// mentioned, and handed the survivors to the panel. That is gone. The column no
// longer guesses which files matter — the agent says, and lib/pins reads what it
// said back out of the transcript.
//
// What is left is the vocabulary the panel labels rows with, which was never
// the part that was wrong: a file's short name, its type, the types present in
// a list, and how a modified time is written short enough to fit beside a name.

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

/** HTML is a page, not a document preview. File clicks send these to the
 *  browser instead of putting a browser-inside-a-browser beside the chat. */
export function isHtml(path: string): boolean {
  const ext = fileExt(path);
  return ext === "html" || ext === "htm";
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
