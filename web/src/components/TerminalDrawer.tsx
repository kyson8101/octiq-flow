// The terminal drawer: a tab strip, and the shell under it (card 65).
//
// A monorepo needs more than one shell at a time — `pnpm dev` in web, another
// in api — so a project holds a list of terminals rather than the single one it
// used to. Only the ACTIVE tab's pane is mounted: a terminal nobody is looking
// at does not need an xterm, let alone a WebGL context, and the shell behind it
// keeps running either way. Coming back to it replays what it printed while it
// was gone (card 64), which is what makes unmounting free.
import { useCallback, useState } from "react";

import { bridge } from "../lib/bridge";
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
import type { Project } from "./Sidebar";
import { TerminalPane } from "./Terminal";

/** Which terminals each project has. This browser's, like the rest of the
 *  appearance settings — the shells themselves are on the server and are found
 *  again by id, so another device simply opens its own tabs onto them. */
const TERMS_KEY = "octiq.v2.terminals";

export function TerminalDrawer({
  project,
  onHide,
}: {
  project: Project;
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

  const tabs = tabsFor(store, project.id);
  const cwd = project.primary_path ?? "";

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
                title="Double-click to rename"
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

      {/* Keyed by terminal id, so switching tab really is a different pane
          rather than the same xterm re-pointed at another PTY. */}
      <TerminalPane key={tabs.active} id={tabs.active} cwd={cwd} />
    </div>
  );
}
