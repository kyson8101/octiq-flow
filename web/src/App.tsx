// OctiqFlow v2 — the chat client.
//
// Web-first by design: this is the same app whether it runs in a browser on a
// phone or in the desktop window, because it only ever talks to the backend
// over the WebSocket (lib/bridge.ts). The machine running OctiqFlow owns the
// agents; this is a view onto them.
//
// A project is a FOLDER of conversations. The conversations are kept in the
// browser (lib/store.ts) with the agent's session id beside each one, so
// reopening a chat shows it at once and continuing it resumes the SAME agent
// session rather than starting a stranger.
//
// A live chat is one agent process on the server (agent_chat.rs), keyed by
// `chat:<projectId>:<uuid>`. Its events arrive as `chat-event` and fold into a
// conversation in lib/chat.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./lib/bridge";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./lib/chat";
import {
  byProject,
  loadConversations,
  saveConversations,
  titleFrom,
  type Conversation,
} from "./lib/store";
import { MessageList } from "./components/MessageList";
import { Composer, MODELS, type ModelChoice, type PermissionMode } from "./components/Composer";
import { Connect } from "./components/Connect";
import { Sidebar, type Project } from "./components/Sidebar";

type Workspace = Project & { paths?: string[]; shelved?: boolean };

const CHOICE_KEY = "octiq.v2.model";
const PERM_KEY = "octiq.v2.permission";
const OPEN_KEY = "octiq.v2.openFolders";
const CMDS_KEY = "octiq.v2.commands";

