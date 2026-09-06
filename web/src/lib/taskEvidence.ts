import type { Block, ChatState, Message } from "./chat";
import { latestPins, type Pin } from "./pins";
import { toolDetail, toolLook } from "./toolKind";

type Tool = Extract<Block, { kind: "tool" }>;
export type TaskStatus = "empty" | "waiting" | "running" | "blocked" | "settled" | "stopping" | "stopped" | "interrupted" | "failed" | "unknown";
export type ValidationEvidence = { id: string; command: string; status: "passed" | "failed" | "stopped" | "unknown"; exitCode?: number };
export type TaskEvidence = {
  turnId?: string;
  objective?: string;
  status: TaskStatus;
  step?: string;
  progress?: string;
  blocker?: string;
  files: string[];
  checks: ValidationEvidence[];
  pins: Pin[];
  settled: boolean;
};
export type TaskEvidenceOptions = { blocker?: string; interrupted?: boolean; connected?: boolean; liveKnown?: boolean };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function str(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function textOf(message: Message): string {
  return message.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n").trim();
}
function brief(value: string, length = 220): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length).trimEnd()}…` : flat;
}
function isPrompt(message: Message): boolean {
  return message.role === "user" && !message.parent && !message.speaker && !message.relay
    && (!!textOf(message) || !!message.attachments?.length);
}

/** Only accepted prompts advance a live turn. The queued tail is still visible
 * in chat, but cannot borrow or overwrite the active turn's evidence. Legacy
 * transcripts without acceptance markers use the following assistant reply. */
function currentTurn(chat: ChatState): { prompt?: Message; messages: Message[] } {
  const markers = new Set(chat.messages.filter((m) => isPrompt(m) && (m.echo || m.takenUp)).map((m) => m.to?.id ?? ""));
  let pending = -1;
  const followingReplies = new Set<string>();
  let start = -1;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const message = chat.messages[i];
    if (message.role === "assistant" && !message.parent) followingReplies.add(message.speaker?.id ?? "");
    if (!isPrompt(message)) continue;
    const seat = message.to?.id ?? "";
    // Addressed room messages dispatch directly to that seat; they are not in
    // the host's queued tail and must not keep showing an older host objective.
    if (message.to || message.echo || message.takenUp || (!markers.has(seat) && followingReplies.has(seat))) { start = i; break; }
    pending = i;
    followingReplies.delete(seat);
  }
  if (start < 0) start = pending;
  if (start < 0) return { messages: [] };
  return {
    prompt: chat.messages[start],
    messages: chat.messages.slice(start + 1).filter((m) => m.role === "assistant" && !m.parent && m.speaker?.id === chat.messages[start].to?.id),
  };
}

function toolSucceeded(tool: Tool): boolean {
  const details = obj(tool.details);
  return tool.state === "done" && details.is_error !== true && details.isError !== true
    && !["failed", "killed", "stopped"].includes(tool.finish?.status ?? "");
}

function editedPaths(tool: Tool): string[] {
  if (!toolSucceeded(tool)) return [];
  const name = tool.name.toLowerCase().replace(/^functions\./, "");
  if (!["edit", "write", "multiedit", "notebookedit", "applypatch", "apply_patch"].includes(name)) return [];
  const args = obj(tool.args);
  const paths = [str(args.file_path), str(args.path), str(args.notebook_path)];
  if (Array.isArray(args.changes)) paths.push(...args.changes.map((change) => str(obj(change).path)));
  // apply_patch's patch is structured input; prose and shell commands are never
  // scanned for file ownership. A failed patch contributes no paths.
  const patch = typeof tool.args === "string" ? tool.args : str(args.patch) || str(args.input);
  for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1].trim());
  return paths.filter((path) => path && !/[\0\r\n]/.test(path));
}

function commandOf(tool: Tool): string {
  const name = tool.name.toLowerCase().replace(/^functions\./, "");
  if (!["bash", "exec_command", "command_execution"].includes(name)) return "";
  const args = obj(tool.args);
  return str(args.command) || str(args.cmd);
}

/** Deliberately limited to recognizable validation invocations. A read, echo,
 * install, or assistant saying 'tests passed' is not a validation command. */
function shellBody(command: string): string {
  const wrapper = /^(?:\/bin\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/.exec(command);
  return wrapper ? wrapper[2] : command;
}
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "\\" && quote !== "'") { i += 1; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '\"') { quote = char; continue; }
    if (char === ";" || char === "\n" || char === "|" || (char === "&" && command[i + 1] === "&")) {
      segments.push(command.slice(start, i));
      if (command[i + 1] === char) i += 1;
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}
function isValidation(command: string): boolean {
  return commandSegments(shellBody(command)).some((part) => {
    const clean = part.trim().replace(/^(?:(?:env\s+)?\w+=[^\s]+\s+)*/, "");
    const packageCommand = clean.replace(/^(npm|pnpm|yarn|bun)\s+(?:(?:--dir|--prefix|--cwd|-C)\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)\s+)*/, "$1 ");
    return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|check(?::[\w-]+)?|typecheck|type-check|lint|build)|cargo\s+(?:test|check|clippy|build)|(?:(?:npx|(?:pnpm|npm|yarn|bun)\s+exec)\s+)?(?:vitest|jest|tsc|eslint|biome\s+check)|(?:python(?:3)?\s+-m\s+)?pytest|go\s+test|dotnet\s+(?:test|build))(?=\s|$)/.test(packageCommand)
      || /^cargo\s+fmt\b/.test(clean) && /(?:^|\s)--check(?:\s|$)/.test(clean);
  });
}
function exitCodeOf(tool: Tool): number | undefined {
  const details = obj(tool.details);
  const code = details.exit_code ?? details.exitCode;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  // These are harness result markers, not arbitrary occurrences of 'pass'.
  const matches = [...(tool.result ?? "").matchAll(/^(?:Process exited with code|Exit code:)\s*(-?\d+)\s*$/gm)];
  return matches.length ? Number(matches[matches.length - 1][1]) : undefined;
}
function validation(tool: Tool): ValidationEvidence | undefined {
  const command = commandOf(tool);
  if (!isValidation(command)) return undefined;
  const exitCode = exitCodeOf(tool);
  const finished = tool.finish?.status;
  let status: ValidationEvidence["status"] = "unknown";
  if (tool.state === "stopped" || finished === "killed" || finished === "stopped") status = "stopped";
  else if (tool.state === "error" || finished === "failed" || (exitCode !== undefined && exitCode !== 0)) status = "failed";
  // Shell fallbacks, pipes and later commands may mask the validation's exit.
  else if (toolSucceeded(tool) && exitCode === 0 && !/\|\||[;\n]|\|(?!\|)/.test(shellBody(command))) status = "passed";
  return { id: tool.id, command, status, ...(exitCode !== undefined ? { exitCode } : {}) };
}

function planProgress(tools: Tool[]): { step?: string; progress?: string } {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (!toolSucceeded(tool) || !["todowrite", "update_plan", "functions.update_plan"].includes(tool.name.toLowerCase())) continue;
    const args = obj(tool.args);
    const rows = args.todos ?? args.plan;
    if (!Array.isArray(rows)) continue;
    const tasks = rows.map(obj).filter((row) => str(row.content) || str(row.step));
    if (!tasks.length) return {};
    const active = tasks.find((row) => row.status === "in_progress");
    const complete = tasks.filter((row) => row.status === "completed").length;
    return {
      ...(active ? { step: brief(str(active.activeForm) || str(active.content) || str(active.step)) } : {}),
      progress: `${complete} of ${tasks.length} recorded steps complete`,
    };
  }
  return {};
}

export function deriveTaskEvidence(chat: ChatState, options: TaskEvidenceOptions = {}): TaskEvidence {
  const { prompt, messages } = currentTurn(chat);
  const base: TaskEvidence = { status: "empty", files: [], checks: [], pins: [], settled: false };
  if (!prompt) return base;
  const tools = messages.flatMap((m) => m.blocks.filter((b): b is Tool => b.kind === "tool"));
  const accepted = !!(prompt.echo || prompt.takenUp || messages.length);
  const stopped = messages.some((m) => m.id === chat.stoppedAt) || prompt.id === chat.stoppedAt;
  const busy = prompt.to ? messages.some((m) => m.streaming) || tools.some((t) => t.state === "running") : chat.busy;
  let status: TaskStatus = !accepted ? "waiting" : busy ? "running" : messages.length ? "settled" : "waiting";
  if (options.liveKnown === false || options.connected === false) status = "unknown";
  else if (chat.stopping && !prompt.to) status = "stopping";
  else if (options.interrupted) status = "interrupted";
  else if (stopped) status = "stopped";
  else if (chat.failure && !prompt.to) status = "failed";
  else if (chat.exited && chat.exited.code !== 0 && !prompt.to) status = chat.exited.code === null ? "interrupted" : "failed";
  else if (options.blocker) status = "blocked";
  const settled = ["settled", "stopped", "failed", "interrupted"].includes(status);
  const plan = planProgress(tools);
  const activeTool = [...tools].reverse().find((tool) => tool.state === "running");
  const lastTool = tools[tools.length - 1];
  const recentText = [...messages].reverse().map(textOf).find(Boolean);
  const step = activeTool ? `${toolLook(activeTool.name, activeTool.args).label}: ${brief(toolDetail(activeTool.name, activeTool.args), 120)}`
    : plan.step ?? (status === "running" ? chat.activity || "Agent is working" : undefined);
  const progress = plan.progress ?? (lastTool ? `${toolLook(lastTool.name, lastTool.args).label} · ${lastTool.state}` : recentText ? brief(recentText) : undefined);
  const pinMessages = messages.map((m) => ({ ...m, blocks: m.blocks.filter((b) => b.kind !== "tool" || toolSucceeded(b)) }));
  return {
    ...base,
    turnId: prompt.id,
    objective: brief(textOf(prompt) || "Review attached files"),
    status, settled, step, progress,
    blocker: options.blocker || (!prompt.to ? chat.failure?.detail || chat.failure?.title : undefined),
    files: [...new Set(tools.flatMap(editedPaths))],
    checks: tools.flatMap((tool) => { const check = validation(tool); return check ? [check] : []; }),
    pins: latestPins(pinMessages),
  };
}
