// The project's git state, docked down the right-hand side.
//
// This is the v1 desktop "Git changes" panel (src/gitdiff.js) brought to the web
// client, minus the two-pane diff layout that only ever worked on a wide window.
// Everything a repo needs day to day is here: what changed, which branch you are
// on, switch to another, pull, push, and commit the files you tick. Doing that
// from a phone is the point of v2 — a build broke, you are not at the desk, and
// the fix is a one-line commit.
//
// It is a COLUMN, not an overlay. Opening it takes width from the chat and
// closing it gives the width back; nothing is ever drawn on top of the
// conversation, so you can read a reply and stage a file at the same time. That
// is also why there is no scrim and no drop shadow: both would say "this hovers
// above the page", which it does not. Its left edge is a drag handle, and the
// width it is dragged to is remembered.
//
// The phone is the deliberate exception. Two columns do not fit in 390px — a
// 300px panel would leave the chat at 90px, which helps nobody — so under 700px
// (see the media query in styles.css) the panel takes the whole body area and IS
// the view for as long as it is open. The chat stays mounted behind it (scroll
// position and all) and comes straight back when the panel closes.
//
// Two things about the backend are worth knowing before reading further:
//
//   * **The wire shape is snake_case.** git.rs derives plain `Serialize` with no
//     `rename_all`, so what arrives is `repo_root`, `has_upstream`, `old_path`,
//     `too_large` — NOT the camelCase the rest of the app's commands use. The
//     arguments going the other way are camelCase (`oldPath`), because
//     dispatch.rs names those itself. Mixed, and checked against the running
//     server rather than guessed.
//   * **Git state is now pushed at us.** `git_watch_paths` points the backend's
//     fs watcher (git_watch.rs) at the project's folders, and its debounced
//     `git-status-changed` event comes back over the same socket the chat uses.
//     Anything that moves `git status` — an agent switching branch mid-turn, a
//     commit in a terminal, an edit from another machine — repaints the toolbar
//     without the window having to be re-focused. The older refreshes are still
//     there as a floor: on open, on focus, after every write, and on Refresh.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";

/** One changed file in a repo (git.rs `ChangedFile`). */
type ChangedFile = {
  path: string;
  /** The OLD name of a rename, empty otherwise. Both halves have to go into the
   *  same commit or the rename splits across two. */
  old_path: string;
  /** What to show: the path, or "old → new" for a rename. */
  display: string;
  /** "modified" | "added" | "deleted" | "renamed" | "untracked" */
  status: string;
  untracked: boolean;
  added: number;
  removed: number;
  binary: boolean;
};

/** One repo's uncommitted changes (git.rs `RepoChanges`). */
type RepoChanges = {
  root: string;
  branch: string;
  files: ChangedFile[];
  ahead: number;
  behind: number;
  has_upstream: boolean;
};

/** Per-PATH summary (git.rs `GitStatus`). Several of a project's folders can sit
 *  in one repo, which is what `repo_root` is for — count a repo once. */
type GitStatus = {
  path: string;
  repo_root: string;
  branch: string;
  changed: number;
  insertions: number;
  deletions: number;
  ahead: number;
  behind: number;
  is_repo: boolean;
};

type BranchList = { is_repo: boolean; current: string; branches: string[] };
type FileDiff = { text: string; binary: boolean; too_large: boolean };
type GitOpResult = { summary: string; output: string };

/** The bit of a project this panel needs: its folders and something to call it. */
export type GitProject = { id: string; name: string; primary_path?: string; paths?: string[] };

/** Fired on `window` after any git write succeeds. The toolbar button's badge is
 *  rendered somewhere else entirely, and this is how it learns to re-count
 *  without the two halves having to share a store. */
const CHANGED_EVENT = "octiq-git-changed";

/** What the file list says at a glance, and the tint it says it in. */
const STATUS_MARK: Record<string, { letter: string; cls: string }> = {
  added: { letter: "A", cls: "is-add" },
  deleted: { letter: "D", cls: "is-del" },
  renamed: { letter: "R", cls: "is-ren" },
  untracked: { letter: "U", cls: "is-new" },
};
const MODIFIED = { letter: "M", cls: "is-mod" };

/** How Pull brings remote commits in. Rebase first: it is the one that does not
 *  quietly write a merge commit nobody asked for. */
