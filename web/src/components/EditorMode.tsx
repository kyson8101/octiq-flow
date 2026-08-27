// Editor mode: the project's folders on one side, the file you are editing on
// the other.
//
// The chat is a conversation about the code; this is the code. It is the same
// backend either way — `list_dir`, `read_file_preview`, `write_file` — so this
// is a second view of the machine rather than a second application.
//
// Three rules shape it:
//
//   · A TRUNCATED file is read-only. `read_file_preview` caps how much of a
//     large file it returns, and saving that back would cut the real file down
//     to the part we happened to be shown. So the editor refuses the edit
//     rather than warning about the save — a warning is something you can miss.
//
//   · Open tabs SURVIVE. Switching to the chat, switching project, opening
//     another file: none of them throw away an unsaved draft, because each tab
//     keeps its own editor mounted and its own text. The only ways to lose a
//     draft are closing the tab and reloading the file, and both ask first.
//
//   · A file that changed underneath you is not overwritten silently. Agents
//     are editing these same files while you read them, so Save checks what is
//     on disk against what we last read before it writes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { hasTwoViews } from "../lib/fileView";
import { FileView } from "./FileView";
import { FileTree, rootsOf } from "./FileTree";
import { useConfirm } from "./Confirm";

export type EditorProject = {
  id: string;
  name: string;
  primary_path?: string;
  paths?: string[];
};

/** `read_file_preview`'s answer. Snake_case on the wire, but every field here
 *  happens to be one word, so the Rust names carry over unchanged. `kind` is
 *  "text" | "image" | "pdf" | "binary", and `size` is the file's REAL size —
 *  `content` may be shorter when `truncated`. */
type Preview = { kind: string; content: string; truncated: boolean; size: number };

