// A file, slid out from the right: read it, edit it, save it.
//
// Clicking a file in a reply's list opens this. Markdown renders by default —
// most of what an agent writes is prose — with a raw view a tap away, and any
// other text file opens straight in the editor.
//
// One rule matters more than the rest: a preview that was TRUNCATED cannot be
// saved. The backend caps how much of a large file it returns, and writing that
// back would cut the real file down to the part we happened to be shown. So
// saving is refused outright for those, rather than warned about.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { useConfirm } from "./Confirm";

type Preview = {
  /** "text" | "image" | "pdf" | "binary" */
  kind: string;
  content: string;
  truncated: boolean;
  size: number;
};

function isMarkdown(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The file changed underneath us while we had unsaved edits. Reloading would
  // throw that work away, so it becomes a choice rather than something that
  // happens to you.
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const confirm = useConfirm();

  const dirty = !!preview && draft !== preview.content;
  // The listener below is registered once per file; these keep it looking at
  // the live values rather than the ones captured when it was created.
  const draftRef = useRef(draft);
  const savedRef = useRef(preview?.content ?? "");
  draftRef.current = draft;
  savedRef.current = preview?.content ?? "";
  const canSave = !!preview && preview.kind === "text" && !preview.truncated && dirty;

  /** Read the file. `keepEditor` is for a reload, where flipping the user out
   *  of the editor they were in would be its own small betrayal. */
  const load = useCallback(
    async (keepEditor: boolean) => {
      try {
        const p = await bridge.invoke<Preview>("read_file_preview", { path });
        setPreview(p);
        setDraft(p.content ?? "");
        setStaleOnDisk(false);
        setError(null);
        // A file with nothing to render opens in the editor rather than on an
        // empty page.
        if (!keepEditor) setEditing(p.kind === "text" && !isMarkdown(path));
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [path],
  );

  useEffect(() => {
    setPreview(null);
    setError(null);
    setEditing(false);
    void load(false);
  }, [path, load]);

  // Follow the file while it is open. An agent editing it in another chat, a
  // git checkout, a build writing a report — the panel is a window onto the
  // file, so it should show what the file says NOW.
  //
  // The watcher is a single shared one in the backend (file_watch.rs), so
  // pointing it here takes it away from anything else that was watching. The
  // classic UI's preview pane is the only other user, and the two are not open
  // at once.
  useEffect(() => {
    bridge.invoke("file_watch_paths", { paths: [path] }).catch(() => {});
    const off = bridge.on<string[]>("file-changed", (changed) => {
      if (!Array.isArray(changed) || !changed.includes(path)) return;
      // Unsaved work always wins over a background change.
      if (draftRef.current !== savedRef.current) {
        setStaleOnDisk(true);
        return;
      }
      void load(true);
    });
    return () => {
      off();
      bridge.invoke("file_watch_paths", { paths: [] }).catch(() => {});
    };
  }, [path, load]);

  // Escape closes, unless there is unsaved work — losing an edit to a stray key
  // press is worse than an extra click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dirty) onClose();
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      await bridge.invoke("write_file", { path, content: draft });
      setPreview((p) => (p ? { ...p, content: draft } : p));
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      // Usually "outside the project folders": write_file only accepts paths
      // under a project's own roots, which is what stops a chat editing
      // anything on the machine.
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function requestClose() {
    if (dirty) {
      const ok = await confirm({
        title: "Close without saving?",
        body: `Your changes to ${baseName(path)} will be lost.`,
        confirmLabel: "Discard changes",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  // On the page, not inside the message it was opened from — see the Viewer for
  // why `position: fixed` alone was not enough.
  return createPortal(
    <>
      <div className="panel-scrim" onClick={() => void requestClose()} />
      <aside className="panel" role="dialog" aria-label={baseName(path)}>
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">
              {baseName(path)}
              {dirty && <span className="panel-dirty" title="Unsaved changes" />}
            </div>
            <div className="panel-path">
              <bdi>{path}</bdi>
            </div>
          </div>

          {preview?.kind === "text" && isMarkdown(path) && (
            <button className="panel-btn" type="button" onClick={() => setEditing((v) => !v)}>
              {editing ? "Preview" : "Edit"}
            </button>
          )}
          {preview?.kind === "text" && !preview.truncated && (
            <button
              className="panel-btn is-primary"
              type="button"
              onClick={save}
              disabled={!canSave || saving}
            >
              {saving ? "Saving…" : saved ? "Saved" : "Save"}
            </button>
          )}
          <button className="panel-close" type="button" onClick={() => void requestClose()} aria-label="Close">
            ✕
          </button>
        </header>

        {error && <div className="panel-error">{error}</div>}

        {staleOnDisk && (
          <div className="panel-warn is-stale">
            This file changed on disk while you were editing it.
            <button className="panel-inline-btn" type="button" onClick={() => void load(true)}>
              Reload and lose my changes
            </button>
          </div>
        )}

        {preview?.truncated && (
          <div className="panel-warn">
            Showing the first {humanSize(preview.content.length)} of {humanSize(preview.size)}.
            Saving is off for this file — writing back what is on screen would cut the rest away.
          </div>
        )}

        <div className="panel-body">
          {!preview && !error && <div className="dots" aria-label="loading" />}

          {preview?.kind === "text" &&
            (editing ? (
              <textarea
                className="panel-editor"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <div className="prose panel-prose">
                <Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown>
              </div>
            ))}

          {preview && preview.kind !== "text" && (
            <div className="panel-note">
              {preview.kind === "image"
                ? "This is an image — open it from the list to view it."
                : `Nothing to show for a ${preview.kind} file (${humanSize(preview.size)}).`}
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
