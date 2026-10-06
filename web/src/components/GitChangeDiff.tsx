// What a Codex file change did, read back from git.
//
// Codex's `file_change` item names the files it wrote and nothing else, so the
// card has no change of its own to draw. What git sees in the file NOW is the
// next best thing, and it is labelled as exactly that: it is the file against
// HEAD, which can include edits made after this one, and is empty once the
// change has been committed.
//
// Asked for only when the card is opened, one file at a time. The bridge is
// imported then too, so a card that is never opened — and every test that
// renders one — does not start the socket by importing this.
import { useEffect, useState } from "react";
import { unifiedDiff, type FileDiff } from "../lib/diff";
import { DiffView } from "./DiffView";

type ChangedFile = { path: string; old_path: string; untracked: boolean };
type RepoChanges = { root: string; files: ChangedFile[] };
type GitDiff = { text: string; binary: boolean; too_large: boolean };

const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const dirOf = (path: string) => slash(path).replace(/\/[^/]*$/, "") || "/";

type State =
  | { kind: "loading" }
  | { kind: "clean" }
  | { kind: "note"; text: string }
  | { kind: "diff"; diff: FileDiff };

export function GitChangeDiff({ path }: { path: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    (async () => {
      const { bridge } = await import("../lib/bridge");
      const target = slash(path);
      const repos = await bridge.invoke<RepoChanges[]>("git_changed_files", { paths: [dirOf(path)] }) ?? [];
      for (const repo of repos) {
        const file = repo.files.find((f) => `${slash(repo.root)}/${f.path}` === target);
        if (!file) continue;
        const raw = await bridge.invoke<GitDiff>("git_file_diff", {
          root: repo.root, file: file.path, untracked: file.untracked, oldPath: file.old_path ?? "",
        });
        if (raw.binary) return { kind: "note", text: "Binary file — no text to show." } as const;
        if (raw.too_large) return { kind: "note", text: "This diff is too big to show here." } as const;
        return { kind: "diff", diff: unifiedDiff(path, raw.text) } as const;
      }
      return { kind: "clean" } as const;
    })().then((next) => live && setState(next))
      .catch((err) => live && setState({ kind: "note", text: String((err as Error)?.message ?? err) }));
    return () => { live = false; };
  }, [path]);

  if (state.kind === "loading") return <div className="tool-note">Reading the change from git…</div>;
  if (state.kind === "clean") return <div className="tool-note">No uncommitted change in this file now — committed, reverted, or outside a repository.</div>;
  if (state.kind === "note") return <div className="tool-note">{state.text}</div>;
  return <DiffView diff={state.diff} />;
}