export default function App() {
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [drawer, setDrawer] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Which folders are open, kept between visits — a tree that forgets is a
  // tree you re-open every time.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(OPEN_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  });
  const [choice, setChoice] = useState<ModelChoice>(
    () => MODELS.find((m) => m.id === localStorage.getItem(CHOICE_KEY)) ?? MODELS[0],
  );
  // What the agent may do unattended. Defaults to the cautious end: a chat has
  // no way to answer a permission prompt, so this is the whole of the answer.
  const [permission, setPermission] = useState<PermissionMode>(
    () => (localStorage.getItem(PERM_KEY) as PermissionMode | null) ?? "plan",
  );

  // The key of the RUNNING agent process, or null when this conversation is
  // only on screen. Random, not a counter: a counter restarts at 0 on every
  // page load and would collide with a process still running under that key.
  const chatKey = useRef<string | null>(null);
  // The session id to resume when this conversation speaks again.
  const resumeId = useRef<string | undefined>(undefined);

  useEffect(() => bridge.onState(setConn), []);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...expanded]));
    } catch {
      /* storage blocked: the tree just forgets again next time */
    }
  }, [expanded]);

  useEffect(() => {
    bridge
      .invoke<Workspace[]>("list_workspaces")
      .then((list) => {
        const active = (list ?? []).filter((w) => !w.shelved);
        setWorkspaces(active);
        setProjectId((cur) => cur ?? active[0]?.id ?? null);
        // The project you land in is open; anything else keeps its saved state.
        if (active[0]) setExpanded((prev) => new Set(prev).add(active[0].id));
      })
      .catch(() => setWorkspaces([]));
  }, []);

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

  // The slash commands a session reports at startup, kept per project so the
  // menu works from the moment the composer opens — otherwise it would be empty
  // until a chat had already been running, which is exactly when nobody needs
  // to look up a command.
  const [commands, setCommands] = useState<Record<string, string[]>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(CMDS_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (!chat.commands?.length || !projectId) return;
    setCommands((prev) => {
      if (prev[projectId]?.length === chat.commands!.length) return prev;
      const next = { ...prev, [projectId]: chat.commands! };
      try {
        localStorage.setItem(CMDS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the menu falls back to this session only */
      }
      return next;
    });
  }, [chat.commands, projectId]);

  // Keep the agent's session id for the resume path as soon as it reports one.
  useEffect(() => {
    if (chat.sessionId) resumeId.current = chat.sessionId;
  }, [chat.sessionId]);

  // Save the conversation as it grows. Storing on every delta would serialise
  // the whole transcript 60 times a second, so this waits for a quiet moment.
  useEffect(() => {
    if (!conversationId || !projectId || chat.messages.length === 0) return;
    const timer = setTimeout(() => {
      setConversations((prev) => {
        const rest = prev.filter((c) => c.id !== conversationId);
        const next: Conversation = {
          id: conversationId,
          projectId,
          title: titleFrom(chat.messages),
          sessionId: resumeId.current,
          messages: chat.messages,
          modelId: choice.id,
          permission,
          updatedAt: Date.now(),
        };
        const list = [next, ...rest];
        saveConversations(list);
        return list;
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [chat.messages, chat.busy, conversationId, projectId, choice.id, permission]);

  // Leaving the page ends the RUNNING process. The transcript is already saved,
  // and its session id with it, so the conversation reopens and continues.
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
  const grouped = useMemo(() => byProject(conversations), [conversations]);

  /** Drop the running process, keeping whatever is on screen. */
  const releaseAgent = useCallback(() => {
    if (!chatKey.current) return;
    bridge.invoke("chat_stop", { key: chatKey.current }).catch(() => {});
    chatKey.current = null;
  }, []);

  const startBlank = useCallback(
    (forProject: string) => {
      releaseAgent();
      resumeId.current = undefined;
      setProjectId(forProject);
      setConversationId(crypto.randomUUID());
      setChat(emptyChat());
      setDrawer(false);
    },
    [releaseAgent],
  );

  const openConversation = useCallback(
    (c: Conversation) => {
      releaseAgent();
      setProjectId(c.projectId);
      setConversationId(c.id);
      resumeId.current = c.sessionId;
      setChat({ ...emptyChat(), messages: c.messages });
      if (c.modelId) {
        const model = MODELS.find((m) => m.id === c.modelId);
        if (model) setChoice(model);
      }
      if (c.permission) setPermission(c.permission as PermissionMode);
      setDrawer(false);
    },
    [releaseAgent],
  );

  const pickProject = useCallback(
    (id: string) => {
      setExpanded((s) => new Set(s).add(id));
      // Opening a project shows its most recent conversation, the way coming
      // back to a room shows what was left on the table.
      const recent = (grouped.get(id) ?? [])[0];
      if (recent) openConversation(recent);
      else startBlank(id);
    },
    [grouped, startBlank, openConversation],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const list = prev.filter((c) => c.id !== id);
        saveConversations(list);
        return list;
      });
      if (id === conversationId) {
        releaseAgent();
        setConversationId(null);
        setChat(emptyChat());
      }
    },
    [conversationId, releaseAgent],
  );

  const send = useCallback(
    async (text: string) => {
      if (!project) return;
      if (!conversationId) setConversationId(crypto.randomUUID());
      setChat((s) => addUserTurn(s, text));

      // No process yet — a new chat, or one being picked back up.
      if (!chatKey.current) {
        const key = `chat:${project.id}:${crypto.randomUUID()}`;
        chatKey.current = key;
        try {
          await bridge.invoke("chat_start", {
            key,
            cwd: project.primary_path ?? "",
            agent: choice.agent,
            model: choice.flag || null,
            permissionMode: permission,
            prompt: text,
            // Continuing an earlier conversation: the agent picks its own
            // context back up instead of being handed a transcript to read.
            resume: resumeId.current ?? null,
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
    [project, choice, permission, conversationId],
  );

  /** Stop the running turn. The session survives, ready for the next one. */
  const stop = useCallback(() => {
    if (!chatKey.current) return;
    setChat((s) => ({ ...s, stopping: true }));
    bridge.invoke("chat_interrupt", { key: chatKey.current }).catch(() => {});
  }, []);

  /** Changing what the agent may do starts a new agent: the mode is fixed when
   *  the process spawns, so leaving the old one running would make the pill on
   *  screen a lie about the chat in front of you. */
  const changePermission = useCallback(
    (p: PermissionMode) => {
      setPermission(p);
      localStorage.setItem(PERM_KEY, p);
      releaseAgent();
    },
    [releaseAgent],
  );

  if (conn === "unauthorized") return <Connect />;

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      {conn !== "open" && (
        <div className="conn-strip">
          {conn === "connecting" ? "Connecting to OctiqFlow…" : "Reconnecting…"}
        </div>
      )}

      <header className="topbar">
        <button
          className="icon-btn menu"
          type="button"
          aria-label="Projects"
          onClick={() => setDrawer((v) => !v)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div className="topbar-title">{project?.name ?? "OctiqFlow"}</div>
        <button
          className="icon-btn"
          type="button"
          title="New chat"
          onClick={() => project && startBlank(project.id)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </header>

      <div className="body">
        <div className="scrim" onClick={() => setDrawer(false)} />

        <Sidebar
          projects={workspaces}
          conversations={grouped}
          currentProject={projectId}
          currentConversation={conversationId}
          expanded={expanded}
          onToggle={(id) =>
            setExpanded((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onPickProject={pickProject}
          onPickConversation={openConversation}
          onNewChat={startBlank}
          onDelete={deleteConversation}
        />

        <main className="main">
          {chat.messages.length === 0 ? (
            <div className="hero">
              <h1 className="hero-title">
                What do you want to do{project ? ` in ${project.name}` : ""}?
              </h1>
              {resumeId.current && <p className="hero-sub">continuing an earlier session</p>}
            </div>
          ) : (
            <MessageList
              messages={chat.messages}
              busy={chat.busy}
              stoppedAt={chat.stoppedAt}
              cwd={project?.primary_path ?? ""}
            />
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
            permission={permission}
            onPermission={changePermission}
            onSend={send}
            onStop={stop}
            busy={chat.busy}
            disabled={!project}
            commands={(projectId && commands[projectId]) || []}
          />

          {(chat.lastDurationMs !== undefined || chat.model) && (
            <div className="statusline">
              {chat.model && <span>{chat.model}</span>}
              {chat.lastDurationMs !== undefined && (
                <span>{(chat.lastDurationMs / 1000).toFixed(1)}s</span>
              )}
              {chat.lastCostUsd !== undefined && <span>${chat.lastCostUsd.toFixed(3)}</span>}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
