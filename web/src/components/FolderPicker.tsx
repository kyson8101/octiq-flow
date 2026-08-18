// Pick a folder on the machine running OctiqFlow.
//
// The desktop app opens a native macOS folder dialog for this. That is exactly
// wrong here: the dialog would open on the HOST machine, where nobody is
// sitting, while the phone that asked for it waits forever. So the picker is
// built out of `list_dir` — walk the folders, tap one, done — with the current
// path always editable as text for when you already know where you are going.
//
// Only folders are listed. Files are not choices here, and showing them would
// bury the two or three folders that are.
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../lib/bridge";

type DirEntry = { name: string; path: string; is_dir: boolean };

/** The parent of a path, or null at the root. String work rather than a call:
 *  the answer is already in the path we have. */
function parentOf(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return null;
  return at === 0 ? "/" : trimmed.slice(0, at);
}

export function FolderPicker({
  start,
  title,
  onPick,
  onClose,
  files = false,
}: {
  /** Where to open. Empty starts at the home folder — `list_dir` resolves it,
   *  because a browser cannot know what home is called on that machine. */
  start: string;
  title: string;
  onPick: (path: string) => void;
  onClose: () => void;
  /** Pick a FILE rather than a folder. Files are then listed too, and choosing
   *  one closes the dialog with its path; folders still only navigate. */
  files?: boolean;
}) {
  const [path, setPath] = useState(start);
  // What is in the box, which is not the same as where we are: you can type a
  // path that does not exist yet without the listing chasing every keystroke.
  const [typed, setTyped] = useState(start);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const go = useCallback((next: string) => {
    setPath(next);
    setTyped(next);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    bridge
      .invoke<DirEntry[]>("list_dir", { path })
      .then((list) => {
        if (!alive) return;
        setEntries((list ?? []).filter((e) => e.is_dir || files));
        setError(null);
        // `list_dir` resolves "" and "~" for us; adopt the real path it walked
        // so the Use button and the parent row have something absolute to work
        // with.
        const first = (list ?? [])[0];
        if (first && !path.startsWith("/")) {
          const resolved = parentOf(first.path);
          if (resolved) {
            setPath(resolved);
            setTyped(resolved);
          }
        }
      })
      .catch((e: Error) => {
        if (!alive) return;
        setEntries([]);
        setError(e.message);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const up = parentOf(path);

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <div className="fp-picker" role="dialog" aria-label={title}>
        <header className="fp-picker-head">
          <span className="fp-picker-title">{title}</span>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <form
          className="fp-picker-path"
          onSubmit={(e) => {
            e.preventDefault();
            go(typed.trim());
          }}
        >
          <input
            className="fp-picker-input"
            value={typed}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="/path/to/folder"
            onChange={(e) => setTyped(e.target.value)}
          />
          <button className="panel-btn" type="submit">
            Go
          </button>
        </form>

        {error && <div className="panel-error">{error}</div>}

        <div className="fp-picker-body">
          {up && (
            <button className="fp-picker-row is-up" type="button" onClick={() => go(up)}>
              <FolderIcon />
              <span className="fp-picker-name">..</span>
            </button>
          )}

          {loading && entries.length === 0 && !error && <div className="dots" aria-label="loading" />}

          {!loading && entries.length === 0 && !error && (
            <div className="fp-picker-empty">No folders in here.</div>
          )}

          {entries.map((e) => (
            <button
              className={`fp-picker-row ${e.is_dir ? "" : "is-file"}`}
              type="button"
              key={e.path}
              // A folder is somewhere to go; a file is the answer.
              onClick={() => (e.is_dir ? go(e.path) : onPick(e.path))}
            >
              {e.is_dir ? <FolderIcon /> : <FileIcon />}
              <span className="fp-picker-name">{e.name}</span>
            </button>
          ))}
        </div>

        <footer className="fp-picker-foot">
          <div className="fp-picker-here" title={path}>
            <bdi>{path}</bdi>
          </div>
          {/* In file mode the choice is made by tapping a file, so there is
              nothing to confirm down here. */}
          {!files && (
            <button
              className="panel-btn is-primary"
              type="button"
              disabled={!path.startsWith("/")}
              onClick={() => onPick(path)}
            >
              Use this folder
            </button>
          )}
        </footer>
      </div>
    </>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
