import { useEffect, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import type { Workspace } from "./appHelpers";
import {
  branchesByProject,
  projectGitPaths,
  projectPrimaryPaths,
  PROJECT_GIT_CHANGED_EVENT,
} from "./projectGit";
import type { WorkspaceGitStatus } from "./workspaceContext";
import { singleFlight } from "./singleFlight";

export function useProjectBranches(
  conn: ConnectionState,
  workspaces: Workspace[],
  shelved: Workspace[],
): Record<string, string> {
  const [projectBranches, setProjectBranches] = useState<Record<string, string>>({});

  /** Keep one Git watcher for the whole project list and annotate each chat's
   *  project with the branch checked out at its primary path. The watcher is
   *  server-owned, so a reconnect installs it again. */
  useEffect(() => {
    if (conn !== "open") return;
    const projects = [...workspaces, ...shelved];
    const watchedPaths = projectGitPaths(projects);
    const primaryPaths = projectPrimaryPaths(projects);
    let live = true;

    // One read at a time: `git-status-changed` can arrive every second, and a
    // read of every project can take longer than that.
    const read = singleFlight(async () => {
      if (primaryPaths.length === 0) {
        setProjectBranches({});
        return;
      }
      await bridge
        .invoke<WorkspaceGitStatus[]>("git_status_summary", { paths: primaryPaths })
        .then((statuses) => {
          if (live) setProjectBranches(branchesByProject(projects, statuses ?? []));
        })
        .catch(() => {
          if (live) setProjectBranches({});
        });
    });
    const refresh = () => { read(); };

    // Replaces the server's previous watcher with the complete project set.
    // A project can contain additional repositories, so watch every folder even
    // though the sidebar label itself comes only from the primary path.
    bridge.invoke("git_watch_paths", { paths: watchedPaths }).catch(() => {});
    read();
    window.addEventListener("focus", refresh);
    const offWatch = bridge.on("git-status-changed", () => {
      window.dispatchEvent(new CustomEvent(PROJECT_GIT_CHANGED_EVENT));
      read();
    });

    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      offWatch();
    };
  }, [conn, workspaces, shelved]);

  return projectBranches;
}
