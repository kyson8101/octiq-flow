// A skill run, as the agent reports it.
//
// Running a skill — typed as `/ship`, or chosen by the agent — goes like this
// on the stream: a `Skill` tool call, a one-line result ("Launching skill:
// ship"), and then the skill's whole prompt, replayed as a USER message. That
// last one is the trap. It is a user message in shape only: the agent wrote it
// to itself, and drawn as a bubble it reads as "I said all this". These are
// the two readers that tell such a message apart from the user's own words.

/** How a skill READ OFF A FOLDER opens. The line that follows it is the folder
 *  it was read from, and everything after is the SKILL.md.
 *
 *  Not every skill has one. A skill bundled with the agent itself is handed
 *  over with no directory line at all — the instructions simply start — so
 *  there is nothing in the WORDS to recognise it by, and the envelope has to
 *  say so instead (`isMeta`, see lib/chat). */
const BRIEF_HEAD = "Base directory for this skill: ";

export type SkillBrief = {
  /** The folder the skill lives in, or "" for one that named no folder. */
  dir: string;
  /** The skill's own name — its folder's name. Empty when there was no
   *  folder to take it from; the Skill call's own arguments have it. */
  name: string;
  /** The plugin it came from, when it came from one. */
  scope?: string;
  /** The first sentence of its prose, plain: what the card says on its row. */
  summary: string;
  /** The instructions, as markdown, without the directory line. */
  body: string;
};

/** A skill installed from a plugin sits in the plugin cache, and the cache path
 *  is the only place its plugin's name is written down:
 *  `…/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>`. */
const PLUGIN_DIR = /\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/[^/]+\/?$/;

/** Does this text announce itself as a skill's prompt? Only a message that
 *  OPENS with the directory line does — the same words quoted deeper in a
 *  message are a quote. */
export function hasBriefHead(text: string): boolean {
  return text.startsWith(BRIEF_HEAD);
}

/** Read the prompt a skill put in front of the agent.
 *
 *  Without the directory line there is nothing here to check: whoever calls
 *  this has already decided the message IS a briefing, from the envelope it
 *  came in. So it is read as instructions with no folder to name, and null
 *  means only that there was nothing to read. */
export function parseSkillBrief(text: string): SkillBrief | null {
  if (!hasBriefHead(text)) {
    const body = text.trim();
    return body ? { dir: "", name: "", summary: summarise(body), body } : null;
  }
  const nl = text.indexOf("\n");
  const dir = (nl === -1 ? text : text.slice(0, nl)).slice(BRIEF_HEAD.length).trim();
  if (!dir) return null;
  const body = nl === -1 ? "" : text.slice(nl + 1).trim();
  const name = dir.replace(/\/+$/, "").split("/").pop() || dir;
  const scope = PLUGIN_DIR.exec(dir)?.[1];
  return { dir, name, scope, summary: summarise(body), body };
}

/** The first sentence of ordinary prose — not a heading, not a fence, not a
 *  list, not a table — with its markdown taken off. The heading is skipped
 *  because it mostly repeats the skill's name, which the row already says. */
function summarise(body: string): string {
  const paragraphs = body.split(/\n\s*\n/);
  for (const para of paragraphs) {
    const line = para.trim();
    if (!line) continue;
    if (/^(#|>|```|---|\||[-*+] |\d+\. |<)/.test(line)) continue;
    const plain = line
      .replace(/\s+/g, " ")
      .replace(/\*\*|__|`/g, "")
      .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=[\s.,;:!?)]|$)/g, "$1$2")
      .trim();
    const sentence = /^(.*?[.!?])(?:\s|$)/.exec(plain);
    return sentence ? sentence[1] : plain;
  }
  return "";
}

/** An older echo of a typed slash command:
 *  `<command-name>/ship</command-name>` with `<command-args>` beside it. Gives
 *  back the command as it was typed, or null when the text is not one. */
export function parseCommandEcho(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  const slashed = name.startsWith("/") ? name : `/${name}`;
  return args ? `${slashed} ${args}` : slashed;
}

/** A slash command split into its parts, or null when the text is not one. */
function slashParts(text: string): { plugin: string; name: string; args: string } | null {
  const match = /^\/([a-zA-Z0-9_-]+:)?([a-zA-Z0-9_-]+)(\s[\s\S]*)?$/.exec(text.trim());
  if (!match) return null;
  return {
    plugin: (match[1] ?? "").replace(/:$/, ""),
    name: match[2] ?? "",
    args: (match[3] ?? "").trim(),
  };
}

/** Are these the same command, allowing for the harness's namespace rewrite?
 *
 *  Typing `/execute` reaches the agent as `/pandahrms:execute`, and the echo
 *  comes back in the rewritten form. Compared literally it matches nothing, so
 *  the bubble you typed goes unclaimed and the rewritten text lands beside it as
 *  a SECOND user message — two lines in one bubble, the second of which you
 *  never said.
 *
 *  Only the namespace may differ. The command and its arguments must match
 *  exactly: the harness rewrites the prefix and nothing else, so anything else
 *  differing means these really are two different messages, and treating them
 *  as one would swallow the other.
 *
 *  Anything that is not a slash command falls back to a plain comparison, so no
 *  ordinary prose is ever taken off the user's side by this. */
export function sameCommand(typed: string, echoed: string): boolean {
  const a = slashParts(typed);
  const b = slashParts(echoed);
  if (!a || !b) return typed.trim() === echoed.trim();
  if (a.name !== b.name || a.args !== b.args) return false;
  // One side unnamespaced is the rewrite. Two DIFFERENT namespaces are two
  // different plugins' commands that happen to share a name.
  return !a.plugin || !b.plugin || a.plugin === b.plugin;
}

/** The skill a typed command actually resolved to, when the harness rewrote it.
 *
 *  Absent when nothing was rewritten — either an unnamespaced command, or the
 *  user typing the long form themselves. There is nothing to tell them then,
 *  and a badge repeating what they typed is noise. */
export function resolvedSkill(typed: string, echoed: string): string | undefined {
  if (!sameCommand(typed, echoed)) return undefined;
  const a = slashParts(typed);
  const b = slashParts(echoed);
  if (!a || !b || a.plugin || !b.plugin) return undefined;
  return `${b.plugin}:${b.name}`;
}
