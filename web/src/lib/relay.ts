// The host answering its own room.
//
// A room's seats are separate processes. What one says goes into the ROOM's
// transcript — it never goes down the host's stdin — so after `@dee look at
// this` the host has not read a word of the answer sitting on screen above it.
// Until now it also said nothing about it, which read as the main agent
// ignoring the discussion happening in its own chat.
//
// So the backend hands it over: once the others have spoken, and nobody else is
// waiting on them, `round.rs` emits `chat-followup` with a brief of what was
// said. The client sends that to the host the same way it sends anything else.
//
// The brief is long — it quotes every answer in full, because the host cannot
// see them any other way — and putting it on screen as a message would print
// the whole discussion a second time directly underneath itself. So the bubble
// is replaced by ONE LINE, and this module is what recognises a brief in order
// to draw it that way. Recognised from the TEXT rather than from a flag, so a
// conversation rebuilt from the transcript reads exactly like the live one: the
// flag would be this page's memory, and the transcript keeps only the words.

/** The first line of every brief `round::followup_brief` writes. Changing it
 *  here without changing it there turns every brief back into a wall of text. */
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