const PULL_MODES = ["rebase", "merge", "ff-only"] as const;
type PullMode = (typeof PULL_MODES)[number];

const PULL_KEY = "octiq.v2.gitPullMode";
const WIDTH_KEY = "octiq.v2.gitWidth";

const DEFAULT_W = 380;
const MIN_W = 280;
const MAX_W = 680;
/** Room the chat keeps whatever the panel is dragged to. A column you can drag
 *  over the thing it sits beside is a column you can lose the chat behind. */
const CHAT_MIN_W = 340;

/** Header lines of a unified diff that say nothing a reader wants here — the
 *  file name is already at the top of the row the diff hangs under. */
const DIFF_NOISE =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files )/;

/** The project's folders, primary first — the same set the desktop panel sends.
 *  Blank entries are dropped: an empty string resolves to the process cwd on the
 *  server, which would report a repo that has nothing to do with the project.
 *
 *  Joined into one string so the memo that uses it keys on the PATHS rather than
 *  on the project object, which App rebuilds every time it re-reads the list. */
function folderKeyOf(project: GitProject | null): string {
  if (!project) return "";
  return [project.primary_path ?? "", ...(project.paths ?? [])]
    .filter((p) => p.trim() !== "")
    .join("\n");
}

/** One repo per `repo_root`, so a project holding a repo AND a folder inside it
 *  does not count the same changes twice. */
function byRepo(list: GitStatus[]): GitStatus[] {
  const seen = new Map<string, GitStatus>();
  for (const s of list) {
    if (!s.is_repo || !s.repo_root) continue;
    if (!seen.has(s.repo_root)) seen.set(s.repo_root, s);
  }
  return [...seen.values()];
}

/** Split a path so the folder can be dimmed and the filename kept legible. */
function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** A width the chat can live with, whatever was dragged or stored.
 *
 *  The project sidebar stops being an off-canvas drawer and becomes a 260px
 *  column of its own at 860px (see styles.css), and that column comes out of the
 *  same row — so above that width the chat is competing with two panels, not
 *  one, and the cap has to know it. */
function clampWidth(px: number): number {
  const sidebar = window.innerWidth >= 860 ? 260 : 0;
  const max = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - sidebar - CHAT_MIN_W));
  return Math.round(Math.min(max, Math.max(MIN_W, px)));
}

// ---------------------------------------------------------------------------
// The toolbar button
// ---------------------------------------------------------------------------

/** Open / close the panel, and say whether it is worth opening.
 *
 *  It reads `git_status_summary` rather than the full changed-file list: all it
 *  needs is a count and a branch name, and the panel beside it is what the list
 *  is for. */
