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
//   - an edit (Write / Edit / MultiEdit), because a change to a file is the
//     thing the reader is checking, not the noise around it;
//   - a subagent (Task), because its whole transcript hangs off its card;
//   - a call that FAILED, because a group that swallows a failure is a group
//     that lies about the turn. The one row worth reading is the one that
//     stopped working.
// They also BREAK a run, which is what makes `Bash x5, Write x2, Bash x3` read
// as a group, two edits, and another group.
//
// THINKING is not drawn here at all — it is watched live above the composer
// while it happens (see Composer's thinking strip) and left out of the
// transcript afterwards. It does not break a run either: an agent with
// interleaved thinking thinks between its calls, so a run of eight calls used
// to arrive as eight lone cards with "thought for a moment" between each pair —
// the wall this whole file exists to prevent.
import type { Block } from "./chat";
import { toolDetail, toolLook, type ToolKind } from "./toolKind";

export type Tool = Extract<Block, { kind: "tool" }>;

/** How many calls in a row before folding them is worth it. Two rows are
 *  already readable; the third is where a stack starts to look like a wall. */
export const MIN_RUN = 3;

const NEVER_FOLD: ReadonlySet<ToolKind> = new Set<ToolKind>(["edit", "agent"]);

/** One thing to draw: a block on its own, or a run of calls as a group.
 *
 *  `tools` is the run so far, summarised on the group's top half. `newest` is
 *  the call that has not folded yet, drawn whole on the bottom half. */
export type Row =
  | { kind: "block"; block: Block; index: number }
  | { kind: "group"; tools: Tool[]; newest: Tool; index: number };

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
    // Anything else — prose, an edit, a subagent — ends the run where it
    // stands. Moving a call past it would put the reply in the wrong order.
    flush();
    rows.push({ kind: "block", block, index });
  });
  flush();
  return rows;
}

function foldable(tool: Tool, keepOut?: (tool: Tool) => boolean): boolean {
  if (keepOut?.(tool)) return false;
  if (tool.state === "error") return false;
  return !NEVER_FOLD.has(toolLook(tool.name, tool.args).kind);
}

/** What a group is worth on its collapsed row. */
export type GroupLook = {
  kind: ToolKind;
  /** `5 × Bash` when it was all one tool, `7 calls` when it was not. */
  label: string;
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
    label: oneName ? `${tools.length} × ${looks[0].label}` : `${tools.length} calls`,
    state: tools.some((t) => t.state === "running") ? "running" : "done",
    detail: toolDetail(last.name, last.args),
  };
}

/** What the group actually did, counted: `python3 ×3`, `cd ×2`.
 *
 *  A count of calls says how much happened; this says what happened. For a
 *  shell call that is the command, not the tool — a group of five `Bash` rows
 *  that says "Bash ×5" has told the reader nothing they could not see. */
export type Tally = { label: string; count: number };

export function groupTally(tools: Tool[]): Tally[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = verb(tool);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // Biggest first: a summary is read for its shape, and the long pole is the
  // shape. Ties keep the order they ran in, which is the order on screen.
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function verb(tool: Tool): string {
  const look = toolLook(tool.name, tool.args);
  if (look.kind === "run") {
    const command = (tool.args as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && command.trim()) return commandHead(command);
  }
  return look.label;
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
