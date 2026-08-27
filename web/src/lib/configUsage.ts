// Reading the list of settings the CLI prints for a bare `/config`.
//
// Typed into a chat, `/config` is answered by the CLI itself, and the answer is
// thirty-odd lines of this:
//
//     Usage: /config key=value [key=value ...]
//       artifacts=true|false
//       editor=normal|vim
//       model=default|sonnet|opus|haiku|best|sonnet[1m]|opus[1m]|opusplan
//       theme=auto|dark|light|light-daltonized|dark-ansi
//       …
//
// which is a terminal's way of saying "here are your settings". In a chat it
// arrives as a wall of grey text you then have to type back at it one line at a
// time. It is a LIST OF CONTROLS wearing prose, and this is the part that
// undresses it: text in, settings out, so the panel can draw the real thing.
//
// It reads what the CLI printed and nothing else. The allowed values are the
// ones on the line — not a copy kept here — so a key Claude Code adds next
// month appears on its own, and one it drops disappears the same way.

/** One setting, as the CLI described it. */
export type Setting = {
  /** What goes on the left of the `=`. */
  key: string;
  /** The values it will take. Empty when the CLI wrote `<value>`, which is its
   *  way of saying "anything" — a language name, a path. */
  options: string[];
};

/** The first line, which is what makes this a settings list rather than a
 *  reply that happens to contain `key=value`. */
const USAGE = /^usage:\s*\/config\s+key=value/i;

/** A setting line: `  key=a|b|c`, or `  key=<value>` for a free one. The key is
 *  the CLI's own spelling and is always a bare word. */
const SETTING = /^\s*([A-Za-z][A-Za-z0-9]*)=(.+)$/;

/** The settings the CLI listed, or `null` when this text is not that list.
 *
 *  `null` rather than an empty array on purpose: "not a settings list" and "a
 *  settings list with nothing in it" would look identical to the caller, and
 *  only the first should leave the text alone to be drawn as prose. */
export function parseConfigUsage(text: string): Setting[] | null {
  const lines = text.trim().split("\n");
  if (!lines.length || !USAGE.test(lines[0].trim())) return null;

  const settings: Setting[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const found = SETTING.exec(line);
    // A line that is not a setting ends the list rather than being skipped: the
    // usage block is contiguous, and anything after it is the CLI talking about
    // something else.
    if (!found) {
      if (line.trim()) break;
      continue;
    }
    const [, key, rest] = found;
    if (seen.has(key)) continue;
    seen.add(key);
    // `<value>` is the CLI's placeholder, not a choice you can click.
    const options = rest.trim() === "<value>" ? [] : rest.trim().split("|").filter(Boolean);
    settings.push({ key, options });
  }

  return settings.length ? settings : null;
}

/** What the CLI says back when a setting takes: `Set Verbose output to true`.
 *
 *  It answers in PROSE — the setting's display name, not the key you typed — so
 *  the reply cannot be matched to a row by string equality. `keyOf` does that
 *  part; this only pulls the two halves out. */
const CONFIRMED = /^set\s+(.+?)\s+to\s+(.+?)\.?$/i;

/** The setting a `Set … to …` line confirms, matched back to one of `keys`.
 *
 *  Matched by squeezing the spaces out of the display name and looking for the
 *  key at the front of it: `Verbose output` → `verboseoutput`, which starts
 *  with `verbose`. The LONGEST key that fits wins, so `autoCompact` is not read
 *  as `auto` when both exist.
 *
 *  A name that matches nothing gives `null`. That is the honest answer and the
 *  important one — a row marked with a value it does not have is worse than a
 *  row marked with nothing. */
export function confirmedSetting(
  text: string,
  keys: string[],
): { key: string; value: string } | null {
  const found = CONFIRMED.exec(text.trim());
  if (!found) return null;
  const name = found[1].replace(/\s+/g, "").toLowerCase();
  const value = found[2].trim();

  let best: string | null = null;
  for (const key of keys) {
    if (!name.startsWith(key.toLowerCase())) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? { key: best, value } : null;
}

/** Initialisms, which are the one thing lower-casing a key gets wrong: `Pr
 *  status` and `Auto connect ide` read as typos. Short and closed on purpose —
 *  it is a spelling list, not a dictionary of settings, so a key added to the
 *  CLI tomorrow still comes out right without anyone touching this. */
const SHOUTED = new Set(["ide", "pr", "api", "url", "id", "mcp", "cli", "ui", "ai"]);

/** The key, said the way a person would: `autoConnectIde` → `Auto connect IDE`.
 *
 *  There is no table of names here and there should not be one — it would go
 *  stale the first time Claude Code added a setting. The CLI's own key names
 *  are good English already, only run together, so the work is putting the
 *  spaces back and shouting the initialisms. */
export function settingLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .map((word) => (SHOUTED.has(word) ? word.toUpperCase() : word));
  const first = words[0] ?? "";
  words[0] = SHOUTED.has(first.toLowerCase()) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

/** The groups the rows are drawn under.
 *
 *  A flat list of thirty rows is the same wall of text with nicer edges. These
 *  are only the ones worth being sure about; everything else falls to the end
 *  under "Everything else", which is where a key added after this was written
 *  lands — visible and usable, just not filed. */
const GROUPS: { title: string; keys: string[] }[] = [
  { title: "The model", keys: ["model", "switchModelsOnFlag", "thinking", "outputStyle"] },
  {
    title: "What it may do",
    keys: ["permissionMode", "useAutoModeDuringPlan", "checkpoints", "gitignore", "worktreeBaseRef"],
  },
  {
    title: "Workflows",
    keys: ["workflows", "workflowKeywordTriggerEnabled", "workflowSizeGuideline"],
  },
  { title: "The window", keys: ["theme", "language", "reduceMotion", "progressBar", "tips", "turnDuration", "verbose", "recap"] },
  { title: "Editing", keys: ["editor", "externalEditorContext", "autoConnectIde", "chrome"] },
  { title: "Notifications", keys: ["notifChannel", "prStatus"] },
  { title: "The conversation", keys: ["autoCompact", "artifacts", "copyFullResponse", "defaultToAgentsView", "leftArrowOpensAgents"] },
];

/** The settings, in the order they should be drawn: grouped, with anything
 *  unrecognised kept together at the end rather than dropped. */
export function groupSettings(settings: Setting[]): { title: string; rows: Setting[] }[] {
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const out: { title: string; rows: Setting[] }[] = [];
  const placed = new Set<string>();

  for (const group of GROUPS) {
    const rows = group.keys.map((k) => byKey.get(k)).filter((s): s is Setting => !!s);
    for (const row of rows) placed.add(row.key);
    if (rows.length) out.push({ title: group.title, rows });
  }

  const rest = settings.filter((s) => !placed.has(s.key));
  if (rest.length) out.push({ title: "Everything else", rows: rest });
  return out;
}
