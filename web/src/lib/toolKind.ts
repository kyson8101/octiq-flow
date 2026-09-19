// What family a tool call belongs to, plus the compact label shown to readers.
//
// The provider's name still remains on the tool block and card title as
// evidence. The row may use a small reader-facing alias (`file_change` →
// `edit`) or compact a qualified identity (`mcp__server__tool`), alongside the
// family used for its icon, colour and folding behaviour.
//
// The families are deliberately few. A dozen colours down the left edge is not
// a legend, it is confetti; these are the distinctions a reader actually makes
// while skimming.

export type ToolKind =
  | "read"
  | "edit"
  | "run"
  | "search"
  | "web"
  | "agent"
  | "message"
  | "skill"
  | "mcp"
  | "plan"
  | "other";

export type ToolLook = {
  kind: ToolKind;
  /** What the row calls it. */
  label: string;
  /** Where it came from, when that is a separate thing from the name — the
   *  plugin a skill belongs to, the server an MCP tool lives on. */
  scope?: string;
};

/** The tools that ship with the agent, by family. Lower-cased, because the
 *  agent is not consistent about capitals across versions. */
const FAMILY: Record<string, ToolKind> = {
  read: "read",
  notebookread: "read",
  taskoutput: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  applypatch: "edit",
  file_change: "edit",
  bash: "run",
  bashoutput: "run",
  killshell: "run",
  killbash: "run",
  command_execution: "run",
  glob: "search",
  grep: "search",
  ls: "search",
  toolsearch: "search",
  webfetch: "web",
  websearch: "web",
  web_search: "web",
  task: "agent",
  agent: "agent",
  workflow: "agent",
  // These talk about agents but do not CREATE one or own a nested transcript.
  // Keep them foldable activity, so `ToolSearch → SendMessage` reads as one
  // compact action instead of two unrelated cards.
  sendmessage: "message",
  listagents: "other",
  todowrite: "plan",
  exitplanmode: "plan",
  enterplanmode: "plan",
  askuserquestion: "plan",
};

/** Read a string out of a tool's arguments, which may not have arrived yet:
 *  args stream in as JSON fragments, so the first render of a card often has
 *  nothing in them at all. */
function argString(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return "";
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

const SHELL_SETUP = new Set([".", "cd", "export", "readonly", "set", "source", "unset"]);
const SEARCH_COMMANDS = new Set(["fd", "find", "grep", "rg"]);
const READ_COMMANDS = new Set(["cat", "head", "sed", "tail"]);
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GH_OPTIONS_WITH_VALUE = new Set(["-R", "--hostname", "--repo"]);
const GH_COMMAND_GROUPS = new Set([
  "alias",
  "attestation",
  "auth",
  "cache",
  "codespace",
  "extension",
  "gist",
  "gpg-key",
  "issue",
  "label",
  "pr",
  "project",
  "release",
  "repo",
  "run",
  "search",
  "secret",
  "ssh-key",
  "variable",
  "workflow",
]);

type ShellEnvelope = { shell: "bash" | "zsh"; body: string };
type ShellCall = ShellEnvelope & { tool: string; args: string[] };

function compactFilePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  const file = parts.at(-1) ?? "";
  const parent = parts.at(-2);
  if (!parent) return file;
  return `${parts.length > 2 ? "..." : ""}${parent}/${file}`;
}

function argumentFile(args: unknown): string {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const path = argString(args, key);
    if (path) return compactFilePath(path);
  }
  return "";
}

/** A recognized shell command wrapper and the script passed to it. */
function shellEnvelope(name: string, args: unknown): ShellEnvelope | null {
  if (name.toLowerCase() !== "command_execution") return null;
  const command = argString(args, "command");
  const launcher = command.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+((?:-[A-Za-z]+\s+)+)([\s\S]+)$/);
  if (!launcher || !launcher[4].split(/\s+/).some((option) => option.slice(1).includes("c"))) return null;

  const executable = launcher[1] || launcher[2] || launcher[3] || "";
  const binary = executable.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (binary !== "zsh" && binary !== "bash") return null;

  let body = launcher[5].trim();
  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) {
    body = body.slice(1, -1);
  }
  return { shell: binary, body };
}

