// Highlighted text from a file, on its way into the prompt box.
//
// You are reading a file next to the chat, you see the ten lines you want to
// ask about, and the alternative to this is describing where they are. So the
// selection is turned into the thing an agent can act on straight away: the
// path, the lines it came from, and the text itself in a fence.
//
// The two halves live apart on purpose. `formatQuote` is the shape of the
// quote and nothing else, so it is testable without a browser; the pub/sub
// below is only how the file panel reaches a composer it does not own — they
// are cousins in the tree, not parent and child, and threading a callback down
// through the whole app to join them would be a wire nothing else uses.
import { baseName, fileExt } from "./files";

export type Quote = {
  /** The file the text came from, absolute. */
  path: string;
  /** The highlighted text, verbatim. */
  text: string;
  /** First and last line it covers, counting from 1. Both 0 when the view it
   *  came from cannot say — a rendered markdown page has no line numbers left
   *  in it, so a quote from one names the file and stops there. */
  from: number;
  to: number;
};

/** Which lines the characters between `start` and `end` sit on, counting from 1. */
export function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  const from = lineAt(text, start);
  // Dragging to the end of a line leaves the caret PAST its newline, which is
  // the first character of the next line. Counting that line would quote one
  // more than was highlighted, every time.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  return { from, to: Math.max(from, lineAt(text, last)) };
}

function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** The quote as it goes into the box: where it came from, then the text. */
export function formatQuote(quote: Quote, cwd?: string): string {
  const path = relativeTo(quote.path, cwd);
  const where =
    quote.from > 0
      ? quote.to > quote.from
        ? `${path}:${quote.from}-${quote.to}`
        : `${path}:${quote.from}`
      : path;
  // A fence long enough to survive whatever is inside it. Quoting a markdown
  // file that has its own code blocks is the common case, and a three-backtick
  // fence around them closes on the first one — the rest of the file's text
  // then lands in the message as prose.
  const fence = "`".repeat(Math.max(3, longestFence(quote.text) + 1));
  // A blank line after it, so what you type next is a sentence about the quote
  // rather than the line under it.
  return `${where}\n${fence}${tagFor(path)}\n${quote.text}\n${fence}\n\n`;
}

function relativeTo(path: string, cwd?: string): string {
  if (!cwd) return path;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function longestFence(text: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** The word after the fence. Most extensions ARE the tag highlighters expect,
 *  so only the ones that are not need naming; a file with no extension gets no
 *  tag rather than a guess. */
const TAG: Record<string, string> = {
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  rs: "rust",
  py: "python",
  rb: "ruby",
  kt: "kotlin",
  cs: "csharp",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  markdown: "md",
  jsonc: "json",
};

function tagFor(path: string): string {
  const ext = fileExt(path);
  if (!ext) return "";
  return TAG[ext] ?? ext;
}

/** A name for the quote, for anything that has to say what it is about. */
export const quoteLabel = (quote: Quote): string =>
  quote.from > 0 ? `${baseName(quote.path)}:${quote.from}` : baseName(quote.path);

// ---- Handing it over -----------------------------------------------------

type Listener = (quote: Quote) => void;
const listeners = new Set<Listener>();

/** Called by the composer, which is the one thing that can take a quote. */
export function onQuote(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called by whatever the text was highlighted in. Nothing listening means
 *  there is no box on screen to put it in, and the quote is simply dropped —
 *  the panel has already done the only thing it could. */
export function sendQuote(quote: Quote): void {
  for (const fn of listeners) fn(quote);
}

/** Whether there is anywhere for a quote to go. The button is not drawn when
 *  there is not, rather than being drawn and doing nothing. */
export const canQuote = (): boolean => listeners.size > 0;
