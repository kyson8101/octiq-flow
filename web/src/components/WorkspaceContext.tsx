import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import {
  createWorkspaceLookup,
  observedDirectory,
  sharedWorkspacePeers,
  type WorkspaceGitStatus,
  type WorkspaceIdentity,
  type WorkspacePeer,
} from "../lib/workspaceContext";
import "./WorkspaceContext.css";

type WorkspaceContextProps = {
  chatId: string;
  cwd?: string;
  fallbackPath?: string;
  connected: boolean;
  peers: WorkspacePeer[];
};

export function WorkspaceContext(props: WorkspaceContextProps) {
  const path = observedDirectory(props.cwd) ?? observedDirectory(props.fallbackPath);
  const [result, setResult] = useState<{ path: string; identity: WorkspaceIdentity }>();
  useEffect(() => {
    if (!path || !props.connected) return;
    const lookup = createWorkspaceLookup(
      () => bridge.invoke<WorkspaceGitStatus[]>("git_status_summary", { paths: [path] }),
      (identity) => setResult({ path, identity }),
      path,
    );
    const refresh = () => { void lookup.refresh(); };
    refresh();
    const off = bridge.on("git-status-changed", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("octiq-git-changed", refresh);
    return () => {
      lookup.dispose();
      off();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("octiq-git-changed", refresh);
    };
  }, [path, props.connected]);
  const identity: WorkspaceIdentity = !props.connected || !path
    ? { kind: "unknown" }
    : result?.path === path ? result.identity : { kind: "loading" };
  return <WorkspaceContextView {...props} identity={identity} />;
}

/** Pure view so branch/worktree evidence can be verified without a live backend. */
export function WorkspaceContextView({
  chatId, cwd, fallbackPath, connected, peers, identity,
}: WorkspaceContextProps & { identity: WorkspaceIdentity }) {
  const observed = observedDirectory(cwd);
  const path = observed ?? observedDirectory(fallbackPath);
  const shared = connected ? sharedWorkspacePeers(chatId, observed, peers) : [];
  return (
    <details className="workspace-context">
      <summary>
        <span>Workspace</span>
        <span className="workspace-context-summary" title={path}>
          {identity.kind === "repo" ? identity.branch || "Detached HEAD / branch unnamed" : path ?? "Directory unknown"}
        </span>
        {shared.length > 0 && <span className="workspace-context-warning">{shared.length} other active {shared.length === 1 ? "chat" : "chats"}</span>}
      </summary>
      <dl>
        <dt>{observed ? "Conversation directory" : "Project directory (fallback)"}</dt>
        <dd>{path ?? "Unknown"}</dd>
        <dt>Git identity</dt>
        <dd>{identity.kind === "loading" ? "Checking…" : identity.kind === "unknown" ? "Unknown" : identity.kind === "not-repo" ? "Git repository not detected" : identity.branch || "Detached HEAD / branch unnamed"}</dd>
        {identity.kind === "repo" && <><dt>Worktree root</dt><dd>{identity.root}</dd></>}
      </dl>
      {!observed && <p>The conversation working directory has not been recorded.</p>}
      {!connected && <p>Reconnect to refresh workspace identity and active chats.</p>}
      {shared.length > 0 && (
        <p className="workspace-context-warning">
          Active in this observed directory: {shared.map((peer) => peer.title || peer.id).join(", ")}.
          {" "}Shared directory activity does not confirm a file conflict.
        </p>
      )}
      <p>Git changes describe the repository. They are not attributed to this conversation.</p>
    </details>
  );
}
