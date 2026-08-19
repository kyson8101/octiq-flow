// Which agent runs your chats.
//
// The app can drive more than one CLI agent, but which ones a machine actually
// has is a fact about that machine, not about the app. Starting a chat on a
// binary that is not installed produces a chat that dies on its first line with
// a shell error, which reads as "the app is broken" rather than "codex is not
// installed here" — so this page asks the backend what resolves and says so
// plainly.
//
// The check runs through a LOGIN shell on the backend (agents.rs), because a
// GUI app does not inherit the interactive shell's PATH; the path each row shows
// is the one that shell resolved, which is the proof that the agent is really
// there.
import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import type { Provider } from "./Composer";

/** One agent the app can start, as the backend reports it. */
export type AgentInstall = {
  /** The id the chat backend takes — also the command: "claude" / "codex". */
  id: Provider;
  /** What the CLI is called on screen. */
  name: string;
  /** The command that starts it. */
  bin: string;
  installed: boolean;
  /** Where the login shell found it. Absent when it is missing — and also when
   *  it is installed but the path could not be read, so `installed` is what the
   *  UI trusts, never the presence of this. */
  path?: string | null;
};

/** Ask the backend what this machine has. Its answer is cached there for a few
 *  minutes behind the login-shell probe, so calling this often is cheap —
 *  `refresh` is what makes it ask the shell again, for someone who has just
 *  installed an agent and come back to look. */
export async function loadAgents(refresh = false): Promise<AgentInstall[]> {
  return await bridge.invoke<AgentInstall[]>("agent_installs", { refresh });
}

export function AgentsPage({
  agents,
  current,
  onPick,
  onReload,
  onClose,
}: {
  agents: AgentInstall[];
  /** The agent new chats currently start with. */
  current: Provider;
  onPick: (agent: Provider) => void;
  /** Ask the backend again — for after installing one in a terminal. */
  onReload: () => void;
  onClose: () => void;
}) {
  // An empty list is "we have no answer", not "there are no agents" — the
  // backend always names every agent it knows, present or not. Saying "none
  // installed" while the socket is still coming up would be a lie that sends
  // someone off installing a CLI they already have.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 1500);
    return () => clearTimeout(t);
  }, []);

  const noAnswer = agents.length === 0;
  const none = !noAnswer && agents.every((a) => !a.installed);

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label="Agents">
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">Agents</div>
            <div className="shelf-sub">what this machine can run · tap one to use it</div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {none && (
          <div className="shelf-error">
            No agent CLI found on this machine. Install one, then tap Check again.
          </div>
        )}

        {noAnswer && (
          <div className={waited ? "shelf-error" : "agent-note agent-waiting"}>
            {waited ? "Could not ask this machine. Tap Check again." : "Asking this machine…"}
          </div>
        )}

        <div className="agent-list">
          {agents.map((a) => {
            const chosen = a.id === current;
            return (
              <button
                key={a.id}
                className={`agent-row ${chosen ? "is-on" : ""} ${a.installed ? "" : "is-missing"}`}
                type="button"
                disabled={!a.installed}
                aria-pressed={chosen}
                onClick={() => onPick(a.id)}
              >
                <span className="agent-row-top">
                  <span className="agent-name">{a.name}</span>
                  <span className="agent-state">
                    {!a.installed ? "not installed" : chosen ? "✓ in use" : "use this"}
                  </span>
                </span>
                <span className="agent-bin">{a.bin}</span>
                {a.installed ? (
                  a.path && (
                    // RTL + <bdi>, as the shelf cards do: a path is identified
                    // by its end, so it truncates from the left.
                    <span className="agent-path">
                      <bdi>{a.path}</bdi>
                    </span>
                  )
                ) : (
                  <span className="agent-path agent-path-missing">
                    not on this machine's PATH
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="agent-foot">
          {/* Installing an agent happens in a terminal, not here — but the
              backend caches its probe for minutes, so without this the newly
              installed agent stays greyed out for no visible reason. */}
          <button className="agent-recheck" type="button" onClick={onReload}>
            Check again
          </button>
          <span className="agent-note">
            A chat that is already running keeps its agent. This decides what a new
            chat starts with.
          </span>
        </div>
      </aside>
    </>
  );
}
