// The project's folders, as a tree.
//
// A project groups SEVERAL folders (`primary_path` plus `paths`), so the top
// level is one row per folder rather than the contents of one of them. The
// primary folder comes first and opens by itself; the rest wait to be asked.
//
// Folders are listed the first time they open and then remembered, because
// `list_dir` is a round trip to the machine at the other end of a phone
// connection and re-walking a folder you already opened costs a visible pause.
//
// Finding a file by scrolling a tree on a phone is miserable, so the filter box
// is the real way in: `list_project_files` gives every non-ignored path in the
// project in one call (ripgrep's rules, so no .git or node_modules), and the
// matching happens here with no further round trips. Its answer covers only
// what ripgrep will walk, so a HIDDEN folder is reachable through the tree and
// not through the filter — which is why both exist.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";

/** `list_dir`'s row. Snake_case on the wire — the Rust struct renames to
 *  snake_case, not camelCase, so `is_dir` is genuinely what arrives. */
type DirEntry = { name: string; path: string; is_dir: boolean };

/** `list_project_files`'s answer. `truncated` means the list is a prefix of a
 *  very large repo, so a filter that finds nothing may still be wrong. */
type ProjectFiles = { files: string[]; truncated: boolean };

/** Filter hits drawn at once. Past this the list is longer than anyone scrolls
 *  and each row costs a layout on a phone. */
const MAX_HITS = 80;

const OPEN_KEY = "octiq.v2.editor.openDirs";

/** Every folder of a project, primary first, with blanks and repeats dropped.
 *  A project whose `paths` already lists its primary folder must not show it
 *  twice. */
export function rootsOf(project: { primary_path?: string; paths?: string[] }): string[] {
  const all = [project.primary_path ?? "", ...(project.paths ?? [])];
  return [...new Set(all.map((p) => p.replace(/\/+$/, "")).filter(Boolean))];
}

