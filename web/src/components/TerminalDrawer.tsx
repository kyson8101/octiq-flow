// The terminal drawer: a tab strip, the project's saved commands, and the shell
// under them (cards 65, 68).
//
// A monorepo needs more than one shell at a time — `pnpm dev` in web, another
// in api — so a project holds a list of terminals rather than the single one it
// used to. Only the ACTIVE tab's pane is mounted: a terminal nobody is looking
// at does not need an xterm, let alone a WebGL context, and the shell behind it
// keeps running either way. Coming back to it replays what it printed while it
// was gone (card 64), which is what makes unmounting free.
//
// The row under the tabs is the project's own commands (card 68). The things
// you run in a project are the same few every day, and typing them into a fresh
// shell each time is the part worth removing: one click opens a tab named after
// the command, in this project's folder, with the command already running.
import { useCallback, useState } from "react";

import { bridge } from "../lib/bridge";
import { isReady, parseCommands, sameCommand, type Command } from "../lib/commands";
import {
  activate,
  addTab,
  closeTab,
  parseStore,
  renameTab,
  tabsFor,
  type Store,
  type Tabs,
} from "../lib/terminals";
import { useConfirm } from "./Confirm";
import type { Project } from "./Sidebar";
import { TerminalPane } from "./Terminal";

/** Which terminals each project has. This browser's, like the rest of the
 *  appearance settings — the shells themselves are on the server and are found
 *  again by id, so another device simply opens its own tabs onto them. */
const TERMS_KEY = "octiq.v2.terminals";

/** The project as the drawer needs it: the saved commands ride along with it on
 *  `list_workspaces`, in the same `actions` field the desktop UI has always
 *  written. Typed loosely here and read through `parseCommands`, because it is
 *  a file older builds wrote. */
type DrawerProject = Project & { actions?: unknown };

/** Which command the form is open on: an existing one being edited, or "new". */
type Editing = Command | "new" | null;