export function GitButton({
  project,
  open,
  onToggle,
}: {
  project: GitProject | null;
  open: boolean;
  onToggle: () => void;
}) {
  const [summary, setSummary] = useState<GitStatus[]>([]);
  /* The repo the CHAT is actually in. A project can group several repos, and
   * until now the branch name only appeared when there happened to be exactly
   * one — so on a two-repo project the button said "3" and nothing about where
   * you were. The session runs in the project's primary path, so that is the
   * branch worth naming, and naming it is what makes a worktree tell you it is
   * a worktree. */
  const [sessionRepo, setSessionRepo] = useState<GitStatus | null>(null);
  const primaryPath = project?.primary_path ?? "";
  const folderKey = folderKeyOf(project);
  const folders = useMemo(() => (folderKey ? folderKey.split("\n") : []), [folderKey]);

  useEffect(() => {
    if (folders.length === 0) {
      setSummary([]);
      return;
    }
    let live = true;
    const read = () => {
      bridge
        .invoke<GitStatus[]>("git_status_summary", { paths: folders })
        .then((list) => {
          if (!live) return;
          const all = list ?? [];
          setSummary(byRepo(all));
          // Matched on the folder asked about, not on the repo root: two of a
          // project's folders can share a repo, and the one the chat starts in
          // is the one that answers "where am I".
          setSessionRepo(all.find((s) => s.is_repo && s.path === primaryPath) ?? null);
        })
        .catch(() => {
          if (live) setSummary([]);
        });
    };
    // The usual reason a count is wrong is that the work happened somewhere this
    // tab cannot see — a terminal, another machine, or the agent's own shell.
    window.addEventListener("focus", read);
    window.addEventListener(CHANGED_EVENT, read);

    // Live updates. The watcher lives in the SERVER's memory, so it is installed
    // per connection rather than once: a reconnect or a restarted service has
    // no watcher at all, and a read on every fresh socket also catches whatever
    // changed while we were away.
    const offState = bridge.onState((state) => {
      if (state !== "open") return;
      bridge.invoke("git_watch_paths", { paths: folders }).catch(() => {});
      read();
    });
    // One refresh path, not two: the backend event is turned into the same
    // window event a write already fires, so the button and the open panel both
    // refresh from it and neither has to know where it came from.
    const offWatch = bridge.on("git-status-changed", () => {
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
    });

    return () => {
      live = false;
      window.removeEventListener("focus", read);
      window.removeEventListener(CHANGED_EVENT, read);
      offState();
      offWatch();
    };
  }, [folders, primaryPath]);

  const changed = summary.reduce((n, s) => n + s.changed, 0);
  const ahead = summary.reduce((n, s) => n + s.ahead, 0);

  /* One chip per repo, because a project that spans several repos has several
   * answers to "what branch am I on" and merging them into one number threw
   * away the only part worth knowing. Real projects here hold up to four.
   *
   * The chat's own repo leads, since that is the one the agent is working in;
   * the rest follow in the order the project lists them. */
  const chips = useMemo(() => {
    if (summary.length === 0) return [];
    const rest = summary.filter((r) => r.repo_root !== sessionRepo?.repo_root);
    return sessionRepo ? [sessionRepo, ...rest] : rest;
  }, [summary, sessionRepo]);

  return (
    <button
      className={`gitp-toggle ${open ? "is-on" : ""}`}
      type="button"
      aria-expanded={open}
      // The full picture, since the chips are truncated and a phone shows only
      // the first. Each repo on its own line, named, so nothing here is a
      // number you cannot attribute.
      title={
        project
          ? [
              `Git — ${project.name}`,
              ...chips.map((r, i) => {
                const name = r.repo_root.split("/").pop() ?? r.repo_root;
                const state = r.changed > 0 ? `${r.changed} changed` : "clean";
                return `${name} · ${r.branch || "(detached)"} · ${state}${
                  i === 0 && sessionRepo ? " — this chat" : ""
                }`;
              }),
            ].join("\n")
          : "Git"
      }
      onClick={onToggle}
    >
      <BranchIcon />

      {chips.map((repo, i) => (
        <span
          key={repo.repo_root}
          // `is-first` is marked here rather than matched with :first-child,
          // because the button's first child is the icon — no chip is ever the
          // first child, and a phone rule keyed on that hid every one of them.
          className={`gitp-chip ${i === 0 ? "is-first" : ""} ${
            i === 0 && sessionRepo ? "is-here" : ""
          }`}
        >
          {/* Named only when there is more than one, where a branch on its own
              cannot say which repo it belongs to. */}
          {chips.length > 1 && (
            <span className="gitp-chip-repo">
              <bdi>{repo.repo_root.split("/").pop()}</bdi>
            </span>
          )}
          {/* The <bdi> is load-bearing. The span is RTL so the ellipsis lands on
              the LEFT — branch names share their prefix and differ at the end —
              but RTL alone also reorders the text, drawing `feature/a` as
              `a/feature`. <bdi> isolates the run inside the box. */}
          {repo.branch && (
            <span className="gitp-toggle-branch">
              <bdi>{repo.branch}</bdi>
            </span>
          )}
          {repo.changed > 0 && <span className="gitp-badge">{repo.changed}</span>}
          {repo.changed === 0 && repo.ahead > 0 && (
            <span className="gitp-badge is-ahead">↑{repo.ahead}</span>
          )}
        </span>
      ))}

      {/* A phone has room for the chat's own repo and nothing else, so the ones
          the stylesheet hides are counted rather than silently dropped. */}
      {chips.length > 1 && <span className="gitp-more">+{chips.length - 1}</span>}

      {/* No repo at all: the old single badge still says whether there is work. */}
      {chips.length === 0 && changed > 0 && <span className="gitp-badge">{changed}</span>}
      {chips.length === 0 && changed === 0 && ahead > 0 && (
        <span className="gitp-badge is-ahead">↑{ahead}</span>
      )}
    </button>
  );
}

