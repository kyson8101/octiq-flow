import { describe, expect, it } from "vitest";
import { isShellFence, shellCommand } from "./shellRun";

describe("shell code blocks", () => {
  it("offers Run only for the five explicit shell languages", () => {
    for (const lang of ["bash", "sh", "zsh", "shell", "console"]) expect(isShellFence(lang)).toBe(true);
    for (const lang of ["", "text", "javascript", "powershell", "BASH", "bash-script"]) expect(isShellFence(lang)).toBe(false);
  });
  it("preserves a script's indentation, multiline content and prompt-like data", () => {
    const command = "  cat <<'END'\n$ literal\n> literal\nEND\n";
    expect(shellCommand("bash", command)).toBe(command.slice(0, -1));
    expect(shellCommand("console", "# a script comment\npwd\n")).toBe("# a script comment\npwd");
    expect(shellCommand("console", "printf 'ok'\n\nprintf 'done'\n")).toBe("printf 'ok'\n\nprintf 'done'");
  });
  it("strips console prompts and leaves output out of the command", () => {
    expect(shellCommand("console", "$ pwd\n/tmp\n$ printf '%s' \\\n> hello\nhello\nuser@host:~/work$ ls\nfile.txt\n# whoami\nroot\n"))
      .toBe("pwd\nprintf '%s' \\\nhello\nls\nwhoami");
    expect(shellCommand("console", "$ printf ok\r\nok\r\n")).toBe("printf ok");
  });
});
