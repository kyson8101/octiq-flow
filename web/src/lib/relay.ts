// Compatibility parser for follow-up briefs stored by the removed multi-agent
// feature. It keeps old transcripts compact without exposing any new room UI.

/** The first line used by historical follow-up briefs. */
export const RELAY_HEAD = "=== what the others in this chat just said ===";

/** `--- Name ---`, the heading each answer sits under. */
const WHO = /^--- (.+) ---$/gm;

/** Everyone the brief quotes, in the order they spoke. */
function spokeIn(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(WHO)) {
    const name = m[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** "Dee and Codex", "Dee, Codex and Ana" — a list as it would be said aloud. */
function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The one line a follow-up brief is drawn as, or `undefined` when this is an
 *  ordinary message somebody typed.
 *
 *  It names WHO, because that is the only part of the brief the reader cannot
 *  already see: the answers themselves are the messages just above it. */
export function readRelay(text: string): string | undefined {
  if (!text.startsWith(RELAY_HEAD)) return undefined;
  const names = spokeIn(text);
  return names.length ? `passed on what ${andList(names)} said` : "passed the answers on";
}