type OpenFile = {
  path: string;
  /** null until the first read comes back. */
  file: Preview | null;
  /** Why the read failed, written by the backend for a person. */
  error: string | null;
  /** Bumped to give the editor a new `key` after a reload, which is the point:
   *  the old undo history belongs to text that is no longer there. */
  generation: number;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EditorMode({ project }: { project: EditorProject | null }) {
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // What each open tab's editor currently holds. The editor owns the text while
  // it is being typed; this is the copy the Save button and the dirty mark read.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Which tabs are being read as SOURCE rather than as what they render to —
  // markdown, and an html page. Per tab and not one flag for the whole editor:
  // reading a README next to the page it documents is two different answers,
  // and one flag would make them the same answer.
  const [sourceView, setSourceView] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The tree is a slide-over on a phone and a column on a wide screen; this
  // only drives the slide-over. It starts open because with no file chosen the
  // tree is the whole of the screen's use.
  const [treeOpen, setTreeOpen] = useState(true);
  const confirm = useConfirm();

  const roots = useMemo(() => (project ? rootsOf(project) : []), [project]);
  const current = tabs.find((t) => t.path === active) ?? null;
  const draft = active !== null ? drafts[active] : undefined;
  const dirty = !!current?.file && draft !== undefined && draft !== current.file.content;
  const editable = !!current?.file && current.file.kind === "text" && !current.file.truncated;

  const anyDirty = useMemo(
    () =>
      tabs.some((tab) => {
        const text = drafts[tab.path];
        return !!tab.file && text !== undefined && text !== tab.file.content;
      }),
    [tabs, drafts],
  );

  /** Read a file into its tab. `generation` is bumped on a reload so the editor
   *  remounts around the new text. */
  const read = useCallback(async (path: string, bumpGeneration: boolean) => {
    try {
      const file = await bridge.invoke<Preview>("read_file_preview", { path });
      setTabs((prev) =>
        prev.map((tab) =>
          tab.path === path
            ? { ...tab, file, error: null, generation: tab.generation + (bumpGeneration ? 1 : 0) }
            : tab,
        ),
      );
      setDrafts((prev) => ({ ...prev, [path]: file.content ?? "" }));
    } catch (e) {
      const message = String((e as Error).message ?? e);
      setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, error: message } : tab)));
    }
  }, []);

  // Read outside the state updater rather than inside it: React runs an updater
  // twice in development, and a read fired from in there would be two requests
  // for the same file every time one was opened.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const openFile = useCallback(
    (path: string) => {
      setSaveError(null);
      setTreeOpen(false);
      setActive(path);
      if (tabsRef.current.some((tab) => tab.path === path)) return;
      setTabs((prev) =>
        prev.some((tab) => tab.path === path)
          ? prev
          : [...prev, { path, file: null, error: null, generation: 0 }],
      );
      void read(path, false);
    },
    [read],
  );

  const closeFile = useCallback(
    async (path: string) => {
      const tab = tabs.find((t) => t.path === path);
      const text = drafts[path];
      if (tab?.file && text !== undefined && text !== tab.file.content) {
        const ok = await confirm({
          title: "Close without saving?",
          body: `Your changes to ${baseName(path)} will be lost.`,
          confirmLabel: "Discard changes",
          danger: true,
        });
        if (!ok) return;
      }
      const remaining = tabs.filter((t) => t.path !== path);
      setTabs(remaining);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      setSourceView((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      // Land on the neighbour rather than on nothing, the way closing a tab in
      // an editor does.
      if (active === path) {
        const at = tabs.findIndex((t) => t.path === path);
        setActive(remaining[Math.min(at, remaining.length - 1)]?.path ?? null);
        if (remaining.length === 0) setTreeOpen(true);
      }
    },
    [tabs, drafts, active, confirm],
  );

  const reload = useCallback(
    async (path: string) => {
      const tab = tabs.find((t) => t.path === path);
      const text = drafts[path];
      if (tab?.file && text !== undefined && text !== tab.file.content) {
        const ok = await confirm({
          title: "Reload from disk?",
          body: `Your unsaved changes to ${baseName(path)} will be lost.`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!ok) return;
      }
      setSaveError(null);
      void read(path, true);
    },
    [tabs, drafts, confirm, read],
  );

  const save = useCallback(async () => {
    if (!current?.file || !active || saving) return;
    const text = drafts[active];
    if (text === undefined || text === current.file.content) return;
    if (current.file.kind !== "text" || current.file.truncated) return;

    setSaving(true);
    setSaveError(null);
    try {
      // What we are about to overwrite may not be what we read. An agent
      // working in this project edits these very files, and a save that quietly
      // discarded its work would be the worst kind of bug: invisible.
      const onDisk = await bridge.invoke<Preview>("read_file_preview", { path: active });
      if (!onDisk.truncated && onDisk.content !== current.file.content) {
        const ok = await confirm({
          title: `${baseName(active)} changed on disk`,
          body: "Something else edited this file after you opened it. Saving replaces those changes with yours.",
          confirmLabel: "Overwrite",
          danger: true,
        });
        if (!ok) {
          setSaving(false);
          return;
        }
      }

      await bridge.invoke("write_file", { path: active, content: text });
      // The draft is now what is on disk, so the tab stops showing as dirty.
      setTabs((prev) =>
        prev.map((tab) =>
          tab.path === active && tab.file ? { ...tab, file: { ...tab.file, content: text } } : tab,
        ),
      );
      setJustSaved(active);
      setTimeout(() => setJustSaved(null), 1600);
    } catch (e) {
      // Usually "outside the project folders": `write_file` resolves the path
      // against the project's own roots first, which is what stops a browser on
      // the far side of the world editing anything on the machine.
      setSaveError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }, [current, active, drafts, saving, confirm]);

  // ⌘S from anywhere in editor mode, not only from inside the text. The editor
  // binds it too, because a key press inside a contenteditable does not always
  // reach the window on iOS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // The last line of defence for unsaved work: a reload, a closed tab, a
  // swipe-back gesture. Everything inside the app asks first — this catches the
  // things that are not the app's to ask about.
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  if (!project) {
    return (
      <div className="ws">
        <div className="ws-empty">Add a project to browse its files.</div>
      </div>
    );
  }

  return (
    <div className={`ws ${treeOpen ? "is-browsing" : ""}`}>
      <div className="ws-tree-scrim" onClick={() => setTreeOpen(false)} />
      <FileTree
        projectId={project.id}
        roots={roots}
        current={active}
        onOpen={openFile}
      />

      <div className="ws-pane">
        <div className="ws-bar">
          <button
            className="ws-files-btn"
            type="button"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((v) => !v)}
          >
            Files
          </button>

          <div className="ws-tabs">
            {tabs.map((tab) => {
              const text = drafts[tab.path];
              const tabDirty = !!tab.file && text !== undefined && text !== tab.file.content;
              return (
                <div
                  key={tab.path}
                  className={`ws-tab ${tab.path === active ? "is-on" : ""}`}
                  title={tab.path}
                >
                  <button
                    className="ws-tab-btn"
                    type="button"
                    onClick={() => {
                      setActive(tab.path);
                      setSaveError(null);
                    }}
                  >
                    {baseName(tab.path)}
                    {/* role, because a bare span with an aria-label is not
                        reliably read out and this dot is the only thing saying
                        the file has unsaved work. */}
                    {tabDirty && (
                      <span className="ws-tab-dot" role="img" aria-label="unsaved changes" />
                    )}
                  </button>
                  <button
                    className="ws-tab-close"
                    type="button"
                    aria-label={`Close ${baseName(tab.path)}`}
                    onClick={() => void closeFile(tab.path)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          {current && (
            <button
              className="ws-save"
              type="button"
              disabled={!editable || !dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : justSaved === active && !dirty ? "Saved" : "Save"}
            </button>
          )}
        </div>

        {current && (
          <div className="ws-path-row">
            <span className="ws-path" title={current.path}>
              <bdi>{current.path}</bdi>
            </span>
            {/* Only for a file with two views to flip between. Without it an
                html file — or a README — could be READ here and never edited,
                which is the one thing this mode is for. */}
            {hasTwoViews(current.path, current.file) && (
              <button
                className="ws-mini-btn"
                type="button"
                onClick={() =>
                  setSourceView((prev) => ({ ...prev, [current.path]: !prev[current.path] }))
                }
              >
                {sourceView[current.path] ? "Preview" : "Edit"}
              </button>
            )}
            <button className="ws-mini-btn" type="button" onClick={() => void reload(current.path)}>
              Reload
            </button>
          </div>
        )}

        {saveError && <div className="panel-error">{saveError}</div>}
        {current?.error && <div className="panel-error">{current.error}</div>}

        {current?.file?.truncated && (
          <div className="panel-warn">
            Showing the first {humanSize(current.file.content.length)} of{" "}
            {humanSize(current.file.size)}. This file is read-only here — saving what is on screen
            would cut the rest of it away.
          </div>
        )}

        <div className="ws-body">
          {tabs.length === 0 && (
            <div className="ws-empty">Pick a file from {project.name} to read or edit it.</div>
          )}

          {tabs.map((tab) => (
            <div
              key={tab.path}
              className="ws-doc"
              // Kept in the tree while hidden so the draft, the caret and the
              // undo history are all still there when you come back to it.
              hidden={tab.path !== active}
            >
              {!tab.file && !tab.error && <div className="dots" aria-label="loading" />}
              {/* Card 89 — the same body the chat dock draws. What stays HERE is
                  what is genuinely this frame's: the tab, its draft, and its
                  undo history, all kept alive while the tab is hidden. */}
              {tab.file && (
                <FileView
                  path={tab.path}
                  preview={tab.file}
                  draft={drafts[tab.path] ?? tab.file.content}
                  raw={!!sourceView[tab.path]}
                  generation={tab.generation}
                  onDraft={(text) => setDrafts((prev) => ({ ...prev, [tab.path]: text }))}
                  onSave={() => void save()}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