/** The first actual CLI launched by a shell command wrapper.
 *
 * Codex commonly reports `/bin/zsh -lc "gh pr view …"` as one very long
 * `command_execution`. The complete command remains in the card's arguments;
 * this extracts `gh` for the folded row. Setup clauses such as `cd … &&` are
 * skipped, while direct commands retain their existing useful preview. */
function shellCall(name: string, args: unknown): ShellCall | null {
  const envelope = shellEnvelope(name, args);
  if (!envelope) return null;

  for (const clause of envelope.body.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    const words = clause.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const called = (words[i] ?? "").replace(/^["']|["']$/g, "");
    const tool = called.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
    if (!tool || SHELL_SETUP.has(tool)) continue;
    return {
      ...envelope,
      tool,
      args: words.slice(i + 1).map((word) => word.replace(/^["']|["']$/g, "")),
    };
  }
  return null;
}

export function commandTool(name: string, args: unknown): string {
  return shellCall(name, args)?.tool ?? "";
}

/** How often a CLI appears in the wrapped shell script, including `$()` calls. */
export function shellCommandCount(name: string, args: unknown, tool: string): number {
  const envelope = shellEnvelope(name, args);
  if (!envelope || !/^[A-Za-z0-9_.+-]+$/.test(tool)) return 0;
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^\\w.-])${escaped}(?=\\s)`, "gm");
  return [...envelope.body.matchAll(pattern)].length;
}

function cleanShellWord(word: string): string {
  return word.replace(/^["'$(]+|["')\\]+$/g, "");
}

/** The meaningful `gh` operations inside a shell script (`pr list`, `api`, …). */
export function ghOperations(name: string, args: unknown): string[] {
  const envelope = shellEnvelope(name, args);
  if (!envelope) return [];

  const operations: string[] = [];
  const call = /(?:^|[^\w.-])gh(?=\s)/gm;
  for (const match of envelope.body.matchAll(call)) {
    const ghAt = (match.index ?? 0) + match[0].lastIndexOf("gh") + 2;
    const segment = envelope.body.slice(ghAt).split(/\s*(?:&&|\|\||;|\n)\s*/, 1)[0];
    const words = segment.trim().split(/\s+/).map(cleanShellWord).filter(Boolean);
    let i = 0;
    while (i < words.length && words[i].startsWith("-")) {
      if (GH_OPTIONS_WITH_VALUE.has(words[i])) i++;
      i++;
    }
    const group = words[i]?.toLowerCase() ?? "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(group)) continue;
    let operation = group;
    if (GH_COMMAND_GROUPS.has(group)) {
      let j = i + 1;
      while (j < words.length && words[j].startsWith("-")) {
        if (GH_OPTIONS_WITH_VALUE.has(words[j])) j++;
        j++;
      }
      const action = words[j]?.toLowerCase() ?? "";
      if (/^[a-z0-9][a-z0-9-]*$/.test(action)) operation += ` ${action}`;
    }
    operations.push(operation);
  }
  return operations;
}

function summarizeOperations(operations: string[]): string {
  const counts = new Map<string, number>();
  for (const operation of operations) counts.set(operation, (counts.get(operation) ?? 0) + 1);
  const entries = [...counts.entries()];
  const shown = entries.slice(0, 3).map(([operation, count]) => `${operation}${count > 1 ? `×${count}` : ""}`);
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length} more`);
  return shown.join(", ");
}

/** The file consumed by a simple read command, when it has one. */
export function commandFile(name: string, args: unknown): string {
  const call = shellCall(name, args);
  if (!call || !READ_COMMANDS.has(call.tool)) return "";
  const stop = call.args.findIndex((word) => word === "|" || /^[<>]/.test(word));
  const words = stop >= 0 ? call.args.slice(0, stop) : call.args;

  if (call.tool === "sed") {
    const files: string[] = [];
    let hasScript = false;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (["-e", "--expression", "-f", "--file"].includes(word)) {
        hasScript = true;
        i++;
        continue;
      }
      if (word.startsWith("-e") || word.startsWith("-f")) {
        hasScript = true;
        continue;
      }
      if (word.startsWith("-")) continue;
      if (!hasScript) {
        hasScript = true;
        continue;
      }
      files.push(word);
    }
    return compactFilePath(files.at(-1) ?? "");
  }

  const files: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (["-n", "--lines", "-c", "--bytes"].includes(word)) {
      i++;
      continue;
    }
    if (word === "--") {
      files.push(...words.slice(i + 1));
      break;
    }
    if (!word.startsWith("-") && !/^\+?\d+$/.test(word)) files.push(word);
  }
  return compactFilePath(files.at(-1) ?? "");
}

