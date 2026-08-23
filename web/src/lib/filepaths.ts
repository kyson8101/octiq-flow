// The file paths inside a reply, marked so they can be clicked.
//
// An agent names files constantly, and until now every one of them was a word
// you had to go and find yourself. This marks them, and the panel beside the
// chat opens them — the same file, the same editor, one click instead of a
// hunt through the file tree.
//
// A rehype plugin, like `rehypeWordFade`, and for the same reason: markdown has
// no concept of "a path", so the only place to add one is the tree between the
// parser and React. It runs BEFORE the word fade, which would otherwise have
// cut every path into one span per word before this could see it.
//
// The hard part is not finding paths. It is not finding things that merely look
// like paths — a version number, a domain, an ordinary sentence with a full
// stop in it. Two rules keep that in check:
//
//   * the pattern below is deliberately narrow (an extension must START with a
//     letter, which is what tells `files.ts` from `1.2.3`);
//   * and a marked path is still only TEXT until the backend says the file
//     exists. Nothing here decides what becomes a link — see lib/pathStore.
//
// So a false positive costs one existence check and then stays plain words.

/** The element this plugin leaves behind, rendered by components/ProsePath. */
export const PATH_TAG = "octiq-path";

/** A path with slashes in it: `web/src/lib/files.ts`, `/tmp/shot.png`,
 *  `~/notes.md`, `./x.rs`. The leading slash is optional and separate so that
 *  an absolute path keeps it, and a relative one still matches from its first
 *  character rather than from its first slash. */
const SLASHED = String.raw`\/?(?:~|\.{1,2}|[\w.@+-]+)(?:\/[\w.@+-]+)+`;

/** A bare filename, which is how a reply usually names one: `package.json`.
 *  The extension must begin with a LETTER — that one rule is what keeps every
 *  version number and decimal in the prose out of this. */
const BARE = String.raw`[\w][\w@+-]*\.[A-Za-z]\w{0,7}`;

/** `:120` or `:120:8` — how a reply points at a line. Part of the words, not
 *  part of the file to open. */
const LINE = String.raw`(?::\d+(?::\d+)?)?`;

const PATH_RUN = new RegExp(`(?:${SLASHED}|${BARE})${LINE}`, "g");
const LINE_AT_END = new RegExp(`${LINE}$`);
const BARE_ONLY = new RegExp(`^${BARE}${LINE}$`);

/** The name at the end carries an extension. A FOLDER is a real path that the
 *  backend's existence check says yes to and the file panel cannot open, and
 *  this is the only thing in the string that tells the two apart. It is the
 *  same rule `candidatePaths` uses for the files panel, so both surfaces agree
 *  on what counts. */
const NAMES_A_FILE = new RegExp(String.raw`[^/]\.[A-Za-z]\w{0,7}${LINE}$`);

/** Punctuation the sentence owns rather than the path. Trailing only: a path
 *  at the end of a sentence swallows the full stop otherwise. */
const TRAILING = /[.,;:!?]+$/;

export type Run = {
  /** The words as written, line number and all. */
  text: string;
  /** The file to open, when this run is one. Absent for ordinary words. */
  path?: string;
};

/** Split a piece of text into the paths in it and the words between them.
 *
 *  Always covers the whole input: the runs joined back together are the string
 *  that went in, so nothing can be lost by marking. Text with no path in it
 *  comes back as a single run. */
export function pathRuns(value: string): Run[] {
  const out: Run[] = [];

  const push = (text: string, path?: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Words either side of a skipped match are one run, not two.
    if (!path && last && !last.path) last.text += text;
    else out.push(path ? { text, path } : { text });
  };

  let at = 0;
  PATH_RUN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_RUN.exec(value))) {
    const token = match[0].replace(TRAILING, "");
    // Trimming can leave something that is no longer a path at all, and a
    // match that started before where we are is one we already covered.
    const real = token.includes("/") ? NAMES_A_FILE.test(token) : BARE_ONLY.test(token);
    if (!token || match.index < at || !real) continue;
    push(value.slice(at, match.index));
    push(token, token.replace(LINE_AT_END, ""));
    at = match.index + token.length;
  }
  push(value.slice(at));

  return out.length ? out : [{ text: value }];
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function marked(text: string, path: string, code?: boolean): HastNode {
  return {
    type: "element",
    tagName: PATH_TAG,
    // A string rather than `true`: an unknown attribute's boolean value has no
    // agreed rendering, and this only ever has to survive the trip to a
    // component that reads it.
    properties: code ? { path, code: "1" } : { path },
    children: [{ type: "text", value: text }],
  };
}

/** A text node, become the runs in it. */
function split(value: string): HastNode[] {
  const runs = pathRuns(value);
  if (runs.length === 1 && !runs[0].path) return [{ type: "text", value }];
  return runs.map((run) =>
    run.path ? marked(run.text, run.path) : { type: "text", value: run.text },
  );
}

/** Inline code that is a path and nothing else — `web/src/App.tsx` — becomes
 *  one. Anything else stays code: a shell command mentions paths, and marking
 *  them inside it would break the command into pieces you cannot copy. */
function fromCode(node: HastNode): HastNode {
  const only = node.children?.length === 1 ? node.children[0] : null;
  if (!only || only.type !== "text" || !only.value) return node;
  const value = only.value.trim();
  const runs = pathRuns(value);
  if (runs.length !== 1 || !runs[0].path) return node;
  return marked(value, runs[0].path, true);
}

function walk(node: HastNode): void {
  if (!node.children?.length) return;
  // A code BLOCK is a listing, and a LINK already goes somewhere. Both are left
  // whole rather than walked into.
  if (node.tagName === "pre" || node.tagName === "a") return;

  const out: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      out.push(...split(child.value));
      continue;
    }
    if (child.tagName === "code") {
      out.push(fromCode(child));
      continue;
    }
    walk(child);
    out.push(child);
  }
  node.children = out;
}

export function rehypeFilePaths() {
  return (tree: HastNode) => walk(tree);
}
