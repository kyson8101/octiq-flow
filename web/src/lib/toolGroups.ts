// A run of tool calls, folded into one row.
//
// A long reply is mostly tool calls. Twelve of them stacked between two
// paragraphs push the reasoning off the screen, and the reader who scrolls past
// them was never going to read all twelve — they wanted to know THAT the agent
// went and looked, and roughly at what.
//
// So a run of three or more consecutive calls becomes one row: what ran, how
// often, and the newest call still visible on the row so a live turn does not
// go quiet. Open it and the cards are exactly the cards that would have been
// there.
//
// The NEWEST call of a run never folds, and it rides INSIDE the same box: a
// group is two sections, the run so far on top and the newest call underneath.
// That is what stops the screen jumping. Each new call pushes the one before it
// into the summary above, so the box is exactly as tall with eleven calls in it
// as with three — nothing is added to the page and nothing is taken away, and a
// run that finishes leaves the box the height it already was.
//
// Three kinds of call never fold away:
//   - a subagent (Task), because its whole transcript hangs off its card;
//   - a skill, because it is a set of instructions the agent has just taken
//     on: everything after it reads by its rules, and its card carries those
//     rules. Folded into "Bash × 7" it would be the one call that explains the
//     other six, hidden among them;
//   - a call that FAILED, because a group that swallows a failure is a group
//     that lies about the turn. The one row worth reading is the one that
//     stopped working.
// They also BREAK a run, which is what makes `Bash x5, Task, Bash x3` read as a
// group, a subagent, and another group.
//
// An EDIT used to be on that list, and taking it off is what made grouping
// work at all. A turn is mostly read, edit, edit, read, edit — and an edit that
// stands alone AND breaks the run around it leaves every run at one or two
// calls, under MIN_RUN, so nothing ever folded and the reader got the wall of
// single cards this file exists to prevent. What the old rule was protecting is
// kept another way: the tally names the FILE an edit went to, in the edit's own
// colour, and `groupDiff` puts the run's whole `+adds −dels` on the folded row.
// A group can hide how many calls it took to change a file. It cannot hide that
// the file changed.
//
// THINKING is not drawn here at all — it is watched live above the composer
// while it happens (see Composer's thinking strip) and left out of the
// transcript afterwards. It does not break a run either: an agent with
// interleaved thinking thinks between its calls, so a run of eight calls used
// to arrive as eight lone cards with "thought for a moment" between each pair —
// the wall this whole file exists to prevent.
import type { Block } from "./chat";
import { fileDiff } from "./diff";
import { toolDetail, toolLook, type ToolKind } from "./toolKind";

export type Tool = Extract<Block, { kind: "tool" }>;

/** How many calls in a row before folding them is worth it. Two rows are
 *  already readable; the third is where a stack starts to look like a wall. */
export const MIN_RUN = 3;

const NEVER_FOLD: ReadonlySet<ToolKind> = new Set<ToolKind>(["agent", "skill"]);

/** One thing to draw: a block on its own, or a run of calls as a group.
 *
 *  `tools` is the run so far, summarised on the group's top half. `newest` is
 *  the call that has not folded yet, drawn whole on the bottom half. */
/** A fenced code block that belongs to the tool card above it (card 73). */
export type Note = { lang: string; body: string };

export type Row =
  | { kind: "block"; block: Block; index: number; note?: Note }
  | { kind: "group"; tools: Tool[]; newest: Tool; index: number };

/** The fence, when a text block is ENTIRELY one fenced code block.
 *
 *  "Entirely" is the whole test, and it is deliberately strict. A block that is
 *  nothing but a fence is a lump of output the reply is showing you, and it sits
 *  better inside the card that produced it than floating under it in a box of
 *  its own. A block with prose AROUND the fence is the agent TALKING, and moving
 *  that into a card would hide half a sentence.
 *
 *  The closing fence is required. A fence still being typed has no end yet, and
 *  swallowing it would make the card flicker into existence mid-stream. */
export function fenceOnly(text: string): Note | null {
  const match = /^```([\w+-]*)\n([\s\S]*?)\n?```$/.exec(text.trim());
  if (!match) return null;
  return { lang: match[1] ?? "", body: match[2] ?? "" };
}

/**
 * Fold consecutive tool calls into groups.
 *
 * `index` is where the row ENDS in the original block list — the caller uses it
 * to tell which row is the last one, which is the row still being typed.
 *
 * `keepOut` names calls the caller knows better about than their name does: a
 * card that has picked up a subagent transcript is a subagent card whatever it
 * is called.
 */
