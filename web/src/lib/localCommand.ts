// Card 80 — the CLI's own report on a slash command it handled itself.
//
// A command the CLI answers without the model — `/compact`, `/model`, `/status`
// — reports back through the transcript as a USER turn, wrapped:
//
//   <local-command-stdout>Compacted </local-command-stdout>
//
// Nothing read that wrapper, so it landed as a bubble on the user's side
// containing raw XML they never typed.
//
// Surveyed across this project's transcripts it is three things: empty (most of
// them), an acknowledgement of the command above it, and — worth keeping — a
// real report such as `Set model to Opus 5 for this session only`. Whichever it
// is, it is the CLI speaking, not the person.

/** The wrapper, both streams. Anchored to the START of the turn: the whole turn
 *  is the wrapper when the CLI writes one, so a match anywhere would lift a
 *  sentence out of a message where somebody merely mentioned the tag. */
const WRAPPED = /^<local-command-(?:stdout|stderr)>([\s\S]*)<\/local-command-(?:stdout|stderr)>$/;

/** SGR escapes — the colouring the CLI writes for a terminal that is not here.
 *  Left in, they print as `[2m` in the middle of the words. */
const ANSI = /\u001b\[[0-9;]*m/g;

/** The report the CLI wrote, or `null` when this turn is not one of its own.
 *
 *  An EMPTY string is a real answer and not the same as `null`: the turn is the
 *  CLI's, it just had nothing to say, and only the caller can decide that means
 *  "draw nothing" rather than "this is something the person typed". */
export function parseLocalOutput(text: string): string | null {
  const found = WRAPPED.exec(text.trim());
  if (!found) return null;
  return (found[1] ?? "").replace(ANSI, "").trim();
}
