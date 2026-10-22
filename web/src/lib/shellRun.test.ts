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
    expect(shellCommand("bash", "# a script comment\npwd\n")).toBe("# a script comment\npwd");
  });
  it("strips console prompts and leaves output out of the command", () => {
    expect(shellCommand("console", "$ pwd\n/tmp\n$ printf '%s' \\\n> hello\nhello\nuser@host:~/work$ ls\nfile.txt\n# whoami\nroot\n"))
      .toBe("pwd\nprintf '%s' \\\nhello\nls\nwhoami");
    expect(shellCommand("console", "$ printf ok\r\nok\r\n")).toBe("printf ok");
  });
  it("does not promote angle-prefixed output to a command", () => {
    expect(shellCommand("console", "$ printf 'literal\\n'\n> printf output-is-command")).toBe("printf 'literal\\n'");
    expect(shellCommand("console", "$ pwd\n/tmp\n> output\n$ whoami\nroot")).toBe("pwd\nwhoami");
  });
  it("strips bare root, mixed and named prompts while dropping output", () => {
    expect(shellCommand("console", "# pwd\n/tmp")).toBe("pwd");
    expect(shellCommand("console", "# pwd\n/tmp\n$ whoami\nuser\nroot@host:~# id\nuid=0")).toBe("pwd\nwhoami\nid");
  });
  it("keeps real open-quote continuations, including prompt-like literal data", () => {
    expect(shellCommand("console", "$ printf '%s' 'first\n> $ literal\n> # literal\n> last'\noutput")).toBe("printf '%s' 'first\n$ literal\n# literal\nlast'");
    expect(shellCommand("console", '$ printf "%s" "first\n> last"\noutput')).toBe('printf "%s" "first\nlast"');
  });
  it("declines unprompted, incomplete and unsupported transcripts", () => {
    for (const source of ["pwd\n/tmp", "/tmp", "$ echo 'unfinished", "$ echo 'open\nmissing PS2", "$ cat <<'EOF'\n> data\n> EOF", "$ echo $(pwd)", "$ echo `pwd`"]) {
      expect(shellCommand("console", source)).toBe("");
    }
  });
});
