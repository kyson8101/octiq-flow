// A project's own settings: what it is called, and which folders it covers.
//
// The folders are the part that matters. A project can group several — a web
// app, its API, a shared library — and a chat started in it only sees the MAIN
// folder unless the others are named too (agent_chat.rs turns each one into a
// `--add-dir`). Getting that list right is the difference between an agent that
// can read your whole project and one that keeps saying a file does not exist.
//
// Everything saves the moment you do it, one backend call per change, because
// there is no shape of this screen where a lost Save button is acceptable on a
// phone. The name and description are the exception: they save when you stop
// typing, so a rename is not 14 writes.
import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { FolderPicker } from "./FolderPicker";
import { useConfirm } from "./Confirm";

export type ProjectDetail = {
  id: string;
  name: string;
  primary_path?: string;
  paths?: string[];
  description?: string;
  shelved?: boolean;
};

/** How long to wait after the last keystroke before saving text. */
const TYPING_SETTLE_MS = 600;

export function ProjectSettings({
  project,
  onChanged,
  onClose,
  onDeleted,
}: {
  /** The project to edit, or null to create a new one. */
  project: ProjectDetail | null;
  /** Something was saved: reload the project list. */
  onChanged: () => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const creating = !project;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which folder the picker is choosing: the main one, or another to add.
  const [picking, setPicking] = useState<"primary" | "extra" | null>(null);
  const [newPath, setNewPath] = useState("");
  const confirm = useConfirm();

  const primary = project?.primary_path ?? "";
  const extras = project?.paths ?? [];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // Text fields save when you stop typing. The guard matters: this effect also
  // runs when the panel opens, and saving the value we were just handed would
  // be a write for nothing.
  const settled = useRef(false);
  useEffect(() => {
    if (creating || !project) return;
    if (!settled.current) {
      settled.current = true;
      return;
    }
    const timer = setTimeout(() => {
      const trimmed = name.trim();
      if (trimmed && trimmed !== project.name) {
        void run(() => bridge.invoke("rename_workspace", { id: project.id, name: trimmed }));
      }
      if (description !== (project.description ?? "")) {
        void run(() => bridge.invoke("set_description", { id: project.id, description }));
      }
    }, TYPING_SETTLE_MS);
    return () => clearTimeout(timer);
    // `project` is intentionally out: it changes identity on every reload from
    // the backend, which would restart this timer forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description]);

  async function create(path: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the project a name first.");
      return;
    }
    await run(async () => {
      await bridge.invoke("add_workspace", { name: trimmed, primaryPath: path });
    });
    onClose();
  }

  function chosen(path: string) {
    const which = picking;
    setPicking(null);
    if (!path) return;
    if (creating) {
      void create(path);
      return;
    }
    if (!project) return;
    if (which === "primary") {
      void run(() => bridge.invoke("set_primary_path", { id: project.id, path }));
    } else {
      void run(() => bridge.invoke("add_workspace_path", { id: project.id, path }));
    }
  }

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label={creating ? "New project" : project.name}>
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">{creating ? "New project" : "Project settings"}</div>
            {!creating && (
              <div className="panel-path">
                <bdi>{project.primary_path}</bdi>
              </div>
            )}
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error && <div className="panel-error">{error}</div>}

        <div className="panel-body set-body">
          <label className="set-field">
            <span className="set-label">Name</span>
            <input
              className="set-input"
              value={name}
              autoFocus={creating}
              placeholder="performance"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {!creating && (
            <label className="set-field">
              <span className="set-label">Description</span>
              <input
                className="set-input"
                value={description}
                placeholder="what this project is"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          )}

          <div className="set-field">
            <span className="set-label">Main folder</span>
            <p className="set-hint">Chats start here.</p>
            {creating ? (
              <button className="set-choose" type="button" onClick={() => setPicking("primary")}>
                Choose a folder and create
              </button>
            ) : (
              <div className="set-row">
                <span className="set-path" title={primary}>
                  <bdi>{primary}</bdi>
                </span>
                <button
                  className="set-row-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => setPicking("primary")}
                >
                  Change
                </button>
              </div>
            )}
          </div>

          {!creating && (
            <div className="set-field">
              <span className="set-label">Also include</span>
              <p className="set-hint">
                Other folders this project covers. Without them a chat cannot read or edit
                anything outside the main folder.
              </p>

              {extras.length === 0 && <div className="set-empty">No other folders yet.</div>}

              {extras.map((p) => (
                <div className="set-row" key={p}>
                  <span className="set-path" title={p}>
                    <bdi>{p}</bdi>
                  </span>
                  <button
                    className="set-row-btn is-quiet"
                    type="button"
                    disabled={busy}
                    title="Remove this folder"
                    onClick={() =>
                      void run(() =>
                        bridge.invoke("remove_workspace_path", { id: project.id, path: p }),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}

              <form
                className="set-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  const path = newPath.trim();
                  if (!path) return;
                  setNewPath("");
                  void run(() =>
                    bridge.invoke("add_workspace_path", { id: project.id, path }),
                  );
                }}
              >
                <input
                  className="set-input"
                  value={newPath}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="/path/to/another/folder"
                  onChange={(e) => setNewPath(e.target.value)}
                />
                <button className="set-row-btn" type="button" onClick={() => setPicking("extra")}>
                  Browse
                </button>
                <button className="set-row-btn" type="submit" disabled={!newPath.trim() || busy}>
                  Add
                </button>
              </form>
            </div>
          )}

          {!creating && (
            <div className="set-danger">
              <button
                className="set-row-btn"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    bridge.invoke("set_workspace_shelved", {
                      id: project.id,
                      shelved: !project.shelved,
                    }),
                  ).then(onClose)
                }
              >
                {project.shelved ? "Bring back" : "Shelve"}
              </button>
              <button
                className="set-row-btn is-danger"
                type="button"
                disabled={busy}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete “${project.name}”?`,
                    body: "It is removed from OctiqFlow only — the folders and files on disk are left exactly as they are.",
                    confirmLabel: "Delete project",
                    danger: true,
                  });
                  if (!ok) return;
                  void run(() => bridge.invoke("delete_workspace", { id: project.id })).then(() => {
                    onDeleted(project.id);
                    onClose();
                  });
                }}
              >
                Delete project
              </button>
            </div>
          )}

          {!creating && (
            <p className="set-note">
              Shelving hides a project from the list without touching anything. Deleting removes
              it from OctiqFlow only — nothing on disk is changed.
            </p>
          )}
        </div>
      </aside>

      {picking && (
        <FolderPicker
          start={picking === "primary" ? primary : primary}
          title={picking === "primary" ? "Main folder" : "Add a folder"}
          onPick={chosen}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