/** The operation after `git`, skipping global options that precede it. */
export function gitSubcommand(name: string, args: unknown): string {
  const call = shellCall(name, args);
  if (call?.tool !== "git") return "";

  for (let i = 0; i < call.args.length; i++) {
    const word = call.args[i];
    if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      i++;
      continue;
    }
    if (word.startsWith("-C") || word.startsWith("-c") || word.startsWith("--")) continue;
    if (word.startsWith("-")) continue;
    return word.toLowerCase();
  }
  return "";
}

/** Compact a qualified MCP callable without losing its server boundary.
 * The raw name remains on the card title for inspection. */
export function mcpLabel(name: string): string {
  const match = name.match(/^mcp__(.+?)__(.+)$/i);
  return match ? `mcp(${match[1]}:${match[2]})` : "";
}

export function toolLook(name: string, args: unknown): ToolLook {
  const raw = name || "";
  const lower = raw.toLowerCase();

  if (lower === "file_change") {
    const file = argumentFile(args);
    return { kind: "edit", label: file ? `edit(${file})` : "edit" };
  }

  if (lower === "command_execution") {
    const envelope = shellEnvelope(name, args);
    const gh = ghOperations(name, args);
    if (envelope && gh.length > 0) {
      return { kind: "run", label: `gh(${summarizeOperations(gh)})` };
    }
    const command = commandTool(name, args);
    if (SEARCH_COMMANDS.has(command)) return { kind: "search", label: `search(${command})` };
    if (READ_COMMANDS.has(command)) {
      const file = commandFile(name, args);
      return { kind: "read", label: `read(${file || command})` };
    }
    if (command === "git") {
      const operation = gitSubcommand(name, args);
      return { kind: "run", label: operation ? `git(${operation})` : "git" };
    }
    // A streamed command can reveal `gh` before its operation. Keep that
    // intermediate state in the same naming family as the completed label,
    // rather than flashing `zsh(gh)` before `gh(pr list)`.
    if (command === "gh") return { kind: "run", label: "gh" };
    if (command) return { kind: "run", label: `${envelope?.shell ?? "shell"}(${command})` };
  }

  // Arguments can explain which skill was requested, but the tool is still
  // named `Skill`. The card shows the argument separately; its name remains
  // the exact provider value.
  if (lower === "skill") {
    return { kind: "skill", label: raw || "tool" };
  }

  // Keep both parts of a qualified MCP callable visible, but make the boundary
  // readable at a glance: `mcp__octiq__ask_user` → `mcp(octiq:ask_user)`.
  if (lower.startsWith("mcp__")) {
    return { kind: "mcp", label: mcpLabel(raw) || raw };
  }

  const kind = FAMILY[lower] ?? "other";
  if (kind === "read" || kind === "edit") {
    const file = argumentFile(args);
    if (file) return { kind, label: `${kind}(${file})` };
  }
  return { kind, label: raw || "tool" };
}

/** The one detail worth showing on a collapsed row: which file, which pattern,
 *  which command. Falls back to nothing rather than dumping the whole object.
 *
 *  `isAgent` is passed in rather than read off the kind: a card knows it started
 *  a subagent as soon as that agent speaks, which is earlier and more certain
 *  than the tool's name. */
export function toolDetail(name: string, args: unknown, isAgent = false): string {
  const bag = args as Record<string, unknown> | undefined;
  if (!bag || typeof bag !== "object") return "";
  // A subagent is asked in a whole briefing. Ellipsised onto one line that says
  // nothing, so the row takes the short name the caller gave the job instead —
  // the briefing itself is one click away, under `arguments`.
  //
  // The row keeps the actual tool name (`Skill`), so its detail carries which
  // skill was requested and what arguments it received.
  if (toolLook(name, args).kind === "skill") {
    const skill = argString(args, "skill");
    const calledWith = argString(args, "args");
    return [skill, calledWith].filter(Boolean).join(" ");
  }
  const keys = isAgent
    ? ["description", "subagent_type", "prompt"]
    : ["file_path", "path", "pattern", "command", "query", "url", "prompt"];
  for (const key of keys) {
    const v = bag[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
