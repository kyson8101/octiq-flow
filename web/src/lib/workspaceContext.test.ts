import { describe, expect, it, vi } from "vitest";
import { createWorkspaceLookup, sharedWorkspacePeers, workspaceIdentity, type WorkspaceGitStatus, type WorkspacePeer } from "./workspaceContext";

const status = (path: string, branch = "main"): WorkspaceGitStatus => ({ path, repo_root: path, branch, is_repo: true });
const peer = (id: string, cwd?: string, busy = true, live = true): WorkspacePeer => ({ id, title: id, cwd, busy, live });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("observed concurrent workspace", () => {
  it("includes live busy peers and excludes the current and idle chats", () => {
    const peers = [peer("self", "/repo"), peer("other", "/repo/"), peer("idle", "/repo", false), peer("stale", "/repo", true, false)];
    expect(sharedWorkspacePeers("self", "/repo", peers).map((item) => item.id)).toEqual(["other"]);
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
  it("answers refreshes made during a read with one read after it, not parallel ones", async () => {
    const old = deferred<WorkspaceGitStatus[]>();
    const newer = deferred<WorkspaceGitStatus[]>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const publish = vi.fn();
    const lookup = createWorkspaceLookup(read, publish, "/repo");
    const first = lookup.refresh();
    await Promise.resolve();
    const burst = [lookup.refresh(), lookup.refresh(), lookup.refresh()];
    expect(read).toHaveBeenCalledTimes(1);
    old.resolve([status("/repo", "old")]);
    await first;
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    newer.resolve([status("/repo", "new")]);
    await Promise.all(burst);
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({ kind: "repo", branch: "new", root: "/repo" });
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
