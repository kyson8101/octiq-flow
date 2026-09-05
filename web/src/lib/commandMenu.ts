import type { Provider } from "./agentProviders";

export type CommandTrigger = "/" | "$";
export type CommandToken = {
  trigger: CommandTrigger;
  query: string;
  start: number;
  end: number;
};

function tokenInRange(
  text: string,
  provider: Provider,
  start: number,
  end: number,
): CommandToken | undefined {
  const candidate = text.slice(start, end);
  const match = (provider === "codex" ? /^([/$])(\S*)$/ : /^(\/)(\S*)$/).exec(candidate);
  if (!match) return undefined;
  return {
    trigger: match[1] as CommandTrigger,
    query: match[2],
    start,
    end,
  };
}

/** The command token under the caret, or nothing when the prefix is ordinary
 * text. For Codex, fall back to the nearest earlier skill token so its menu
 * remains available while the person continues the sentence after it. Codex
 * skills accept slash spelling and their native `$` form. Claude's CLI commands
 * remain slash-only and whole-input because embedding one would not execute it. */
export function commandToken(
  text: string,
  provider: Provider,
  caret = text.length,
): CommandToken | undefined {
  const at = Math.max(0, Math.min(caret, text.length));
  let tokenStart = at;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) tokenStart -= 1;
  const remaining = text.slice(at).search(/\s/);
  const end = remaining < 0 ? text.length : at + remaining;
  const active = tokenInRange(text, provider, tokenStart, end);
  if (provider === "claude") {
    return tokenStart === 0 && end === text.length ? active : undefined;
  }
  if (active) return active;

  // The caret may now be several words after the skill. Walk complete tokens
  // backwards and keep the first command-shaped one rather than requiring the
  // person to move the caret back onto it.
  let scanEnd = tokenStart;
  while (scanEnd > 0) {
    while (scanEnd > 0 && /\s/.test(text[scanEnd - 1])) scanEnd -= 1;
    const previousEnd = scanEnd;
    while (scanEnd > 0 && !/\s/.test(text[scanEnd - 1])) scanEnd -= 1;
    const previous = tokenInRange(text, provider, scanEnd, previousEnd);
    if (previous) return previous;
  }
  return undefined;
}

/** Provider command records use slash spelling as their canonical form. Keep
 * the prefix the person actually typed when drawing or completing one. */
export function withCommandTrigger(value: string, trigger: CommandTrigger): string {
  return trigger === "$" ? value.replace(/^\//, "$") : value;
}

/** Replace only the active token. A canonical completion carries one trailing
 * space; reuse the sentence's existing whitespace instead of doubling it. */
export function replaceCommandToken(
  text: string,
  token: CommandToken,
  completion: string,
): { text: string; caret: number } {
  const insert = token.end < text.length && /\s/.test(text[token.end])
    ? completion.trimEnd()
    : completion;
  return {
    text: text.slice(0, token.start) + insert + text.slice(token.end),
    caret: token.start + insert.length,
  };
}
