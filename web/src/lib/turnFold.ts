// Turn-local presentation only. Cards and provider/host contracts stay intact.
import type { Block, Message } from "./chat";
import { foldable, type Tool } from "./toolGroups";
import { commandTool, toolLook } from "./toolKind";
import { parseConfigUsage } from "./configUsage";
import { elapsedLabel } from "./working";

export type TurnFold = {
  hidden: Set<number>;
  failures: Set<string>;
  danger: Set<string>;
  label: string;
  failed: number;
  lastProgress?: string;
  hasProgressWork: boolean;
};

/** Only a terminal failure stays red. Later prose/calls demonstrate recovery;
 * a failed turn remains a problem even if it managed to say something after. */
export function terminalFailures(blocks: Block[], ended: boolean, failed: boolean, textAfter = -1): Set<string> {
  const danger = new Set<string>();
  let followed = false;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.kind === "tool" && block.state === "error" && (failed || (ended && !followed && index > textAfter)))
      danger.add(block.id);
    if (block.kind === "tool" || (block.kind === "text" && !!block.text.trim())) followed = true;
  }
  return danger;
}

export function turnFold(messages: Message[], options: {
  live: boolean;
  stopped?: boolean;
  keepOut?: (tool: Tool) => boolean;
}): TurnFold {
  const blocks = messages.flatMap((m) => m.blocks);
  const end = [...messages].reverse().find((m) => m.turnEnd)?.turnEnd;
  const ended = !options.live && !messages.some((m) => m.streaming);
  const failed = end?.status === "failed" || blocks.some((b) => b.kind === "tool" && b.id.startsWith("agent-error-"));
  const textAfter = messages.reduce((latest, message) => Math.max(latest,
    message.textAfterTool ? blocks.map((b) => b.kind === "tool" && b.id === message.textAfterTool).lastIndexOf(true) : -1), -1);
  const danger = terminalFailures(blocks, ended, failed, textAfter);
  const hidden = new Set<number>();
  const failures = new Set<string>();
  const counts = { commands: 0, reads: 0, edits: 0, tools: 0 };
  // Keep the last prose stretch, including when the final answer is empty,
  // the turn failed, or Stop caught a call after that prose.
  const lastText = blocks.map((b) => b.kind === "text" && !!b.text.trim()).lastIndexOf(true);
  let offset = 0;
  let messageStart = 0;
  for (const message of messages) {
    if (offset <= lastText && offset + message.blocks.length > lastText) messageStart = offset;
    offset += message.blocks.length;
  }
  let finalStart = lastText;
  while (finalStart > messageStart && ["text", "thinking"].includes(blocks[finalStart - 1].kind)) finalStart--;
  const lastTool = blocks.map((b) => b.kind === "tool").lastIndexOf(true);
  blocks.forEach((block, index) => {
    if (!ended) return;
    if (block.kind === "text" && index < finalStart && parseConfigUsage(block.text) === null) hidden.add(index);
    if (block.kind === "thinking") hidden.add(index);
    if (block.kind !== "tool" || !foldable(block, options.keepOut)) return;
    if ((options.stopped || end?.status === "stopped") && index === lastTool && block.state === "error") return;
    // Decision calls remain individual even where their provider name is MCP.
    if (/(?:^|__)(?:request_access|request_permission|handover|route_chat|orchestration_gate_create)$/.test(block.name.toLowerCase())) return;
    hidden.add(index);
    const kind = toolLook(block.name, block.args).kind;
    const counter = commandTool(block.name, block.args) ? "commands" : kind === "read" ? "reads" : kind === "edit" ? "edits" : "tools";
    counts[counter]++;
    if (block.state === "error") failures.add(block.id);
  });
  const facts = Object.entries(counts).filter(([, count]) => count > 0)
    .map(([word, count]) => `${count} ${count === 1 ? word.slice(0, -1) : word}`);
  const duration = end?.durationMs;
  const candidate = [...messages].reverse().find((m) => m.codexCandidate)?.codexCandidate;
  const progress = [...messages.flatMap((m) => m.progress ?? []), ...(candidate ? [candidate] : [])]
    .filter((text) => !!text.trim());
  const lastProgress = lastText < 0 ? progress.at(-1) : undefined;
  return { hidden, danger, failures, failed: failures.size, lastProgress,
    hasProgressWork: progress.length > (lastProgress ? 1 : 0),
    label: [`Worked${duration !== undefined ? ` ${elapsedLabel(duration)}` : ""}`, ...facts].join(" · ") };
}
