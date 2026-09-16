// What family a tool call belongs to, without changing its name.
//
// The provider's name is evidence: `Skill`, `bash`, `command_execution`, and
// `mcp__docspace__save_decision` must reach the UI exactly as reported. Calls
// are still sorted into a small family for their icon, colour and folding
// behaviour, but that presentation metadata must never rename the call.
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

export function toolLook(name: string, _args: unknown): ToolLook {
  const raw = name || "";
  const lower = raw.toLowerCase();

  // Arguments can explain which skill was requested, but the tool is still
  // named `Skill`. The card shows the argument separately; its name remains
  // the exact provider value.
  if (lower === "skill") {
    return { kind: "skill", label: raw || "tool" };
  }

  // An MCP prefix is part of the actual callable name. Keep it intact rather
  // than splitting and reordering it into a friendly label and scope badge.
  if (lower.startsWith("mcp__")) {
    return { kind: "mcp", label: raw };
  }

  const kind = FAMILY[lower] ?? "other";
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