export function GitPanel({
  project,
  open,
  onClose,
}: {
  project: GitProject | null;
  /** False while it is sliding away. The parent keeps this mounted until the
   *  slide finishes, so closing looks like the reverse of opening rather than
   *  the panel simply vanishing. */
  open: boolean;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<RepoChanges[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  /** Which files go into the next commit, per repo root. */
  const [checked, setChecked] = useState<Record<string, Set<string>>>({});
  const [message, setMessage] = useState("");
  const [op, setOp] = useState<{ kind: "busy" | "ok" | "err"; text: string; detail: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** The width the user ASKED for, unclamped. What is actually applied is
   *  `width` below. Keeping the two apart is what lets a narrow window squeeze
   *  the panel and a wide one give the chosen width straight back — clamping the
   *  stored value instead would quietly forget it the first time the window got
   *  small. */
  const [chosen, setChosen] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_W);
  const [, onViewportChange] = useState(0);
  /* Mounted one frame in its off-screen position before it is told to open, so
   * the phone rule has something to transition FROM. Mounting straight into the
   * open position is already the finished state, and CSS has nothing to animate
   * — the panel would appear instantly, which is the thing this exists to
   * avoid. Off the phone this class changes nothing; the panel is a column. */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const [pullMode, setPullMode] = useState<PullMode>(() => {
    const saved = localStorage.getItem(PULL_KEY);
    return PULL_MODES.includes(saved as PullMode) ? (saved as PullMode) : "rebase";
  });

  const folderKey = folderKeyOf(project);
  const folders = useMemo(() => (folderKey ? folderKey.split("\n") : []), [folderKey]);
  const projectId = project?.id ?? null;

  /** What the previous load showed, per repo. It is how "a file the user
   *  unticked" is told apart from "a file that was not there before" — see the
   *  sync in `load`. A ref, not state: nothing renders from it. */
  const known = useRef<Record<string, Set<string>>>({});
  /** Guards against two git commands overlapping in one repo, which is a fight
   *  over `.git/index.lock` and a failure that reads like a bug in the panel. A
   *  ref as well as state, so a second click in the same tick still loses. */
  const busyRef = useRef(false);

  /** Every repo in the project, its branch, and what changed in it. */
  const load = useCallback(async () => {
    if (folders.length === 0) {
      setRepos([]);
      return;
    }
    setLoading(true);
    let list: RepoChanges[];
    try {
      list = (await bridge.invoke<RepoChanges[]>("git_changed_files", { paths: folders })) ?? [];
      setListError(null);
    } catch (err) {
      setRepos(null);
      setListError(String((err as Error).message ?? err));
      setLoading(false);
      return;
    }
    setRepos(list);
    setLoading(false);

    // Carry the ticks across the reload: a file the user unticked stays
    // unticked, one that was not in the previous list starts ticked, and one
    // that has just been committed drops out with its row.
    const before = known.current;
    const after: Record<string, Set<string>> = {};
    for (const repo of list) after[repo.root] = new Set((repo.files ?? []).map((f) => f.path));
    known.current = after;
    setChecked((prev) => {
      const next: Record<string, Set<string>> = {};
      for (const repo of list) {
        const wasChecked = prev[repo.root];
        const wasKnown = before[repo.root];
        const on = new Set<string>();
        for (const file of repo.files ?? []) {
          if (!wasKnown?.has(file.path) || wasChecked?.has(file.path)) on.add(file.path);
        }
        next[repo.root] = on;
      }
      return next;
    });

    // The branch lists are one git read per repo and only the switch dropdown
    // wants them, so the file list never waits on them. A repo whose read fails
    // simply keeps its branch as a plain label — the name is already on screen,
    // so there is nothing to report.
    const pairs = await Promise.all(
      list.map((repo) =>
        bridge
          .invoke<BranchList>("git_local_branches", { path: repo.root })
          .then((info) => (info?.is_repo ? ([repo.root, info.branches ?? []] as const) : null))
          .catch(() => null),
      ),
    );
    setBranches(Object.fromEntries(pairs.filter((p): p is readonly [string, string[]] => !!p)));
  }, [folders]);

  // A different project is a different panel. The ticks, the half-typed message
  // and the last command's output all belong to the project they were made in,
  // and the old repo list goes too — showing it while the new one loads would be
  // a list of files that are not there.
  //
  // Deliberately keyed on the project ALONE. Folding this into the load effect
  // below would wipe a commit message every time App re-read the project list.
  useEffect(() => {
    known.current = {};
    setChecked({});
    setMessage("");
    setOp(null);
    setRepos(null);
    setBranches({});
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The same refresh the toolbar button takes: the button turns the backend's
  // `git-status-changed` into this window event, so an agent that switches
  // branch or commits mid-turn repaints the open panel too — branch name, file
  // list and all — instead of it going stale until Refresh is pressed.
  //
  // Skipped while one of our own git commands is running: that command reloads
  // when it finishes, and its writes to `.git` are exactly what set the event
  // off in the first place.
  useEffect(() => {
    const onChanged = () => {
      if (busyRef.current) return;
      void load();
    };
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANGED_EVENT, onChanged);
  }, [load]);

  // Shrinking the window must not leave the chat with nothing, so the applied
  // width is recomputed against the new viewport. Nothing here reads the tick —
  // it exists to make the render below run again.
  useEffect(() => {
    const onResize = () => onViewportChange((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const width = clampWidth(chosen);

  /** Drag the left edge. Pointer events rather than mouse ones so the handle
   *  works from a trackpad, a pen and a touch screen with one code path, and the
   *  capture keeps the drag alive when the pointer outruns the 7px strip. */
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = width;
      let latest = startW;

      const move = (ev: PointerEvent) => {
        // The panel is on the RIGHT, so dragging left makes it wider.
        latest = clampWidth(startW - (ev.clientX - startX));
        setChosen(latest);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try {
          localStorage.setItem(WIDTH_KEY, String(latest));
        } catch {
          /* storage blocked: the width lasts for this session */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [width],
  );

  /** Run one git write with the whole panel locked, then reload. The reload is
   *  what makes the ahead/behind counts and the file list true again — a commit
   *  that leaves its own files on screen looks like it did not happen. */
  const runOp = useCallback(
    async (busyText: string, fn: () => Promise<GitOpResult>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setOp({ kind: "busy", text: busyText, detail: "" });
      let ok = false;
      try {
        const res = await fn();
        setOp({ kind: "ok", text: res?.summary || "Done.", detail: res?.output ?? "" });
        ok = true;
      } catch (err) {
        // git's own words. Its first line is the headline and the rest is the
        // detail; rewriting either would throw away the one sentence that says
        // what actually stopped it.
        const text = String((err as Error).message ?? err);
        const [first, ...rest] = text.split("\n");
        setOp({ kind: "err", text: first || "That did not work.", detail: rest.join("\n").trim() });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      await load();
      if (ok) window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
    },
    [load],
  );

  const setTick = useCallback((root: string, path: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev[root] ?? []);
      if (on) next.add(path);
      else next.delete(path);
      return { ...prev, [root]: next };
    });
  }, []);

  const setAllTicks = useCallback((repo: RepoChanges, on: boolean) => {
    setChecked((prev) => ({
      ...prev,
      [repo.root]: on ? new Set((repo.files ?? []).map((f) => f.path)) : new Set<string>(),
    }));
  }, []);

  /** The repos with something ticked, and what to send for each. A rename
   *  contributes BOTH its paths so the removal and the addition land together. */
  const targets = useMemo(() => {
    const out: { repo: RepoChanges; files: ChangedFile[]; paths: string[] }[] = [];
    for (const repo of repos ?? []) {
      const on = checked[repo.root];
      const files = (repo.files ?? []).filter((f) => on?.has(f.path));
      if (files.length === 0) continue;
      const paths: string[] = [];
      for (const file of files) {
        paths.push(file.path);
        if (file.old_path) paths.push(file.old_path);
      }
      out.push({ repo, files, paths });
    }
    return out;
  }, [repos, checked]);

  const tickedCount = targets.reduce((n, t) => n + t.files.length, 0);

  /** Commit every repo that has something ticked, all under the one message. One
   *  commit per repo, because a project that holds a frontend and a backend repo
   *  side by side is exactly why this groups by repo at all. */
  const commit = useCallback(() => {
    const text = message.trim();
    if (targets.length === 0) return;
    if (!text) {
      setOp({ kind: "err", text: "Enter a commit message.", detail: "" });
      return;
    }
    const total = targets.reduce((n, t) => n + t.files.length, 0);
    void runOp(`Committing ${total} file${total === 1 ? "" : "s"}…`, async () => {
      const summaries: string[] = [];
      const outputs: string[] = [];
      for (const { repo, paths } of targets) {
        const label = baseName(repo.root);
        let res: GitOpResult;
        try {
          res = await bridge.invoke<GitOpResult>("git_commit", {
            root: repo.root,
            files: paths,
            message: text,
          });
        } catch (err) {
          // Name the repo when there are several, so a failure on the second
          // does not read as if nothing at all was committed.
          const detail = String((err as Error).message ?? err);
          throw new Error(targets.length > 1 ? `${label}: ${detail}` : detail);
        }
        summaries.push(targets.length > 1 ? `${label}: ${res.summary}` : res.summary);
        if (res.output) outputs.push(res.output);
      }
      setMessage("");
      return { summary: summaries.join(" · "), output: outputs.join("\n") };
    });
  }, [message, targets, runOp]);

  return (
    <>
      {/* Phone only (the stylesheet hides it otherwise): tapping beside the
          panel closes it, which is what every sheet on the device does. It sits
          UNDER the project drawer's own scrim so opening that over this still
          works. */}
      <div
        className={`gitp-scrim ${entered && open ? "is-open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
    <aside
      className={`gitp-panel ${entered && open ? "is-open" : ""}`}
      aria-label="Git"
      // A custom property, not `width`: the phone rule in styles.css has to be
      // able to drop the column width, and an inline `width` would outrank it.
      style={{ "--gitp-w": `${width}px` } as React.CSSProperties}
    >
      <div
        className="gitp-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the git panel"
        onPointerDown={startDrag}
      />

      <header className="gitp-head">
        <span className="gitp-title">Git</span>
        <span className="gitp-project">{project?.name ?? "No project"}</span>
        <button
          className="gitp-btn"
          type="button"
          onClick={() => void load()}
          disabled={busy || loading || folders.length === 0}
        >
          {loading ? "…" : "Refresh"}
        </button>
        <button className="gitp-close" type="button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      {op && (
        <div className={`gitp-op is-${op.kind}`} role={op.kind === "err" ? "alert" : undefined}>
          <div className="gitp-op-line">{op.text}</div>
          {op.detail && <pre className="gitp-op-detail">{op.detail}</pre>}
        </div>
      )}

      <div className="gitp-body">
        {folders.length === 0 && (
          <div className="gitp-note">This project has no folders to look at.</div>
        )}
        {listError && <div className="gitp-note is-err">{listError}</div>}
        {!listError && repos !== null && repos.length === 0 && folders.length > 0 && (
          <div className="gitp-note">No git repository in this project's folders.</div>
        )}
        {!listError && repos === null && loading && <div className="gitp-note">Reading git…</div>}

        {(repos ?? []).map((repo) => (
          <RepoSection
            key={repo.root}
            repo={repo}
            branches={branches[repo.root] ?? []}
            checked={checked[repo.root] ?? new Set<string>()}
            busy={busy}
            pullMode={pullMode}
            onPullMode={(mode) => {
              setPullMode(mode);
              localStorage.setItem(PULL_KEY, mode);
            }}
            onTick={setTick}
            onTickAll={setAllTicks}
            onSwitch={(branch) =>
              void runOp(`Switching ${baseName(repo.root)} to ${branch}…`, () =>
                bridge.invoke<GitOpResult>("git_switch_branch", { root: repo.root, branch }),
              )
            }
            onPull={() =>
              void runOp(`Pulling ${baseName(repo.root)}…`, () =>
                bridge.invoke<GitOpResult>("git_pull", { root: repo.root, mode: pullMode }),
              )
            }
            onPush={() =>
              void runOp(`Pushing ${baseName(repo.root)}…`, () =>
                bridge.invoke<GitOpResult>("git_push", { root: repo.root }),
              )
            }
          />
        ))}
      </div>

      {(repos?.length ?? 0) > 0 && (
        <div className="gitp-commit">
          <textarea
            className="gitp-msg"
            rows={2}
            placeholder="Commit message"
            value={message}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="gitp-btn is-primary"
            type="button"
            onClick={commit}
            disabled={busy || tickedCount === 0}
          >
            {tickedCount === 0
              ? "Commit"
              : targets.length > 1
                ? `Commit ${tickedCount} files in ${targets.length} repos`
                : `Commit ${tickedCount} file${tickedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </aside>
    </>
  );
}

/** One repo: its head (branch, sync counts, pull/push) and its changed files. */
function RepoSection({
  repo,
  branches,
  checked,
  busy,
  pullMode,
  onPullMode,
  onTick,
  onTickAll,
  onSwitch,
  onPull,
  onPush,
}: {
  repo: RepoChanges;
  branches: string[];
  checked: Set<string>;
  busy: boolean;
  pullMode: PullMode;
  onPullMode: (mode: PullMode) => void;
  onTick: (root: string, path: string, on: boolean) => void;
  onTickAll: (repo: RepoChanges, on: boolean) => void;
  onSwitch: (branch: string) => void;
  onPull: () => void;
  onPush: () => void;
}) {
  /** The file whose diff is open. One at a time: the column has room for the
   *  list or for a diff, not for six diffs interleaved with it. */
  const [openFile, setOpenFile] = useState<string | null>(null);
  const files = repo.files ?? [];
  const ticked = files.filter((f) => checked.has(f.path)).length;
  const allBox = useRef<HTMLInputElement>(null);

  // `indeterminate` is a property, not an attribute — React cannot set it from
  // JSX, so it goes on after every render that could change it.
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = ticked > 0 && ticked < files.length;
  }, [ticked, files.length]);

  // Which branch HEAD is on comes from `repo.branch`, read in the SAME call as
  // the file list — never from the branch list. Right after a switch the fresh
  // file list is on screen while the new branch list is still loading, and the
  // older of the two would name the branch you just left.
  const head = repo.branch || "(detached)";
  const others = branches.filter((b) => b !== head);

  return (
    <section className="gitp-repo">
      <header className="gitp-repo-head">
        {files.length > 0 && (
          <input
            ref={allBox}
            type="checkbox"
            className="gitp-check"
            checked={ticked === files.length}
            disabled={busy}
            title={ticked === files.length ? "Untick every file" : "Tick every file"}
            onChange={(e) => onTickAll(repo, e.target.checked)}
          />
        )}
        <span className="gitp-repo-name" title={repo.root}>
          {baseName(repo.root)}
        </span>

        {others.length === 0 ? (
          <span className="gitp-branch" title={`On ${head}`}>
            {head}
          </span>
        ) : (
          <select
            className="gitp-branch gitp-branch-pick"
            value={branches.includes(head) ? head : ""}
            disabled={busy}
            title={
              branches.includes(head)
                ? `On ${head} — pick a branch to switch to`
                : `HEAD is at ${head} — pick a branch to check out`
            }
            onChange={(e) => {
              const branch = e.target.value;
              if (branch && branch !== head) onSwitch(branch);
            }}
          >
            {/* A detached HEAD, and a new branch with no commit yet, is not in
                refs/heads. It gets an entry so the box can say where HEAD is,
                with an empty value: it is not somewhere to switch TO. */}
            {!branches.includes(head) && <option value="">{head}</option>}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}

        <span className="gitp-sync">
          {repo.behind > 0 && <span className="gitp-behind">↓{repo.behind}</span>}
          {repo.ahead > 0 && <span className="gitp-ahead">↑{repo.ahead}</span>}
        </span>
      </header>

      <div className="gitp-ops">
        <button
          className="gitp-btn"
          type="button"
          onClick={onPull}
          // Pull needs somewhere to pull FROM. Push does not: git_ops.rs sets
          // the upstream itself on the first push of a new branch.
          disabled={busy || !repo.has_upstream}
          title={
            repo.has_upstream
              ? `git pull --${pullMode}`
              : "This branch does not track a remote branch yet. Push it first."
          }
        >
          {repo.behind > 0 ? `Pull ${repo.behind}` : "Pull"}
        </button>
        <select
          className="gitp-mode"
          value={pullMode}
          disabled={busy}
          aria-label="How Pull brings commits in"
          onChange={(e) => onPullMode(e.target.value as PullMode)}
        >
          {PULL_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button className="gitp-btn" type="button" onClick={onPush} disabled={busy} title="git push">
          {repo.ahead > 0 ? `Push ${repo.ahead}` : "Push"}
        </button>
      </div>

      {files.length === 0 ? (
        <div className="gitp-clean">No uncommitted changes</div>
      ) : (
        <ul className="gitp-files">
          {files.map((file) => (
            <li key={file.path}>
              <FileRow
                repo={repo}
                file={file}
                ticked={checked.has(file.path)}
                busy={busy}
                open={openFile === file.path}
                onTick={onTick}
                onOpen={() => setOpenFile((cur) => (cur === file.path ? null : file.path))}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One file row: tick it for the commit, or tap it to read the diff.
 *
 *  A `div` with the tick box beside the button, not one big `<button>`: a
 *  checkbox nested inside a button is invalid HTML that browsers handle however
 *  they like. */
function FileRow({
  repo,
  file,
  ticked,
  busy,
  open,
  onTick,
  onOpen,
}: {
  repo: RepoChanges;
  file: ChangedFile;
  ticked: boolean;
  busy: boolean;
  open: boolean;
  onTick: (root: string, path: string, on: boolean) => void;
  onOpen: () => void;
}) {
  const mark = STATUS_MARK[file.status] ?? MODIFIED;
  // Renames already read as "old → new", so they are shown whole rather than
  // split into a dimmed folder and a filename.
  const parts = file.status === "renamed" ? null : splitPath(file.display);

  return (
    <>
      <div className={`gitp-file ${open ? "is-open" : ""}`}>
        <input
          type="checkbox"
          className="gitp-check"
          checked={ticked}
          disabled={busy}
          title="Include in the next commit"
          onChange={(e) => onTick(repo.root, file.path, e.target.checked)}
        />
        <button className="gitp-file-btn" type="button" onClick={onOpen} title={file.display}>
          <span className={`gitp-st ${mark.cls}`}>{mark.letter}</span>
          <span className="gitp-file-path">
            {parts ? (
              <>
                {parts.dir && <span className="gitp-file-dir">{parts.dir}</span>}
                <span className="gitp-file-name">{parts.name}</span>
              </>
            ) : (
              <span className="gitp-file-name">{file.display}</span>
            )}
          </span>
          <span className="gitp-counts">
            {file.binary ? (
              <span className="gitp-bin">bin</span>
            ) : (
              <>
                {file.added > 0 && <span className="gitp-add-n">+{file.added}</span>}
                {file.removed > 0 && <span className="gitp-del-n">−{file.removed}</span>}
              </>
            )}
          </span>
        </button>
      </div>
      {open && <Diff repo={repo} file={file} />}
    </>
  );
}

/** The unified diff for one file, fetched when the row is opened. */
function Diff({ repo, file }: { repo: RepoChanges; file: ChangedFile }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setError(null);
    bridge
      .invoke<FileDiff>("git_file_diff", {
        root: repo.root,
        file: file.path,
        untracked: file.untracked,
        // Both sides of a rename, so the diff is the move rather than a whole
        // new file appearing out of nowhere.
        oldPath: file.old_path ?? "",
      })
      .then((d) => {
        if (live) setDiff(d);
      })
      .catch((err) => {
        if (live) setError(String((err as Error).message ?? err));
      });
    return () => {
      live = false;
    };
  }, [repo.root, file.path, file.untracked, file.old_path]);

  if (error) return <div className="gitp-note is-err">{error}</div>;
  if (!diff) return <div className="gitp-note">Loading the diff…</div>;
  if (diff.binary) return <div className="gitp-note">Binary file — no text to show.</div>;
  if (diff.too_large) return <div className="gitp-note">This diff is too big to show here.</div>;

  const lines = diff.text.split("\n").filter((l) => !DIFF_NOISE.test(l));
  return (
    <pre className="gitp-diff">
      {lines.map((line, i) => (
        <span key={i} className={`gitp-line ${lineClass(line)}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-del";
  return "";
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 11.2a5 5 0 0 1-5 5H9.5" />
    </svg>
  );
}
