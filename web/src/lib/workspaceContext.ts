export type WorkspacePeer = {
  id: string;
  title: string;
  /** Observed conversation cwd only; project defaults are not evidence. */
  cwd?: string;
  busy: boolean;
  /** Whether this conversation currently owns a live provider process. */
  live: boolean;
};

export type WorkspaceGitStatus = {
  path: string;
  repo_root: string;
  branch: string;
  is_repo: boolean;
};

export type WorkspaceIdentity =
  | { kind: "loading" }
  | { kind: "unknown" }
  | { kind: "not-repo" }
  | { kind: "repo"; branch: string; root: string };

// Only remove trailing separators. Resolving symlinks, '..', or case locally
// would claim an identity we cannot verify against the server filesystem.
export function observedDirectory(path?: string): string | undefined {
  if (!path || !path.startsWith("/")) return undefined;
  return path.replace(/\/+$/, "") || "/";
}

export function sharedWorkspacePeers(chatId: string, cwd: string | undefined, peers: WorkspacePeer[]) {
  const directory = observedDirectory(cwd);
  if (!directory) return [];
  const unique = new Map<string, WorkspacePeer>();
  for (const peer of peers) {
    if (peer.id !== chatId && peer.busy && peer.live && observedDirectory(peer.cwd) === directory) {
      unique.set(peer.id, peer);
    }
  }
  return [...unique.values()];
}

export function workspaceIdentity(path: string, statuses: WorkspaceGitStatus[]): WorkspaceIdentity {
  const status = statuses.find((item) => item.path === path);
  if (!status) return { kind: "unknown" };
  // Backend is_repo=false includes failed Git reads, so the UI says Git was
  // not detected, rather than claiming definitively that this is not a repo.
  if (!status.is_repo) return { kind: "not-repo" };
  if (!status.repo_root) return { kind: "unknown" };
  return { kind: "repo", branch: status.branch, root: status.repo_root };
}

/** Invalidate both older refreshes and requests from an unmounted/path-switched view. */
export function createWorkspaceLookup(
  read: () => Promise<WorkspaceGitStatus[]>,
  publish: (identity: WorkspaceIdentity) => void,
  path: string,
) {
  let revision = 0;
  let disposed = false;
  return {
    async refresh() {
      if (disposed) return;
      const request = ++revision;
      publish({ kind: "loading" });
      try {
        const statuses = await read();
        if (!disposed && request === revision) publish(workspaceIdentity(path, statuses));
      } catch {
        if (!disposed && request === revision) publish({ kind: "unknown" });
      }
    },
    dispose() {
      disposed = true;
      revision++;
    },
  };
}
