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
import { moveSiblingGroupBy } from "../lib/projectOrder";
import { FolderPicker } from "./FolderPicker";
import { useConfirm } from "./Confirm";

export type ProjectDetail = {
  id: string;
  name: string;
  primary_path?: string;
  paths?: string[];
  description?: string;
  shelved?: boolean;
  sibling_ids?: string[];
  /** Set on every terminal and chat started in this project. Absent on an old
   *  backend, same as an empty object. */
  env?: Record<string, string>;
};

/** `project.env` as the textarea shows it: one `KEY=value` per line, sorted by
 *  key so the same environment always renders the same text. */
function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** The reverse: what the textarea holds, back into `{KEY: value}`. Blank lines
 *  and comments (`#…`) are ignored; a line with no `=` is a key with an empty
 *  value. */
function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = (at === -1 ? line : line.slice(0, at)).trim();
    const value = at === -1 ? "" : line.slice(at + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/** How long to wait after the last keystroke before saving text. */
const TYPING_SETTLE_MS = 600;

export function ProjectSettings({
  project,
  projects,
  onChanged,
  onClose,
  onDeleted,
}: {
  /** The project to edit, or null to create a new one. */
  project: ProjectDetail | null;
  /** Every project, including shelved ones, for ordering and sibling links. */
  projects: ProjectDetail[];
  /** Something was saved: reload the project list. */
  onChanged: () => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const creating = !project;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [envText, setEnvText] = useState(envToText(project?.env));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which folder the picker is choosing: the main one, or another to add.
  const [picking, setPicking] = useState<"primary" | "extra" | null>(null);
  const [newPath, setNewPath] = useState("");
  const [siblingChoice, setSiblingChoice] = useState("");
  const confirm = useConfirm();

  const primary = project?.primary_path ?? "";
  const extras = project?.paths ?? [];
  const siblingIds = new Set(project?.sibling_ids ?? []);
  const siblings = projects.filter((candidate) => siblingIds.has(candidate.id));
  const availableSiblings = projects.filter(
    (candidate) => candidate.id !== project?.id && !siblingIds.has(candidate.id),
  );
  const orderedPeers = project
    ? projects.filter((candidate) => Boolean(candidate.shelved) === Boolean(project.shelved))
    : [];
  const position = project ? orderedPeers.findIndex((candidate) => candidate.id === project.id) : -1;

  // Returns whether it succeeded, so a caller that closes the panel on
  // completion (create, below) can choose not to — closing on a rejected
  // call would carry the error off screen along with the panel that shows it.
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return false;
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
      const nextEnv = textToEnv(envText);
      if (!sameEnv(nextEnv, project.env ?? {})) {
        void run(() => bridge.invoke("set_workspace_env", { id: project.id, env: nextEnv }));
      }
    }, TYPING_SETTLE_MS);
    return () => clearTimeout(timer);
    // `project` is intentionally out: it changes identity on every reload from
    // the backend, which would restart this timer forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, envText]);

  async function create(path: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the project a name first.");
      return;
    }
    const ok = await run(async () => {
      await bridge.invoke("add_workspace", { name: trimmed, primaryPath: path });
    });
    // Only on success — a rejected create (e.g. a colliding label) leaves the
    // panel open with `error` showing, same as every other failed call here.
    if (ok) onClose();
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

  function move(direction: -1 | 1) {
    if (!project) return;
    const orderedIds = moveSiblingGroupBy(orderedPeers, project.id, direction);
    void run(() => bridge.invoke("reorder_workspaces", { orderedIds }));
  }

  async function linkSibling() {
    if (!project || !siblingChoice) return;
    const linked = await run(() =>
      bridge.invoke("set_workspace_sibling", {
        id: project.id,
        siblingId: siblingChoice,
        linked: true,
      }),
    );
    if (linked) setSiblingChoice("");
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

          {!creating && (
            <label className="set-field">
              <span className="set-label">Environment</span>
              <textarea
                className="set-input set-env"
                value={envText}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="CLAUDE_CONFIG_DIR=~/.claude-novel"
                onChange={(e) => setEnvText(e.target.value)}
              />
              <p className="set-hint">
                Set on every terminal and chat started in this project. One per line, e.g.
                CLAUDE_CONFIG_DIR=~/.claude-novel
              </p>
            </label>
          )}

          {!creating && (
            <div className="set-field">
              <span className="set-label">Position</span>
              <p className="set-hint">Drag this project in the sidebar, or move it here.</p>
              <div className="set-order">
                <button
                  className="set-row-btn"
                  type="button"
                  disabled={busy || position <= 0}
                  onClick={() => move(-1)}
                >
                  Move up
                </button>
                <span className="set-order-at">
                  {position + 1} of {orderedPeers.length}
                </span>
                <button
                  className="set-row-btn"
                  type="button"
                  disabled={busy || position < 0 || position >= orderedPeers.length - 1}
                  onClick={() => move(1)}
                >
                  Move down
                </button>
              </div>
            </div>
          )}

          {!creating && project && (
            <div className="set-field">
              <span className="set-label">Sibling projects</span>
              <p className="set-hint">
                Link related projects in both directions. Linked active projects are kept
                together in the sidebar.
              </p>

              {siblings.length === 0 && <div className="set-empty">No sibling projects yet.</div>}

              {siblings.map((sibling) => (
                <div className="set-row" key={sibling.id}>
                  <span className="set-project-name">{sibling.name}</span>
                  {sibling.shelved && <span className="set-project-state">Shelved</span>}
                  <button
                    className="set-row-btn is-quiet"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        bridge.invoke("set_workspace_sibling", {
                          id: project.id,
                          siblingId: sibling.id,
                          linked: false,
                        }),
                      )
                    }
                  >
                    Unlink
                  </button>
                </div>
              ))}

              {availableSiblings.length > 0 && (
                <div className="set-add set-sibling-add">
                  <select
                    className="set-input"
                    value={siblingChoice}
                    aria-label="Project to link"
                    onChange={(event) => setSiblingChoice(event.target.value)}
                  >
                    <option value="">Choose a project…</option>
                    {availableSiblings.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}{candidate.shelved ? " · Shelved" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    className="set-row-btn"
                    type="button"
                    disabled={busy || !siblingChoice}
                    onClick={() => void linkSibling()}
                  >
                    Link
                  </button>
                </div>
              )}
            </div>
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