export function FileTree({
  projectId,
  roots,
  current,
  onOpen,
}: {
  /** Which project this is, so the open folders are remembered per project
   *  rather than bleeding from one into the next. */
  projectId: string;
  roots: string[];
  /** The file on screen, marked in the tree. */
  current: string | null;
  onOpen: (path: string) => void;
}) {
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  // Every file in the project, fetched the first time the filter is used.
  const [index, setIndex] = useState<ProjectFiles | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const indexing = useRef(false);
  // Folders we have already asked about, so reopening one shows what it held
  // instead of flashing a spinner and asking again.
  const loaded = useRef<Set<string>>(new Set());

  const list = useCallback(async (dir: string) => {
    setBusy((prev) => new Set(prev).add(dir));
    try {
      const entries = await bridge.invoke<DirEntry[]>("list_dir", { path: dir });
      setChildren((prev) => ({ ...prev, [dir]: entries ?? [] }));
      setFailed((prev) => {
        if (!(dir in prev)) return prev;
        const next = { ...prev };
        delete next[dir];
        return next;
      });
    } catch (e) {
      // The backend writes these for a person: "Folder not found: …",
      // "Cannot read folder: permission denied".
      setFailed((prev) => ({ ...prev, [dir]: String((e as Error).message ?? e) }));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    }
  }, []);

  // The open set is read here rather than through the updater so opening a
  // folder can write the new set to storage in the same breath. Persisting in
  // an effect instead would fire once with the PREVIOUS project's folders still
  // in state on the render where the project changes, and file them under the
  // new project's name.
  const openRef = useRef(open);
  openRef.current = open;

  const toggle = useCallback(
    (dir: string) => {
      const next = new Set(openRef.current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      setOpen(next);
      try {
        const raw = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}");
        const all = raw && typeof raw === "object" ? raw : {};
        localStorage.setItem(OPEN_KEY, JSON.stringify({ ...all, [projectId]: [...next] }));
      } catch {
        /* storage blocked: the tree forgets between visits, nothing worse */
      }
    },
    [projectId],
  );

  // Listing follows from a folder being open rather than from the click that
  // opened it, so the folders restored from storage below load the same way a
  // tapped one does, and nothing is fetched twice.
  useEffect(() => {
    for (const dir of open) {
      if (loaded.current.has(dir)) continue;
      loaded.current.add(dir);
      void list(dir);
    }
  }, [open, list]);

  // Restore which folders were open, per project. Everything listed under them
  // reloads — the tree is a view of the disk and the disk moved on while we
  // were away.
  useEffect(() => {
    setChildren({});
    setFailed({});
    setQuery("");
    setIndex(null);
    setIndexError(null);
    indexing.current = false;
    loaded.current = new Set();

    let saved: string[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}");
      const forProject = raw?.[projectId];
      if (Array.isArray(forProject)) saved = forProject.filter((p) => typeof p === "string");
    } catch {
      /* storage blocked or corrupt: start with the primary folder open */
    }
    // Somewhere to start on a first visit. Anything deeper than the roots is
    // only reopened because it was open last time.
    setOpen(new Set(saved.length ? saved : roots.slice(0, 1)));
    // `roots` is rebuilt on every render of the parent, so it cannot be a
    // dependency without re-running this forever; the project id is what
    // actually changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // The file index is fetched once, on the first keystroke in the filter —
  // never on mount. On a big repo it is a second of ripgrep, and most visits to
  // the editor go straight to the tree.
  useEffect(() => {
    // Clearing the box also clears a failure, so a filter that broke on a
    // dropped socket can be tried again by typing rather than by reloading.
    if (!query.trim()) {
      if (indexError) setIndexError(null);
      return;
    }
    if (index || indexError || indexing.current) return;
    indexing.current = true;
    bridge
      .invoke<ProjectFiles>("list_project_files", { roots })
      .then((res) => setIndex(res ?? { files: [], truncated: false }))
      .catch((e: Error) => setIndexError(e.message))
      .finally(() => {
        indexing.current = false;
      });
  }, [query, index, indexError, roots]);

  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !index) return [];
    // Every match is collected before anything is thrown away. Cutting the list
    // at MAX_HITS while scanning would drop a file whose NAME matches in favour
    // of eighty whose folder happens to, which is the wrong eighty.
    const out = index.files.filter((path) => path.toLowerCase().includes(needle));
    return out
      .sort((a, b) => {
        // A match in the file NAME is what people mean; a match anywhere in the
        // path still counts, which is how you find `components/Sidebar.tsx` by
        // typing "components/side".
        const an = baseName(a).toLowerCase().includes(needle) ? 0 : 1;
        const bn = baseName(b).toLowerCase().includes(needle) ? 0 : 1;
        return an - bn || a.length - b.length;
      })
      .slice(0, MAX_HITS);
  }, [query, index]);

  const filtering = query.trim().length > 0;

  return (
    <div className="ws-tree">
      <div className="ws-filter">
        <input
          className="ws-filter-input"
          value={query}
          placeholder="Find a file"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          type="search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="ws-tree-body">
        {filtering ? (
          <>
            {indexError && <div className="ws-tree-msg">Cannot list this project: {indexError}</div>}
            {!indexError && !index && <div className="dots" aria-label="loading" />}
            {index && hits.length === 0 && <div className="ws-tree-msg">Nothing matches.</div>}
            {hits.map((path) => (
              <button
                key={path}
                type="button"
                className={`ws-row is-file ${path === current ? "is-on" : ""}`}
                onClick={() => onOpen(path)}
              >
                <FileIcon />
                <span className="ws-row-name">
                  {baseName(path)}
                  <span className="ws-row-where">{shorten(path, roots)}</span>
                </span>
              </button>
            ))}
            {index?.truncated && (
              <div className="ws-tree-msg">
                This project has more files than the list holds, so something may be missing.
              </div>
            )}
          </>
        ) : (
          roots.map((root) => (
            <Branch
              key={root}
              dir={root}
              label={baseName(root)}
              depth={0}
              open={open}
              busy={busy}
              children_={children}
              failed={failed}
              current={current}
              onToggle={toggle}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Where a hit lives, relative to whichever project folder holds it. The full
 *  path is too long for a phone-width row and its first half is the same on
 *  every line anyway. */
function shorten(path: string, roots: string[]): string {
  const root = roots.find((r) => path.startsWith(r + "/"));
  const rel = root ? path.slice(root.length + 1) : path;
  const at = rel.lastIndexOf("/");
  return at < 0 ? "" : rel.slice(0, at);
}

function Branch({
  dir,
  label,
  depth,
  open,
  busy,
  children_,
  failed,
  current,
  onToggle,
  onOpen,
}: {
  dir: string;
  label: string;
  depth: number;
  open: Set<string>;
  busy: Set<string>;
  children_: Record<string, DirEntry[]>;
  failed: Record<string, string>;
  current: string | null;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
}) {
  const isOpen = open.has(dir);
  const entries = children_[dir];
  const indent = { paddingInlineStart: `${8 + depth * 13}px` };

  return (
    <>
      <button
        type="button"
        className={`ws-row is-dir ${isOpen ? "is-open" : ""}`}
        style={indent}
        onClick={() => onToggle(dir)}
        title={dir}
      >
        <span className={`ws-twisty ${isOpen ? "is-open" : ""}`} aria-hidden="true">
          <ChevronIcon />
        </span>
        <FolderIcon />
        <span className="ws-row-name">{label}</span>
      </button>

      {isOpen && (
        <>
          {failed[dir] && (
            <div className="ws-tree-msg" style={indent}>
              {failed[dir]}
            </div>
          )}
          {!entries && busy.has(dir) && <div className="dots" aria-label="loading" />}
          {entries?.length === 0 && (
            <div className="ws-tree-msg" style={indent}>
              This folder is empty.
            </div>
          )}
          {entries?.map((entry) =>
            entry.is_dir ? (
              <Branch
                key={entry.path}
                dir={entry.path}
                label={entry.name}
                depth={depth + 1}
                open={open}
                busy={busy}
                children_={children_}
                failed={failed}
                current={current}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                className={`ws-row is-file ${entry.path === current ? "is-on" : ""}`}
                style={{ paddingInlineStart: `${8 + (depth + 1) * 13}px` }}
                onClick={() => onOpen(entry.path)}
                title={entry.path}
              >
                <FileIcon />
                <span className="ws-row-name">{entry.name}</span>
              </button>
            ),
          )}
        </>
      )}
    </>
  );
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
