// What a tool call is called, and what family it belongs to.
//
// The agent's own names are an implementation detail — `Skill`, `Task`,
// `mcp__docspace__save_decision`. What a reader wants on the row is the thing
// that actually ran, and a picture of what kind of thing it was.
import { describe, expect, it } from "vitest";

import {
  commandFile,
  commandSearchTerm,
  commandTool,
  ghOperations,
  gitSubcommand,
  mcpLabel,
  shellCommandCount,
  toolLook,
} from "./toolKind";

describe("commandTool", () => {
  it("finds the CLI launched through zsh", () => {
    expect(commandTool("command_execution", { command: "/bin/zsh -lc 'gh pr view 42'" })).toBe("gh");
    expect(commandTool("command_execution", { command: "'/opt/homebrew/bin/zsh' -l -c 'pnpm test'" })).toBe("pnpm");
    expect(commandTool("command_execution", { command: "/bin/zsh -lc \"ssh build-host 'pnpm install'\"" })).toBe("ssh");
    expect(commandTool("command_execution", { command: "/bin/bash -c 'gh pr view 42'" })).toBe("gh");
  });

  it("reads the direct command from a Bash tool", () => {
    expect(commandTool("Bash", { command: "grep -n needle src" })).toBe("grep");
    expect(commandTool("Bash", { command: "pnpm test" })).toBe("pnpm");
  });

  it("leaves an unwrapped command_execution and other tools alone", () => {
    expect(commandTool("command_execution", { command: "pnpm test" })).toBe("");
    expect(commandTool("Read", { command: "grep -n needle src" })).toBe("");
  });
});

describe("shellCommandCount", () => {
  it("counts nested and top-level CLI calls in a shell script", () => {
    const command = "/bin/bash -c 'current=\"$(gh pr view 162)\"\ngh pr review 162 --approve\ngh pr merge 162'";
    expect(shellCommandCount("command_execution", { command }, "gh")).toBe(3);
  });
});

describe("commandSearchTerm", () => {
  it("extracts patterns while skipping options and search paths", () => {
    expect(commandSearchTerm("command_execution", { command: "/bin/zsh -lc 'rg -n needle src'" })).toBe("needle");
    expect(commandSearchTerm("Bash", { command: 'grep -n "ProjectAvatar\\|project-avatar" src/Sidebar.tsx' })).toBe(
      "ProjectAvatar\\|project-avatar",
    );
    expect(commandSearchTerm("Bash", { command: "rg -g '*.tsx' 'avatar size' src" })).toBe("avatar size");
    expect(commandSearchTerm("Bash", { command: "find src -name '*.tsx'" })).toBe("*.tsx");
  });

  it("leaves searches without a literal pattern generic", () => {
    expect(commandSearchTerm("Bash", { command: "rg --files src" })).toBe("");
  });
});

describe("ghOperations", () => {
  it("extracts gh command groups and subcommands", () => {
    const command = "/bin/zsh -lc 'git remote -v && gh pr list --state open'";
    expect(ghOperations("command_execution", { command })).toEqual(["pr list"]);
  });

  it("finds operations in command substitutions and multiline scripts", () => {
    const command = "/bin/bash -c 'current=\"$(gh pr view 162)\"\ngh pr review 162 --approve\ngh pr merge 162'";
    expect(ghOperations("command_execution", { command })).toEqual(["pr view", "pr review", "pr merge"]);
  });
});

describe("mcpLabel", () => {
  it("keeps the MCP server and callable readable", () => {
    expect(mcpLabel("mcp__octiq__ask_user")).toBe("mcp(octiq:ask_user)");
    expect(mcpLabel("mcp__workspace_prod__get_ticket")).toBe("mcp(workspace_prod:get_ticket)");
  });

  it("leaves an unqualified name alone", () => {
    expect(mcpLabel("ask_user")).toBe("");
  });
});

describe("gitSubcommand", () => {
  it("extracts the operation from a git command", () => {
    expect(gitSubcommand("command_execution", { command: "/bin/zsh -lc 'git log --oneline'" })).toBe("log");
    expect(gitSubcommand("command_execution", { command: "/bin/zsh -lc 'git commit -m message'" })).toBe("commit");
    expect(gitSubcommand("command_execution", { command: "/bin/zsh -lc 'git push origin main'" })).toBe("push");
  });

  it("skips git global options before the operation", () => {
    expect(gitSubcommand("command_execution", { command: "/bin/zsh -lc 'git -C repo status'" })).toBe("status");
    expect(gitSubcommand("command_execution", { command: "/bin/zsh -lc 'git --no-pager diff'" })).toBe("diff");
  });
});

describe("commandFile", () => {
  it("finds files read by common shell commands", () => {
    expect(commandFile("command_execution", { command: "/bin/zsh -lc 'cat src/chat.ts'" })).toBe("src/chat.ts");
    expect(commandFile("command_execution", { command: "/bin/zsh -lc \"sed -n '1,80p' docs/README.md\"" })).toBe("docs/README.md");
    expect(commandFile("command_execution", { command: "/bin/zsh -lc 'head -n 20 package.json'" })).toBe("package.json");
  });
});