export function groupRows(blocks: Block[], keepOut?: (tool: Tool) => boolean): Row[] {
  const rows: Row[] = [];
  let run: { tool: Tool; index: number }[] = [];

  const flush = () => {
    if (run.length >= MIN_RUN) {
      // Everything but the newest is folded. `folded` is never empty here:
      // MIN_RUN is 3, so there are at least two left to fold.
      const folded = run.slice(0, -1);
      const newest = run[run.length - 1];
      rows.push({
        kind: "group",
        tools: folded.map((r) => r.tool),
        newest: newest.tool,
        // The row ENDS at the newest call, because that is what it draws last.
        index: newest.index,
      });
    } else {
      for (const r of run) rows.push({ kind: "block", block: r.tool, index: r.index });
    }
    run = [];
  };

  blocks.forEach((block, index) => {
    if (block.kind === "tool" && foldable(block, keepOut)) {
      run.push({ tool: block, index });
      return;
    }
    // Thinking draws nothing, so it decides nothing: it neither takes a row of
    // its own nor cuts the run it landed in the middle of.
    if (block.kind === "thinking") return;
    // Card 73 — a block that is ENTIRELY one code fence, landing straight after
    // a single tool card, becomes that card's body instead of a box of its own.
    //
    // Only after a SINGLE tool. A group holds several calls and there is no
    // honest answer to which of them the text belongs to, so it stays a row.
    // And only the first: a second fence is the reply talking again.
    // Anything else — prose, an edit, a subagent — ends the run where it
    // stands. Moving a call past it would put the reply in the wrong order.
    //
    // Flushed BEFORE the card-73 check below, because a single tool that has
    // not folded yet is still pending in `run` and is not a row at all until
    // this happens. Checking first found nothing above the text and attached
    // nothing, which is how this was first wrong.
    flush();

    // Card 73 — a block that is ENTIRELY one code fence, landing straight after
    // a single tool card, becomes that card's body instead of a box of its own.
    //
    // Only after a SINGLE tool: a group holds several calls and there is no
    // honest answer to which of them the text belongs to. And only the first,
    // because a second fence is the reply talking again.
    const last = rows[rows.length - 1];
    if (block.kind === "text" && last?.kind === "block" && last.block.kind === "tool" && !last.note) {
      const note = fenceOnly(block.text);
      if (note) {
        rows[rows.length - 1] = { ...last, note, index };
        return;
      }
    }
    rows.push({ kind: "block", block, index });
  });
  flush();
  return rows;
}

function foldable(tool: Tool, keepOut?: (tool: Tool) => boolean): boolean {
  if (keepOut?.(tool)) return false;
  // A call that did not finish is the one worth seeing in a run of ones that
  // did — and a group rolls up to `done`, so folding either in would report the
  // whole run as finished.
  if (tool.state === "error" || tool.state === "stopped") return false;
  return !NEVER_FOLD.has(toolLook(tool.name, tool.args).kind);
}

/** What a group is worth on its collapsed row. */
export type GroupLook = {
  kind: ToolKind;
  /** How many calls are folded into it. Kept apart from the words after it
   *  because the count is the only part of the row that ever changes, and the
   *  row draws it as a rolling number rather than as text. */
  count: number;
  /** What follows the count: `× Bash` when the run was all one tool, `calls`
   *  when it was not. */
  noun: string;
  /** Running while any call in it is, and never anything worse: a failed call
   *  is never in a group at all, it is a row of its own. */
  state: Tool["state"];
  /** The newest call in the run, kept on the row: during a turn this is the
   *  command running right now, and afterwards it is where the run got to. */
  detail: string;
};

export function groupLook(tools: Tool[]): GroupLook {
  const looks = tools.map((t) => toolLook(t.name, t.args));
  const last = tools[tools.length - 1];
  const oneName = tools.every((t) => t.name === tools[0].name);
  return {
    // A mixed run takes the kind of the call whose detail is on the row, so the
    // icon and the text beside it are talking about the same call.
    kind: oneName ? looks[0].kind : toolLook(last.name, last.args).kind,
    count: tools.length,
    noun: oneName ? `× ${looks[0].label}` : "calls",
    state: tools.some((t) => t.state === "running") ? "running" : "done",
    detail: toolDetail(last.name, last.args),
  };
}

