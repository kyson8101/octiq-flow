// OctiqFlow v2 — the chat client.
//
// Web-first by design: this is the same app whether it runs in a browser on a
// phone or in the desktop window, because it only ever talks to the backend
// over the WebSocket (lib/bridge.ts). The machine running OctiqFlow owns the
// agents; this is a view onto them.
//
// A chat is one agent process on the server (agent_chat.rs), keyed by
// `chat:<projectId>:<n>`. Its events arrive as `chat-event` and fold into a
// conversation in lib/chat.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./lib/bridge";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./lib/chat";
import { MessageList } from "./components/MessageList";
import { Composer, MODELS, type ModelChoice } from "./components/Composer";
import { Connect } from "./components/Connect";

type Workspace = {
  id: string;
  name: string;
  primary_path?: string;
  paths?: string[];
  shelved?: boolean;
};

const CHOICE_KEY = "octiq.v2.model";

export default function App() {
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [drawer, setDrawer] = useState(false);
  const [choice, setChoice] = useState<ModelChoice>(
    () => MODELS.find((m) => m.id === localStorage.getItem(CHOICE_KEY)) ?? MODELS[0],
  );

  // The key of the running chat process, or null before the first send. It is
  // random, not a counter: a counter restarts at 0 on every page load, and the
  // agent process from BEFORE the reload is still running under that key on the
  // server, so the next chat would collide with it and be refused.
  const chatKey = useRef<string | null>(null);

  useEffect(() => bridge.onState(setConn), []);

  useEffect(() => {
    bridge
      .invoke<Workspace[]>("list_workspaces")
      .then((list) => {
        const active = (list ?? []).filter((w) => !w.shelved);
        setWorkspaces(active);
        setProjectId((cur) => cur ?? active[0]?.id ?? null);
      })
      .catch(() => setWorkspaces([]));
  }, []);

  // Every chat event for THIS chat folds into the conversation. Events for
  // other chats (another browser, another project) are ignored here.
  useEffect(
    () =>
      bridge.on<{ key: string; event: unknown }>("chat-event", (payload) => {
        if (!payload || payload.key !== chatKey.current) return;
        setChat((s) => reduceChat(s, payload.event));
      }),
    [],
  );

  useEffect(
    () =>
      bridge.on<{ key: string; kind: string; text: string; code: number | null }>(
        "chat-status",
        (payload) => {
          if (!payload || payload.key !== chatKey.current) return;
          setChat((s) =>
            payload.kind === "exit"
              ? { ...s, busy: false, exited: { code: payload.code } }
              : { ...s, notices: [...s.notices, payload.text].slice(-8) },
          );
        },
      ),
    [],
  );

  // Leaving the page ends this chat. Without it the agent process would keep
  // running on the server with no way back to it — the transcript lives in this
  // tab, so a reload could never rejoin the conversation it belonged to.
  // (Rejoining a running chat is possible — chat_list gives the keys and the
  // agent's own session id supports --resume — but that is not built yet.)
  useEffect(() => {
    const stop = () => {
      if (chatKey.current) bridge.invoke("chat_stop", { key: chatKey.current }).catch(() => {});
    };
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, []);

  const project = useMemo(
    () => workspaces.find((w) => w.id === projectId) ?? null,
    [workspaces, projectId],
  );

  /** Switching project ends the conversation: a chat is bound to the folder its
   *  agent was started in, so carrying it across would be a lie about what the
   *  agent can see. */
  const pickProject = useCallback((id: string) => {
    setProjectId(id);
    setDrawer(false);
    if (chatKey.current) {
      bridge.invoke("chat_stop", { key: chatKey.current }).catch(() => {});
      chatKey.current = null;
    }
    setChat(emptyChat());
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!project) return;
      setChat((s) => addUserTurn(s, text));

      // First turn: start the agent, with this prompt as its opening message.
      if (!chatKey.current) {
        const key = `chat:${project.id}:${crypto.randomUUID()}`;
        chatKey.current = key;
        try {
          await bridge.invoke("chat_start", {
            key,
            cwd: project.primary_path ?? "",
            agent: choice.agent,
            model: choice.flag || null,
            permissionMode: "acceptEdits",
            prompt: text,
          });
        } catch (err) {
          chatKey.current = null;
          setChat((s) => ({
            ...s,
            busy: false,
            notices: [...s.notices, String((err as Error).message ?? err)],
          }));
        }
        return;
      }

      // Later turns go down the same process's stdin.
      try {
        await bridge.invoke("chat_send", { key: chatKey.current, text });
      } catch (err) {
        setChat((s) => ({
          ...s,
          busy: false,
          notices: [...s.notices, String((err as Error).message ?? err)],
        }));
      }
    },
    [project, choice],
  );

  const newChat = useCallback(() => {
    if (chatKey.current) {
      bridge.invoke("chat_stop", { key: chatKey.current }).catch(() => {});
      chatKey.current = null;
    }
    setChat(emptyChat());
  }, []);

  // A refused token is not a connection problem to wait out — it needs the
  // user, so it gets the whole screen instead of a strip.
  if (conn === "unauthorized") return <Connect />;

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      {conn !== "open" && (
        <div className="conn-strip">
          {conn === "connecting" ? "Connecting to OctiqFlow…" : "Reconnecting…"}
        </div>
      )}

      <header className="topbar">
        <button className="icon-btn menu" type="button" aria-label="Projects" onClick={() => setDrawer((v) => !v)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div className="topbar-title">{project?.name ?? "OctiqFlow"}</div>
        <button className="icon-btn" type="button" title="New chat" onClick={newChat}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </header>

      <div className="body">
        <div className="scrim" onClick={() => setDrawer(false)} />

        <nav className="sidebar">
          <div className="sidebar-head">Projects</div>
          <ul className="proj-list">
            {workspaces.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className={`proj ${w.id === projectId ? "is-on" : ""}`}
                  onClick={() => pickProject(w.id)}
                >
                  <span className="proj-name">{w.name}</span>
                  {w.primary_path && <span className="proj-path">{w.primary_path.split("/").slice(-1)[0]}</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="main">
          {chat.messages.length === 0 ? (
            <div className="hero">
              <h1 className="hero-title">
                What do you want to do{project ? ` in ${project.name}` : ""}?
              </h1>
              {chat.cwd && <p className="hero-sub">{chat.cwd}</p>}
            </div>
          ) : (
            <MessageList messages={chat.messages} busy={chat.busy} />
          )}

          {chat.notices.length > 0 && (
            <div className="notices">
              {chat.notices.map((n, i) => (
                <div key={i} className="notice">
                  {n}
                </div>
              ))}
            </div>
          )}

          <Composer
            choice={choice}
            onChoice={(c) => {
              setChoice(c);
              localStorage.setItem(CHOICE_KEY, c.id);
            }}
            onSend={send}
            busy={chat.busy}
            disabled={!project}
          />

          {(chat.lastDurationMs !== undefined || chat.model) && (
            <div className="statusline">
              {chat.model && <span>{chat.model}</span>}
              {chat.lastDurationMs !== undefined && <span>{(chat.lastDurationMs / 1000).toFixed(1)}s</span>}
              {chat.lastCostUsd !== undefined && <span>${chat.lastCostUsd.toFixed(3)}</span>}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
