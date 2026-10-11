// A brief, as prose with its machine words set apart.
//
// A front-desk brief is a paragraph a person reads before agreeing to send it,
// and the things in it that are not words (an agent's id, a checkout path, a
// branch) are what make it hard to scan. This splits the text into runs so the
// card can set those in mono and leave the sentence around them alone.
//
// Pure, and it never drops a character except the backticks round a span the
// agent already marked as code: the runs joined back are the brief.
import { pathRuns } from "./filepaths";

export type BriefRun = {
  text: string;
  /** An id, a path, a branch, a commit, or a span the agent put in backticks. */
  mono: boolean;
};

/** A record the host names: `agent_ee96a6613d0c`, `task_fb9e…`, `run_…`. */
const HOST_ID = /^(?:agent|task|run|attempt|handover|gate)_[0-9a-f]{6,}$/;

/** A folder or file from the root, the home folder or a drive: `/src/app`,
 *  `~/notes`, `C:\work\app`. One name under `/` is left alone: that is how a
 *  slash command and "either/or" are written. */
const ABSOLUTE = /^(?:(?:~|[A-Za-z]:)(?:[\\/][\w.@+~-]+)+|(?:\/[\w.@+~-]+){2,})[\\/]?(?::\d+(?::\d+)?)?$/;

/** A branch under one of the prefixes this project's branches are cut with,
 *  or a remote's: `feature/mission-65cab`, `fix/login`, `origin/develop`. */
const BRANCH = /^(?:(?:origin\/)?(?:feature|feat|fix|bugfix|hotfix|release|chore|refactor|docs|test|task|octiq|mission)\/[\w./-]*\w|origin\/[\w./-]*\w)$/;

/** A commit: seven to forty hex characters with a digit and a letter among
 *  them, which is what tells `81603b4` from a year and from "defaced". */
const COMMIT = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/;

/** What a sentence wraps round a word rather than the word itself. */
const OPENING = /^[([{<"'“‘]+/;
const CLOSING = /[)\]}>"'”’.,;:!?]+$/;

function isMachineWord(word: string): boolean {
  if (HOST_ID.test(word) || ABSOLUTE.test(word) || BRANCH.test(word) || COMMIT.test(word)) return true;
  // A relative path to a file: `web/src/lib/handover.ts:120`. Only with a
  // slash in it: a bare `e.g` is a word, not a file.
  if (!word.includes("/")) return false;
  const runs = pathRuns(word);
  return runs.length === 1 && !!runs[0].path;
}

/** The brief as runs of plain words and machine words. Text with nothing to
 *  set apart comes back as one plain run. */
export function briefRuns(text: string): BriefRun[] {
  const out: BriefRun[] = [];
  const push = (part: string, mono: boolean) => {
    if (!part) return;
    const last = out[out.length - 1];
    if (!mono && last && !last.mono) last.text += part;
    else out.push({ text: part, mono });
  };
  const words = (part: string) => {
    // Odd places are the whitespace between words, kept as written.
    part.split(/(\s+)/).forEach((piece, index) => {
      if (index % 2) return push(piece, false);
      const open = piece.match(OPENING)?.[0] ?? "";
      const close = piece.slice(open.length).match(CLOSING)?.[0] ?? "";
      const word = piece.slice(open.length, piece.length - close.length);
      if (!isMachineWord(word)) return push(piece, false);
      push(open, false);
      push(word, true);
      push(close, false);
    });
  };
  // A code fence is a listing, not a span: left as written, ticks and all.
  if (text.includes("```")) {
    words(text);
    return out.length ? out : [{ text, mono: false }];
  }
  // Odd places are what the agent put between single backticks.
  text.split(/`([^`\n]+)`/).forEach((part, index) => {
    if (index % 2) push(part, true);
    else words(part);
  });
  return out.length ? out : [{ text, mono: false }];
}
