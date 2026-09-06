import { describe, expect, it, vi } from "vitest";
import { createWorkspaceLookup, isWorkspaceBusy, sharedWorkspacePeers, workspaceIdentity, type WorkspaceGitStatus, type WorkspacePeer } from "./workspaceContext";

const status = (path: string, branch = "main"): WorkspaceGitStatus => ({ path, repo_root: path, branch, is_repo: true });
const peer = (id: string, cwd?: string, busy = true, live = true): WorkspacePeer => ({ id, title: id, cwd, busy, live });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("observed concurrent workspace", () => {
  it("includes live busy peers including room identities, excludes current and idle chats", () => {
    const peers = [peer("self", "/repo"), peer("room", "/repo/"), peer("idle", "/repo", false), peer("stale", "/repo", true, false)];
    expect(sharedWorkspacePeers("self", "/repo", peers).map((item) => item.id)).toEqual(["room"]);
  });
  it("does not equate separate worktrees, unknown paths, symlinks or directory prefixes", () => {
    const peers = [peer("separate", "/repo-other"), peer("unknown"), peer("child", "/repo/sub"), peer("relative", "repo")];
    expect(sharedWorkspacePeers("self", "/repo", peers)).toEqual([]);
    expect(sharedWorkspacePeers("self", undefined, [peer("unknown")])).toEqual([]);
  });
  it("matches Git identity by echoed path and preserves observed worktree root", () => {
    expect(workspaceIdentity("/linked", [status("/repo"), status("/linked", "feature")])).toEqual({ kind: "repo", branch: "feature", root: "/linked" });
    expect(workspaceIdentity("/missing", [status("/repo")])).toEqual({ kind: "unknown" });
  });
});

describe("workspace lookup race handling", () => {
  it("does not allow a slower previous request to replace newer branch data", async () => {
    const old = deferred<WorkspaceGitStatus[]>();
    const newer = deferred<WorkspaceGitStatus[]>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const publish = vi.fn();
    const lookup = createWorkspaceLookup(read, publish, "/repo");
    const first = lookup.refresh();
    const second = lookup.refresh();
    newer.resolve([status("/repo", "new")]);
    await second;
    old.resolve([status("/repo", "old")]);
    await first;
    expect(publish).toHaveBeenLastCalledWith({ kind: "repo", branch: "new", root: "/repo" });
    expect(publish).toHaveBeenCalledTimes(3);
  });
  it("ignores responses and errors after path switch or unmount", async () => {
    for (const error of [false, true]) {
      const request = deferred<WorkspaceGitStatus[]>();
      const publish = vi.fn();
      const lookup = createWorkspaceLookup(() => request.promise, publish, "/old");
      const pending = lookup.refresh();
      lookup.dispose();
      if (error) request.reject(new Error("offline"));
      else request.resolve([status("/old")]);
      await pending;
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });
  it("labels a failed current read unknown", async () => {
    const publish = vi.fn();
    const lookup = createWorkspaceLookup(async () => { throw new Error("unavailable"); }, publish, "/repo");
    await lookup.refresh();
    expect(publish).toHaveBeenLastCalledWith({ kind: "unknown" });
  });
});


describe("room workspace activity", () => {
  const speaker = { id: "seat-one", name: "Seat", agent: "claude" };
  const room = (streaming: boolean): Pick<import("./chat").ChatState, "busy" | "messages"> => ({ busy: false, messages: [{ id: "message", role: "assistant", streaming, speaker, blocks: [] }] });
  const running = new Set(["room-seat-seat-one"]);
  it("reads busy seat evidence from the room transcript rather than a nonexistent seat chat", () => {
    expect(isWorkspaceBusy("room", room(true), running, false)).toBe(true);
    expect(isWorkspaceBusy("room", room(false), running, false)).toBe(false);
    expect(isWorkspaceBusy("room", room(true), new Set(), false)).toBe(false);
    expect(isWorkspaceBusy("other-room", room(true), running, false)).toBe(false);
  });
  it("recognizes a live seat running a tool after its message stopped streaming", () => {
    const chat = room(false);
    chat.messages[0].blocks = [{ kind: "tool", id: "tool", name: "Bash", args: {}, argsJson: "{}", state: "running" }];
    expect(isWorkspaceBusy("room", chat, running, false)).toBe(true);
    chat.messages[0].blocks = chat.messages[0].blocks.map((block) =>
      block.kind === "tool" ? { ...block, state: "done" } : block);
    expect(isWorkspaceBusy("room", chat, running, false)).toBe(false);
  });
  it("includes active rounds across handover gaps and ordinary host turns", () => {
    expect(isWorkspaceBusy("room", room(false), new Set(), true)).toBe(true);
    expect(isWorkspaceBusy("chat", { busy: true, messages: [] }, new Set(["chat"]), false)).toBe(true);
    expect(isWorkspaceBusy("unknown", undefined, new Set(), false)).toBe(false);
  });
});