export function TerminalDrawer({
  project,
  onCommandsChanged,
  onHide,
}: {
  project: DrawerProject;
  /** A command was added, changed, or deleted: the project list is the store's
   *  only view, so it has to be read again. */
  onCommandsChanged: () => void;
  /** Called when the drawer should go away — the ✕, or the last tab closing. */
  onHide: () => void;
}) {
  const [store, setStore] = useState<Store>(() => {
    try {
      return parseStore(localStorage.getItem(TERMS_KEY));
    } catch {
      // Private browsing, or storage full. Tabs for this session only.
      return {};
    }
  });
  /** The tab whose name is being edited, if any. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  /** A save that the backend refused, shown by the form rather than swallowed. */
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const tabs = tabsFor(store, project.id);
  const cwd = project.primary_path ?? "";
  const commands = parseCommands(project.actions);
  const active = tabs.tabs.find((t) => t.id === tabs.active);

  const write = useCallback(
    (next: Tabs) => {
      setStore((prev) => {
        const merged = { ...prev, [project.id]: next };
        try {
          localStorage.setItem(TERMS_KEY, JSON.stringify(merged));
        } catch {
          // Not worth interrupting anyone over: the tabs still work, they just
          // will not be here next time.
        }
        return merged;
      });
    },
    [project.id],
  );

  const close = useCallback(
    (id: string) => {
      // The shell dies with the tab — that is what makes this different from
      // the drawer's own ✕, which leaves it running.
      bridge.invoke("pty_close", { id }).catch(() => {});
      const next = closeTab(tabs, id);
      write(next);
      if (!next.tabs.length) onHide();
    },
    [tabs, write, onHide],
  );

  /** Run a saved command in a terminal of its own. Always a NEW tab: the shell
   *  you are looking at may be busy with something you would rather not
   *  interrupt, and two runs of the same command side by side is the point of
   *  having tabs at all. */
  const run = useCallback(
    (row: Command) => {
      write(addTab(tabs, project.id, { name: row.label, cmd: row.command }));
    },
    [tabs, project.id, write],
  );

  const save = useCallback(
    async (label: string, command: string) => {
      setError(null);
      try {
        if (editing && editing !== "new") {
          // Nothing typed: closing the form is the whole of the right answer,
          // rather than a write to disk and a project reload for no change.
          if (!sameCommand(editing, label, command)) {
            await bridge.invoke("update_action", {
              workspaceId: project.id,
              actionId: editing.id,
              label,
              command,
            });
            onCommandsChanged();
          }
        } else {
          await bridge.invoke("add_action", { workspaceId: project.id, label, command });
          onCommandsChanged();
        }
        setEditing(null);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [editing, project.id, onCommandsChanged],
  );

  const remove = useCallback(
    async (row: Command) => {
      const ok = await confirm({
        title: `Delete the “${row.label}” command?`,
        body: "Only the button goes. Any terminal it opened keeps running.",
        confirmLabel: "Delete command",
        danger: true,
      });
      if (!ok) return;
      try {
        await bridge.invoke("delete_action", { workspaceId: project.id, actionId: row.id });
        setEditing(null);
        onCommandsChanged();
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [confirm, project.id, onCommandsChanged],
  );

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">{project.name}</span>
        <span className="drawer-path" title={cwd}>
          <bdi>{cwd}</bdi>
        </span>
        <button
          className="drawer-close"
          type="button"
          title="Hide the terminal (every shell keeps running)"
          onClick={onHide}
        >
          ✕
        </button>
      </div>

      <div className="term-tabs" role="tablist">
        {tabs.tabs.map((term) =>
          renaming === term.id ? (
            <input
              key={term.id}
              className="term-tab-name"
              defaultValue={term.name}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  write(renameTab(tabs, term.id, e.currentTarget.value));
                  setRenaming(null);
                }
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span
              key={term.id}
              className={`term-tab ${term.id === tabs.active ? "is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={term.id === tabs.active}
                title={term.cmd ? `Double-click to rename — running ${term.cmd}` : "Double-click to rename"}
                onClick={() => write(activate(tabs, term.id))}
                onDoubleClick={() => setRenaming(term.id)}
              >
                {term.name}
              </button>
              <button
                className="term-tab-close"
                type="button"
                title="Close this terminal (ends what is running in it)"
                onClick={() => close(term.id)}
              >
                ✕
              </button>
            </span>
          ),
        )}
        <button
          className="term-tab-add"
          type="button"
          title="Another shell in this project"
          onClick={() => write(addTab(tabs, project.id))}
        >
          +
        </button>
      </div>

      {/* The project's own commands. Kept even when the list is empty — the
          lone "+ Command" is how anyone finds out the row exists. */}
      <div className="cmd-bar">
        {commands.map((row) => (
          <button
            key={row.id}
            className="cmd-chip"
            type="button"
            title={`${row.command} — double-click to edit`}
            onClick={() => run(row)}
            onDoubleClick={() => {
              setError(null);
              setEditing(row);
            }}
          >
            {row.label}
          </button>
        ))}
        <button
          className="cmd-chip is-add"
          type="button"
          title="Save a command you run in this project"
          onClick={() => {
            setError(null);
            setEditing("new");
          }}
        >
          + Command
        </button>
      </div>

      {editing && (
        <CommandForm
          // Keyed so switching straight from one chip's form to another's
          // refills the fields rather than keeping the first one's text.
          key={editing === "new" ? "new" : editing.id}
          row={editing === "new" ? null : editing}
          error={error}
          onSave={save}
          onDelete={editing === "new" ? undefined : () => void remove(editing)}
          onCancel={() => {
            setError(null);
            setEditing(null);
          }}
        />
      )}

      {/* Keyed by terminal id, so switching tab really is a different pane
          rather than the same xterm re-pointed at another PTY. */}
      <TerminalPane
        key={tabs.active}
        id={tabs.active}
        cwd={cwd}
        cmd={active?.cmd}
        env={project.env ?? {}}
      />
    </div>
  );
}

/** The one form, for adding a command and for editing one. Two fields: what the
 *  chip says, and what the shell is given. */
function CommandForm({
  row,
  error,
  onSave,
  onDelete,
  onCancel,
}: {
  row: Command | null;
  error: string | null;
  onSave: (label: string, command: string) => void;
  /** Absent while adding — there is nothing yet to delete. */
  onDelete?: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(row?.label ?? "");
  const [command, setCommand] = useState(row?.command ?? "");
  const ready = isReady(label, command);

  return (
    <form
      className="cmd-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSave(label.trim(), command.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <input
        className="cmd-form-label"
        placeholder="dev"
        aria-label="Button name"
        value={label}
        autoFocus
        onChange={(e) => setLabel(e.target.value)}
      />
      <input
        className="cmd-form-command"
        placeholder="pnpm dev"
        aria-label="Command to run"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <button className="cmd-form-save" type="submit" disabled={!ready}>
        Save
      </button>
      {onDelete && (
        <button className="cmd-form-delete" type="button" onClick={onDelete}>
          Delete
        </button>
      )}
      <button className="cmd-form-cancel" type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="cmd-form-error">{error}</span>}
    </form>
  );
}
