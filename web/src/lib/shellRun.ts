/** Only explicitly labelled shell fences can start a terminal. */
export function isShellFence(language: string): boolean {
  return ["bash", "sh", "zsh", "shell", "console"].includes(language);
}

/** Console transcripts include prompts and output. When prompts are present,
 * keep just the commands and their continuation lines; never run the output.
 * An unprompted console fence is already a plain shell script. */
export function shellCommand(language: string, text: string): string {
  const source = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (language !== "console") return source;
  const lines = source.split("\n");
  // A bare # is also a shell comment. Only treat it as a root prompt once
  // this is unambiguously a transcript ($ or a named user's prompt).
  const explicitPrompt = /^(?:[\w.-]+@[\w.-]+(?::[^\s]*)?\s*[$#]|\$) /;
  if (!lines.some((line) => explicitPrompt.test(line))) return source;
  const prompt = /^(?:[\w.-]+@[\w.-]+(?::[^\s]*)?\s*)?[$#] /;
  const commands: string[] = [];
  let continuing = false;
  for (const line of lines) {
    if (prompt.test(line)) {
      commands.push(line.replace(prompt, ""));
      continuing = true;
    } else if (continuing && line.startsWith("> ")) {
      commands.push(line.slice(2));
    } else {
      continuing = false;
    }
  }
  return commands.join("\n");
}
