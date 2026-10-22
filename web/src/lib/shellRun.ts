/** Only explicitly labelled shell fences can start a terminal. */
export function isShellFence(language: string): boolean {
  return ["bash", "sh", "zsh", "shell", "console"].includes(language);
}

/** Check the parser's own source range, not the whole Markdown block. The
 * parser already handles container boundaries; the last line must still be a
 * real closer in the original reply, never closeFence's synthetic suffix. */
export function fencedCodeClosed(source: string, content: string, start?: number, end?: number): boolean {
  if (start === undefined || end === undefined || end > source.length) return false;
  const block = source.slice(start, end);
  const opener = /^(`{3,}|~{3,})/.exec(block);
  if (!opener || !block.includes("\n")) return false;
  // hast adds one newline per code-content line. A true closer contributes
  // another source line break; a fence-looking line still inside the code
  // (for example an extra quote marker) must not count as a closer.
  if ((block.match(/\n/g)?.length ?? 0) <= (content.match(/\n/g)?.length ?? 0)) return false;
  const last = block.slice(block.lastIndexOf("\n") + 1).replace(/\r$/, "");
  const closer = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*$/.exec(last);
  return !!closer && closer[1][0] === opener[1][0] && closer[1].length >= opener[1].length;
}

/** Only a trailing escape or open quote justifies a console continuation.
 * Multiline substitutions/heredocs need a shell parser: decline those rather
 * than risk mistaking their output for code. */
function continuation(command: string): boolean | null {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) { escaped = false; continue; }
    if (quote === "'") { if (c === "'") quote = ""; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === "`" || (c === "$" && command[i + 1] === "(") ||
        (!quote && c === "<" && command[i + 1] === "<")) return null;
    if (quote === '"') { if (c === '"') quote = ""; continue; }
    if (c === "'" || c === '"') quote = c;
    // Comments cannot open a quote or continue a command.
    else if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      const newline = command.indexOf("\n", i);
      if (newline < 0) break;
      i = newline;
    }
  }
  return !!quote || escaped;
}

/** console is a transcript, not an unlabelled script: require a recognizable
 * prompt, keep its commands and justified PS2 continuations, drop all output.
 * Ambiguous/incomplete transcripts get no Run. bash/sh/zsh/shell stay verbatim. */
export function shellCommand(language: string, text: string): string {
  const source = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (language !== "console") return source;
  const prompt = /^(?:[\w.-]+@[\w.-]+(?::[^\s]*)?\s*)?[$#] /;
  const commands: string[] = [];
  let current = "";
  let continuing = false;
  for (const line of source.split("\n")) {
    if (continuing) {
      if (!line.startsWith("> ")) return "";
      current += "\n" + line.slice(2);
    } else if (prompt.test(line)) {
      current = line.replace(prompt, "");
    } else {
      continue;
    }
    const next = continuation(current);
    if (next === null) return "";
    continuing = next;
    if (!continuing) { commands.push(current); current = ""; }
  }
  return continuing ? "" : commands.join("\n");
}
