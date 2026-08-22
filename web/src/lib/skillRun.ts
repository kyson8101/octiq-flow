// A skill run, as the agent reports it.
//
// Running a skill — typed as `/ship`, or chosen by the agent — goes like this
// on the stream: a `Skill` tool call, a one-line result ("Launching skill:
// ship"), and then the skill's whole prompt, replayed as a USER message. That
// last one is the trap. It is a user message in shape only: the agent wrote it
// to itself, and drawn as a bubble it reads as "I said all this". These are
// the two readers that tell such a message apart from the user's own words.

/** How the skill prompt opens, every time. The line that follows it is the
 *  folder the skill was read from, and everything after is the SKILL.md. */
const BRIEF_HEAD = "Base directory for this skill: ";

export type SkillBrief = {
  /** The folder the skill lives in. */
  dir: string;
  /** The skill's own name — its folder's name. */
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

/** Read the prompt a skill put in front of the agent, or null for anything
 *  else. Only a message that OPENS with the directory line counts — the same
 *  words quoted deeper in a message are a quote. */
export function parseSkillBrief(text: string): SkillBrief | null {
  if (!text.startsWith(BRIEF_HEAD)) return null;
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
