// One repository section of the Git panel: its files and their diffs (moved verbatim from GitPanel.tsx).
import type { ChangedFile, RepoChanges } from "./GitPanel";
import { ActionIcon } from "./ActionIcon";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { RollingNumber } from "./RollingNumber";

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
export const PULL_MODES = ["rebase", "merge", "ff-only"] as const;
export type PullMode = (typeof PULL_MODES)[number];

/** Header lines of a unified diff that say nothing a reader wants here — the
 *  file name is already at the top of the row the diff hangs under. */
const DIFF_NOISE =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files )/;

/** Split a path into the filename users scan for and its quieter parent path. */
function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

type FileDiff = { text: string; binary: boolean; too_large: boolean };

/** One repo: its head (branch, sync counts, pull/push) and its changed files. */
export function RepoSection({
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
          {repo.behind > 0 && (
            <span className="gitp-behind">
              ↓<RollingNumber value={repo.behind} />
            </span>
          )}
          {repo.ahead > 0 && (
            <span className="gitp-ahead">
              ↑<RollingNumber value={repo.ahead} />
            </span>
          )}
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
         data-icon-action aria-label={repo.behind > 0 ? `Pull ${repo.behind}` : "Pull"}><ActionIcon name="refresh" label="Pull" /></button>
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
        <button className="gitp-btn" type="button" onClick={onPush} disabled={busy} title="git push" data-icon-action aria-label={repo.ahead > 0 ? `Push ${repo.ahead}` : "Push"}><ActionIcon name="handover" label="Push" /></button>
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
  const parts = splitPath(file.path);
  // A rename needs both paths to remain visible. For every other status the
  // quieter second line is just the containing directory.
  const secondaryPath = file.status === "renamed" ? file.display : parts.dir;

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
          <span className="gitp-file-copy">
            <span className="gitp-file-name">{parts.name}</span>
            {secondaryPath && <span className="gitp-file-path">{secondaryPath}</span>}
          </span>
          <span className="gitp-counts">
            {file.binary ? (
              <span className="gitp-bin">bin</span>
            ) : (
              <>
                {file.added > 0 && (
                  <span className="gitp-add-n">
                    +<RollingNumber value={file.added} />
                  </span>
                )}
                {file.removed > 0 && (
                  <span className="gitp-del-n">
                    −<RollingNumber value={file.removed} />
                  </span>
                )}
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