/** What the group actually did, counted: `python3 ×3`, `chat.ts ×4`.
 *
 *  A count of calls says how much happened; this says what happened. For a
 *  shell call that is the command, not the tool — a group of five `Bash` rows
 *  that says "Bash ×5" has told the reader nothing they could not see. For a
 *  read or an edit it is the file, for the same reason: "Read ×3 · Edit ×4"
 *  only repeats the row above it, and the file is the part that is nowhere
 *  else on screen.
 *
 *  `kind` is what colours the chip, and it is why one file is ONE chip however
 *  many ways it was touched: read, edit, read again is one file being worked
 *  on, not two things, and the chip takes the edit's colour the moment an edit
 *  lands in it. */
export type Tally = { label: string; count: number; kind: ToolKind };

export function groupTally(tools: Tool[]): Tally[] {
  const counts = new Map<string, Tally>();
  for (const tool of tools) {
    const { label, kind } = verb(tool);
    const seen = counts.get(label);
    if (!seen) {
      counts.set(label, { label, count: 1, kind });
      continue;
    }
    seen.count += 1;
    // A file that was CHANGED is not the same news as a file that was read.
    if (kind === "edit") seen.kind = "edit";
  }
  // Biggest first: a summary is read for its shape, and the long pole is the
  // shape. Ties keep the order they ran in, which is the order on screen.
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function verb(tool: Tool): { label: string; kind: ToolKind } {
  const look = toolLook(tool.name, tool.args);
  if (look.kind === "run") {
    const command = (tool.args as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && command.trim()) {
      return { label: commandHead(command), kind: look.kind };
    }
  }
  if (look.kind === "read" || look.kind === "edit") {
    const name = fileName(tool.args);
    if (name) return { label: name, kind: look.kind };
  }
  return { label: look.label, kind: look.kind };
}

/** The file a call went to, by the name a reader would say out loud.
 *
 *  The last segment, not the path: a tally is a strip of chips a few words
 *  wide, and the same absolute path repeated four times across it is the noise
 *  the fold was meant to remove. Two files sharing a name in different folders
 *  read as one chip, which is a far smaller lie than a path that eats the row —
 *  and the cards inside the group still carry the whole path. */
function fileName(args: unknown): string {
  const bag = args as Record<string, unknown> | undefined;
  if (!bag || typeof bag !== "object") return "";
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = bag[key];
    if (typeof v !== "string" || !v.trim()) continue;
    // A trailing slash would otherwise hand back an empty last segment.
    return v.trim().replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  }
  return "";
}

/** What a folded run CHANGED, added up.
 *
 *  The one thing a group must never swallow. An edit folds like any other call
 *  now, so the row it folds into has to answer "did anything change, and how
 *  much" without being opened — otherwise `9 calls` is a row that can quietly
 *  contain a rewrite of the file the reader is here about. Null when the run
 *  only looked at things. */
export type GroupDiff = { added: number; removed: number; files: number };

export function groupDiff(tools: Tool[]): GroupDiff | null {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  for (const tool of tools) {
    // A call still in flight has not changed anything yet, and a failed one
    // never will; neither belongs in a total that claims the work happened.
    if (tool.state !== "done") continue;
    const diff = fileDiff(tool.name, tool.args, tool.details);
    if (!diff) continue;
    added += diff.added;
    removed += diff.removed;
    files.add(diff.path);
  }
  if (!added && !removed) return null;
  return { added, removed, files: files.size };
}

/** The name of the program a shell line runs.
 *
 *  `CI=true /usr/bin/python3 run.py` is `python3`: the environment in front of
 *  it is setup, and the path to it is where it lives, neither of which is what
 *  ran. `git`, `pnpm` and their kind carry their subcommand, because on their
 *  own they name a dozen different jobs. */
const SUBCOMMAND = new Set([
  "git",
  "gh",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "cargo",
  "docker",
  "brew",
  "go",
  "kubectl",
  "dotnet",
  "tauri",
]);

export function commandHead(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  // Skip the `NAME=value` pairs a line can be prefixed with.
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const head = (words[i] ?? "").split("/").pop() ?? "";
  if (!head) return command.trim().slice(0, 24);
  const next = words[i + 1];
  if (SUBCOMMAND.has(head) && next && !next.startsWith("-")) return `${head} ${next}`;
  return head;
}
