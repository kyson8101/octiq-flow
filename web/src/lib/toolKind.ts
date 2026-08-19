// What a tool call is, in the two words a row has room for.
//
// The names the agent sends are wiring: `Skill` for every skill there is,
// `Task` for every subagent, `mcp__docspace__save_decision` for one MCP call.
// A reader scanning a long reply is not looking for the wiring. They are
// looking for "it read a file", "it ran something", "it called /slice" — so
// each call is sorted into a small family, which is what earns it an icon and
// a colour, and given the name of the thing that actually ran.
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
  bash: "run",
  bashoutput: "run",
  killshell: "run",
  killbash: "run",
  glob: "search",
  grep: "search",
  ls: "search",
  toolsearch: "search",
  webfetch: "web",
  websearch: "web",
  task: "agent",
  agent: "agent",
  workflow: "agent",
  sendmessage: "agent",
  listagents: "agent",
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

export function toolLook(name: string, args: unknown): ToolLook {
  const raw = name || "";
  const lower = raw.toLowerCase();

  // A skill call is `Skill` every time — the skill's own name is an argument.
  // Reading it out is the whole difference between a reply that says it ran
  // five skills and a reply that says which five.
  if (lower === "skill") {
    const id = argString(args, "skill");
    if (!id) return { kind: "skill", label: "skill" };
    const [scope, rest] = id.includes(":") ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] : ["", id];
    return { kind: "skill", label: `/${rest}`, scope: scope || undefined };
  }

  // `mcp__<server>__<tool>`: the server is worth keeping — it is the answer to
  // "who is this talking to" — but not at the cost of the tool's own name,
  // which is the part that says what happened.
  if (lower.startsWith("mcp__")) {
    const parts = raw.split("__");
    if (parts.length >= 3) {
      return { kind: "mcp", label: parts.slice(2).join("__"), scope: parts[1] };
    }
    return { kind: "mcp", label: raw.slice(5) || raw };
  }

  return { kind: FAMILY[lower] ?? "other", label: raw || "tool" };
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
  // A skill has already put the thing that ran in the row's name, so the only
  // detail left worth showing is what it was called with.
  const keys = toolLook(name, args).kind === "skill"
    ? ["args"]
    : isAgent
      ? ["description", "subagent_type", "prompt"]
      : ["file_path", "path", "pattern", "command", "query", "url", "prompt"];
  for (const key of keys) {
    const v = bag[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