describe("toolLook", () => {
  it("keeps a skill tool's actual name and classifies it as a skill", () => {
    expect(toolLook("Skill", { skill: "pandahrms:slice", args: "--fast" })).toMatchObject({
      kind: "skill",
      label: "Skill",
    });
  });

  it("does not change a skill tool's name when its arguments stream in", () => {
    expect(toolLook("Skill", undefined)).toMatchObject({ kind: "skill", label: "Skill" });
  });

  it("formats a qualified MCP tool while classifying it as MCP", () => {
    expect(toolLook("mcp__docspace__save_decision", {})).toMatchObject({
      kind: "mcp",
      label: "mcp(docspace:save_decision)",
    });
  });

  it("shows a file_change event as edit with its filename", () => {
    expect(toolLook("file_change", { file_path: "chat.ts" })).toMatchObject({
      kind: "edit",
      label: "edit(chat.ts)",
    });
  });

  it("shows native read and edit tools with their filenames", () => {
    expect(toolLook("Read", { file_path: "/workspace/src/chat.ts" }).label).toBe("read(...src/chat.ts)");
    expect(toolLook("Write", { file_path: "/workspace/src/new.ts" }).label).toBe("edit(...src/new.ts)");
    expect(toolLook("Edit", { file_path: "/book/chapters/chapter-03/prose.md" }).label).toBe("edit(...chapter-03/prose.md)");
  });

  it("classifies CLIs launched through zsh by their intent", () => {
    expect(toolLook("command_execution", { command: "/bin/zsh -lc 'rg -n needle src'" })).toMatchObject({
      kind: "search",
      label: "search(rg: needle)",
    });
    expect(toolLook("command_execution", { command: "/bin/zsh -lc 'sed -n 1,80p README.md'" })).toMatchObject({
      kind: "read",
      label: "read(README.md)",
    });
    expect(toolLook("command_execution", { command: "/bin/zsh -lc 'gh pr view 42'" })).toMatchObject({
      kind: "run",
      label: "gh(pr view)",
    });
  });

  it("classifies commands sent directly to Bash by their intent", () => {
    expect(toolLook("Bash", { command: "grep -n ProjectAvatar src/components/Sidebar.tsx" })).toMatchObject({
      kind: "search",
      label: "search(grep: ProjectAvatar)",
    });
    expect(toolLook("Bash", { command: "cat src/components/Sidebar.tsx" })).toMatchObject({
      kind: "read",
      label: "read(...components/Sidebar.tsx)",
    });
    expect(toolLook("Bash", { command: "gh pr list --state open" })).toMatchObject({
      kind: "run",
      label: "gh(pr list)",
    });
  });

  it("shows the operation for git commands", () => {
    for (const operation of ["log", "status", "diff", "commit", "push"]) {
      expect(toolLook("command_execution", { command: `/bin/zsh -lc 'git ${operation}'` })).toMatchObject({
        kind: "run",
        label: `git(${operation})`,
      });
    }
  });

  it("shows the gh operations in a script", () => {
    const command = "/bin/bash -c 'set -euo pipefail\ncurrent=\"$(gh pr view 162)\"\ngh pr review 162 --approve\ngh pr view 162\ngh pr merge 162\ngh pr view 162'";
    expect(toolLook("command_execution", { command })).toMatchObject({
      kind: "run",
      label: "gh(pr view×3, pr review, pr merge)",
    });
  });

  it("keeps an incomplete gh call out of the shell fallback", () => {
    expect(toolLook("command_execution", { command: "/bin/zsh -lc 'gh'" })).toMatchObject({
      kind: "run",
      label: "gh",
    });
  });

  it("groups the everyday tools by what they do", () => {
    const kindOf = (name: string) => toolLook(name, {}).kind;
    expect(kindOf("Read")).toBe("read");
    expect(kindOf("Write")).toBe("edit");
    expect(kindOf("MultiEdit")).toBe("edit");
    expect(kindOf("file_change")).toBe("edit");
    expect(kindOf("Bash")).toBe("run");
    expect(kindOf("command_execution")).toBe("run");
    expect(kindOf("Grep")).toBe("search");
    expect(kindOf("WebSearch")).toBe("web");
    expect(kindOf("web_search")).toBe("web");
    expect(kindOf("Task")).toBe("agent");
    expect(kindOf("Workflow")).toBe("agent");
    expect(kindOf("SendMessage")).toBe("message");
    expect(kindOf("TodoWrite")).toBe("plan");
  });

  it("does not replace tool names with reader-facing aliases", () => {
    expect(toolLook("ToolSearch", {}).label).toBe("ToolSearch");
    expect(toolLook("SendMessage", {}).label).toBe("SendMessage");
  });

  it("is case-insensitive, because the agent is not consistent about it", () => {
    expect(toolLook("bash", {}).kind).toBe("run");
    expect(toolLook("skill", { skill: "ship" }).kind).toBe("skill");
  });

  it("keeps an unknown tool's own name and marks it as nothing in particular", () => {
    expect(toolLook("SomeNewThing", {})).toMatchObject({ kind: "other", label: "SomeNewThing" });
  });
});
