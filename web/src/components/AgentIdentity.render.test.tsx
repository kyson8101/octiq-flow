// The agent-first surfaces, rendered: who a reply is from, where a task runs
// and how sure the host is of it, and each state of the avatar editor.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {} } }));
vi.mock("../lib/pathStore", () => ({ knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {} }));

import type { Message } from "../lib/chat";
import type { TaskStatus } from "../lib/chatTask";
import { MessageList } from "./MessageList";
import { ChatTaskBarView } from "./ChatTaskBar";
import { AgentAvatarEditorView } from "./AgentAvatarEditor";
import { AgentAvatar } from "./AgentAvatar";

const reply: Message = { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "Done." }], streaming: false };

describe("who a reply is from", () => {
  it("signs a reply with the agent's name and face in its conversation", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[reply]} busy={false} hostName="Maya" hostPersona={{ id: "a", name: "Maya", avatar: "data:image/png;base64,AA==" }} />,
    );
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).toMatch(/msg-role[^>]*>.*Maya/s);
    expect(html).not.toContain(">Claude<");
  });

  it("keeps the provider's name in an ordinary chat", () => {
    const html = renderToStaticMarkup(<MessageList messages={[reply]} busy={false} hostName="Codex" />);
    expect(html).toContain("Codex");
    expect(html).not.toContain("agent-avatar");
  });
});

describe("the avatar itself", () => {
  it("falls back to labelled initials", () => {
    const html = renderToStaticMarkup(<AgentAvatar name="Potato Juice" id="x" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Potato Juice"');
    expect(html).toContain(">PJ<");
  });

  it("stays out of the accessibility tree beside a printed name", () => {
    const html = renderToStaticMarkup(<AgentAvatar name="Maya" decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("role=");
  });
});

const NOW = 1_800_000_000_000;
const status: TaskStatus = {
  chatId: "c1",
  projectId: "p-flow",
  workspace: {
    cwd: "/code/.worktrees/octiq-flow/octiq/fix", exists: true, isRepo: true,
    repoRoot: "/code/.worktrees/octiq-flow/octiq/fix", primaryRoot: "/code/octiq-flow",
    branch: "octiq/fix", isWorktree: true, changed: 0, ahead: 0, behind: 0, hasUpstream: false,
  },
  delivery: {
    target: "develop", head: "abc", onTarget: false, commits: 0, uncommitted: 0, pushed: false, merged: false,
    mergedRemote: false, released: null, releaseNote: "", stale: false, checkedAt: NOW - 60_000,
  },
};

describe("the task panel's environment", () => {
  const panel = (context: Parameters<typeof ChatTaskBarView>[0]["context"], s: TaskStatus | null = status) =>
    renderToStaticMarkup(<ChatTaskBarView status={s ?? undefined} open now={NOW} onToggle={() => {}} context={context} />);

  it("says who, where, and which facts the host verified", () => {
    const html = panel({
      persona: { id: "a", name: "Maya" },
      runsOn: "Claude Opus 4.7",
      projectName: (id) => (id === "p-flow" ? "octiq-flow" : undefined),
      launch: { projectId: "p-flow", projectName: "octiq-flow", path: "/code/octiq-flow", baseBranch: "develop", newWorktree: true, prepare: true, useSandbox: false, chosenBy: "auto", reason: "New worktree from develop, so the primary checkout stays untouched." },
    });
    expect(html).toContain("chat-task-agent");
    expect(html).toContain("Maya");
    expect(html).toContain("Claude Opus 4.7");
    expect(html).toContain("Environment");
    expect(html).toContain("Checked 1m ago");
    expect(html).toContain("/code/.worktrees/octiq-flow/octiq/fix");
    expect(html).toContain('data-evidence="confirmed"');
    expect(html).toContain("Planned: New branch from develop");
    expect(html).toContain('aria-label="Copy working directory path"');
    expect(html).toContain("Chosen automatically: New worktree from develop");
  });

  it("never shows an unverified chat as verified", () => {
    const html = panel({ launch: { projectId: "p-flow", chosenBy: "auto", prepare: true, newWorktree: true, path: "/code/octiq-flow" } }, null);
    expect(html).toContain("Not verified yet");
    expect(html).not.toContain('data-evidence="confirmed"');
    expect(html).toContain('data-evidence="planned"');
  });
});

describe("the avatar editor", () => {
  const view = (gen: Parameters<typeof AgentAvatarEditorView>[0]["gen"], avatar?: string, name = "Maya") => renderToStaticMarkup(
    <AgentAvatarEditorView name={name} avatar={avatar} gen={gen} now={NOW} description="" uploadError=""
      onDescription={() => {}} onUpload={() => {}} onRemove={() => {}} onGenerate={() => {}}
      onCancel={() => {}} onAccept={() => {}} onDiscard={() => {}} />,
  );

  it("offers upload and generation when ChatGPT can draw here", () => {
    const html = view({ kind: "idle" });
    expect(html).toContain("Upload image");
    expect(html).toContain("Generate with ChatGPT");
    expect(html).not.toMatch(/Generate with ChatGPT[^<]*<\/button>.*disabled/);
    expect(html).toContain("Optional look");
  });

  it("explains an honest unavailable state and still allows upload", () => {
    const html = view({ kind: "unavailable", reason: "Codex is not signed in.", setup: "Run `codex login` and sign in with ChatGPT." });
    expect(html).toContain("Codex is not signed in.");
    expect(html).toContain("codex login");
    expect(html).toContain("You can still upload an image.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Generate with ChatGPT/);
  });

  it("previews a generated picture beside the current one until accepted", () => {
    const html = view({ kind: "candidate", image: "data:image/webp;base64,BB==" }, "data:image/png;base64,AA==");
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).toContain('src="data:image/webp;base64,BB=="');
    expect(html).toContain("Use this");
    expect(html).toContain("Regenerate");
    expect(html).toContain("Nothing is saved until you press Save.");
  });

  it("can be cancelled while it draws", () => {
    const html = view({ kind: "running", jobId: "j", startedAt: NOW - 5000 });
    expect(html).toContain("Cancel");
    expect(html).toContain("about a minute");
    expect(html).not.toContain("Upload image");
  });

  it("needs a name before it can draw anyone", () => {
    expect(view({ kind: "idle" }, undefined, " ")).toMatch(/<button[^>]*disabled[^>]*title="Give the agent a name first"/);
  });
});
