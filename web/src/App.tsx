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
// `chat:<conversationId>`. Its events arrive as `chat-event` and fold into a
// conversation in lib/chat.ts.
//
// Chats run in PARALLEL. Switching to another one does not stop the one you
// leave — its answer arrives, folds into its own transcript, and is saved,
// whether or not it is the chat on screen.
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
import {
  Composer,
  MODELS,
  type Attachment,
  type Effort,
  effortFor,
  type ModelChoice,
  type AccessLevel,
} from "./components/Composer";
import { Connect } from "./components/Connect";
import { Sidebar, type Project } from "./components/Sidebar";
import { ProjectSettings } from "./components/ProjectSettings";
import { Usage } from "./components/Usage";
import { TerminalPane } from "./components/Terminal";
import { useConfirm } from "./components/Confirm";

type Workspace = Project & { paths?: string[]; shelved?: boolean; description?: string };

/** The process key for a conversation. Derived from the conversation id rather
 *  than random, so an event coming back from the server says which conversation
 *  it belongs to without a lookup table, and so one conversation can never end
 *  up with two processes. */
const keyFor = (conversationId: string) => `chat:${conversationId}`;
const convOf = (key: string) => (key.startsWith("chat:") ? key.slice(5) : null);

/** The state of a chat that has nothing in it yet. One shared object: nothing
 *  mutates a ChatState in place, so every not-yet-started conversation can
 *  point at the same one. */
const EMPTY: ChatState = emptyChat();

const CHOICE_KEY = "octiq.v2.model";
const ACCESS_KEY = "octiq.v2.access";
const OPEN_KEY = "octiq.v2.openFolders";
const CMDS_KEY = "octiq.v2.commands";
const EFFORT_KEY = "octiq.v2.effort";
const TERM_KEY = "octiq.v2.terminalOpen";

export default function App() {
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  // Every chat that is loaded or running, keyed by conversation id. Chats run
  // in PARALLEL: switching to another one leaves this one working, and its
  // answer lands in here whether or not you are looking at it.
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  // The conversations with a live agent process behind them.
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [drawer, setDrawer] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Which project's settings are open: an id, "new" while creating one, or
  // null for closed.
  const [settingsFor, setSettingsFor] = useState<string | "new" | null>(null);
  // The shell drawer under the chat. Remembered, because someone who works
  // with it open wants it open next time too.
  const [termOpen, setTermOpen] = useState(() => localStorage.getItem(TERM_KEY) === "1");
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
  const [access, setAccess] = useState<AccessLevel>(() => {
    const saved = localStorage.getItem(ACCESS_KEY);
    // Values written before this was one shared level, when it held Claude's
    // own permission-mode names.
    const legacy: Record<string, AccessLevel> = {
      plan: "read",
      acceptEdits: "edit",
      bypassPermissions: "full",
    };
    if (saved && legacy[saved]) return legacy[saved];
    return saved === "read" || saved === "edit" || saved === "full" ? saved : "read";
  });
  // How hard the model thinks. Fixed on the agent's command line, so changing
  // it takes effect from the next message — see changeEffort.
  const [effort, setEffort] = useState<Effort>(
    () => (localStorage.getItem(EFFORT_KEY) as Effort | null) ?? "medium",
  );

  // What each loaded conversation belongs to and was started with. A background
  // chat still has to be saved when it answers, and by then the pickers on
  // screen may be showing something else entirely — so the facts travel with
  // the conversation, not with the UI.
  const meta = useRef<
    Record<string, { projectId: string; modelId: string; access: AccessLevel }>
  >({});
  // A copy of `running` that callbacks can read without being rebuilt whenever
  // it changes.
  const runningRef = useRef(running);
  runningRef.current = running;

  const confirm = useConfirm();

  useEffect(() => bridge.onState(setConn), []);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...expanded]));
    } catch {
      /* storage blocked: the tree just forgets again next time */
    }
  }, [expanded]);

  /** Read the project list from the backend. Called on load and again after
   *  anything in the settings panel changes one, since the backend owns the
   *  store and this is only a view of it. */
  const loadWorkspaces = useCallback(() => {
    bridge
      .invoke<Workspace[]>("list_workspaces")
      .then((list) => {
        const active = (list ?? []).filter((w) => !w.shelved);
        setWorkspaces(active);
        setProjectId((cur) => (cur && active.some((w) => w.id === cur) ? cur : active[0]?.id ?? null));
        // The project you land in is open; anything else keeps its saved state.
        if (active[0]) setExpanded((prev) => new Set(prev).add(active[0].id));
      })
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(loadWorkspaces, [loadWorkspaces]);

  // Adopt whatever is already running on the server. This is what the
  // conversation-derived key buys: a chat left working when the browser was
  // closed — or open in another tab — is recognised as belonging to a
  // conversation we already know, rather than being an orphan process that
  // blocks the next `chat_start` on that key.
  useEffect(() => {
    bridge
      .invoke<string[]>("chat_list")
      .then((keys) => {
        const ids = (keys ?? []).map(convOf).filter((id): id is string => !!id);
        if (ids.length) setRunning(new Set(ids));
      })
      .catch(() => {});
  }, []);

  /** Apply a change to ONE conversation's chat, whether or not it is the one on
   *  screen. Every update goes through here, which is what makes a background
   *  chat keep working while you read another. */
  const patch = useCallback((id: string, fn: (s: ChatState) => ChatState) => {
    setChats((prev) => ({ ...prev, [id]: fn(prev[id] ?? EMPTY) }));
  }, []);

  useEffect(
    () =>
      bridge.on<{ key: string; event: unknown }>("chat-event", (payload) => {
        const id = payload && convOf(payload.key);
        if (!id) return;
        patch(id, (s) => reduceChat(s, payload.event));
      }),
    [patch],
  );

  useEffect(
    () =>
      bridge.on<{ key: string; kind: string; text: string; code: number | null }>(
        "chat-status",
        (payload) => {
          const id = payload && convOf(payload.key);
          if (!id) return;
          if (payload.kind === "exit") {
            // The process is gone, so nothing can be sent to it. The transcript
            // stays: speaking again resumes the session by its id.
            setRunning((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
          patch(id, (s) =>
            payload.kind === "exit"
              ? { ...s, busy: false, exited: { code: payload.code } }
              : { ...s, notices: [...s.notices, payload.text].slice(-8) },
          );
        },
      ),
    [patch],
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

  // The command list comes from the session's own startup announcement, and is
  // cached per project from then on. It cannot be fetched ahead of time: the
  // agent says nothing at all until it has a prompt, so the first chat in a
  // project is what fills this.
  // Read from every loaded chat, not only the visible one — a chat working in
  // the background is just as good a source, and its project should have its
  // menu filled by the time you switch to it.
  useEffect(() => {
    setCommands((prev) => {
      let next = prev;
      for (const [id, s] of Object.entries(chats)) {
        const pid = meta.current[id]?.projectId;
        if (!pid || !s.commands?.length) continue;
        if (prev[pid]?.length === s.commands.length) continue;
        next = { ...next, [pid]: s.commands };
      }
      if (next === prev) return prev;
      try {
        localStorage.setItem(CMDS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the menu falls back to this session only */
      }
      return next;
    });
  }, [chats]);

  // Save every loaded conversation as it grows, the background ones included:
  // an answer that arrived while you were elsewhere has to survive a reload the
  // same as one you watched. Storing on every delta would serialise the whole
  // transcript 60 times a second, so this waits for a quiet moment.
  useEffect(() => {
    const timer = setTimeout(() => {
      setConversations((prev) => {
        let list = prev;
        let touched = false;
        for (const [id, s] of Object.entries(chats)) {
          const info = meta.current[id];
          if (!info || s.messages.length === 0) continue;
          const before = list.find((c) => c.id === id);
          if (before && before.messages === s.messages) continue;
          const next: Conversation = {
            id,
            projectId: info.projectId,
            title: titleFrom(s.messages),
            sessionId: s.sessionId ?? before?.sessionId,
            messages: s.messages,
            modelId: info.modelId,
            permission: info.access,
            // Set once, on the first save. Its whole job is to stay put — see
            // byProject in lib/store.ts.
            createdAt: before?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          };
          list = [next, ...list.filter((c) => c.id !== id)];
          touched = true;
        }
        if (!touched) return prev;
        saveConversations(list);
        return list;
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [chats]);

  // Leaving the page ends every running process. The transcripts are already
  // saved, and their session ids with them, so each conversation reopens and
  // continues where it stopped.
  useEffect(() => {
    const stopAll = () => {
      for (const id of runningRef.current) {
        bridge.invoke("chat_stop", { key: keyFor(id) }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", stopAll);
    return () => window.removeEventListener("pagehide", stopAll);
  }, []);

  const project = useMemo(
    () => workspaces.find((w) => w.id === projectId) ?? null,
    [workspaces, projectId],
  );
  const grouped = useMemo(() => byProject(conversations), [conversations]);

  /** The chat on screen. Everything else is still running behind it. */
  const chat = (conversationId && chats[conversationId]) || EMPTY;

  // Follow the model the AGENT reports. A `/model sonnet` typed into the chat
  // changes the model for real, and the picker saying "Opus" after that is
  // simply wrong. Set directly rather than through changeModel: this is not the
  // user choosing something, so it must not open a new chat.
  useEffect(() => {
    if (!chat.model) return;
    const match = MODELS.find(
      (m) => m.agent === choice.agent && m.flag && chat.model!.includes(m.flag),
    );
    if (match && match.id !== choice.id) {
      setChoice(match);
      if (conversationId && meta.current[conversationId]) {
        meta.current[conversationId].modelId = match.id;
      }
    }
  }, [chat.model, choice.agent, choice.id, conversationId]);
  /** Conversations mid-turn, for the live mark in the sidebar. A chat is busy
   *  when its process is up AND it is working — an idle session shows as alive
   *  but still. */
  const busySet = useMemo(() => {
    const out = new Set<string>();
    for (const id of running) if (chats[id]?.busy) out.add(id);
    return out;
  }, [running, chats]);

  /** End ONE conversation's process for good. Only ever on purpose — deleting
   *  the conversation, or asking for the session to end. Switching away does
   *  not come through here: that is the whole point of running in parallel. */
  const endSession = useCallback((id: string) => {
    bridge.invoke("chat_stop", { key: keyFor(id) }).catch(() => {});
    setRunning((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const startBlank = useCallback(
    (forProject: string) => {
      const id = crypto.randomUUID();
      meta.current[id] = { projectId: forProject, modelId: choice.id, access };
      setProjectId(forProject);
      setConversationId(id);
      setDrawer(false);
    },
    [choice.id, access],
  );

  const openConversation = useCallback((c: Conversation) => {
    meta.current[c.id] = {
      projectId: c.projectId,
      modelId: c.modelId ?? meta.current[c.id]?.modelId ?? MODELS[0].id,
      access: (c.permission as AccessLevel) ?? "read",
    };
    // Seed the stored transcript ONLY when this conversation is not already
    // loaded: one that has been running in the background holds more than what
    // was last written to storage, and must not be rewound to it.
    setChats((prev) =>
      prev[c.id] ? prev : { ...prev, [c.id]: { ...emptyChat(), messages: c.messages, sessionId: c.sessionId } },
    );
    setProjectId(c.projectId);
    setConversationId(c.id);
    if (c.modelId) {
      const model = MODELS.find((m) => m.id === c.modelId);
      if (model) setChoice(model);
    }
    if (c.permission) setAccess(c.permission as AccessLevel);
    setDrawer(false);
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Clicking a project row.
   *
   *  On a project you are not in: go there — open it, and show the most recent
   *  conversation, the way coming back to a room shows what was left on the
   *  table. On the one you are already in, there is nothing to go to, so the
   *  click does the other thing a folder does and closes it. */
  const pickProject = useCallback(
    (id: string) => {
      if (id === projectId) {
        toggleFolder(id);
        return;
      }
      setExpanded((s) => new Set(s).add(id));
      const recent = (grouped.get(id) ?? [])[0];
      if (recent) openConversation(recent);
      else startBlank(id);
    },
    [grouped, startBlank, openConversation, projectId, toggleFolder],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      // Ask first. This throws away the transcript AND, since chats now run in
      // parallel, can shut down an agent that is still working somewhere you
      // are not looking — so the question says which of those apply.
      const chat = conversations.find((c) => c.id === id);
      const live = runningRef.current.has(id);
      const name = chat?.title ? `“${chat.title}”` : "this chat";
      const ok = await confirm({
        title: `Delete ${name}?`,
        body: live
          ? chats[id]?.busy
            ? "It is still working. Deleting it stops the agent mid-answer, and the chat is gone for good."
            : "Its session is still running. Deleting it ends that session, and the chat is gone for good."
          : "The chat is gone for good.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;

      // Deleting the transcript with the agent still working on it would leave
      // a process nobody can reach, so it goes too.
      endSession(id);
      setConversations((prev) => {
        const list = prev.filter((c) => c.id !== id);
        saveConversations(list);
        return list;
      });
      setChats((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete meta.current[id];
      if (id === conversationId) setConversationId(null);
    },
    [conversationId, endSession, conversations, chats, confirm],
  );

  const send = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (!project) return;
      // Images go to the agent as pictures; anything else is named in the text
      // so the agent opens it with its own Read tool, which is better than
      // pushing a whole file into the prompt sight unseen.
      const images = attachments.filter((a) => a.isImage).map((a) => a.path);
      const files = attachments.filter((a) => !a.isImage).map((a) => a.path);
      if (files.length) {
        text = `${text}\n\nFiles to look at:\n${files.map((f) => `- ${f}`).join("\n")}`.trim();
      }
      const id = conversationId ?? crypto.randomUUID();
      if (!conversationId) setConversationId(id);
      meta.current[id] = {
        projectId: project.id,
        modelId: choice.id,
        access,
      };
      patch(id, (s) => addUserTurn(s, text));

      const fail = (err: unknown) =>
        patch(id, (s) => ({
          ...s,
          busy: false,
          notices: [...s.notices, String((err as Error).message ?? err)],
        }));

      // Already running: this is the next turn of a conversation in flight.
      if (runningRef.current.has(id)) {
        try {
          await bridge.invoke("chat_send", { key: keyFor(id), text, images });
        } catch (err) {
          fail(err);
        }
        return;
      }

      // No process yet — a new chat, or one being picked back up. The session
      // id comes from the chat's own state if it has run this visit, and from
      // the stored conversation otherwise.
      const resume =
        chats[id]?.sessionId ?? conversations.find((c) => c.id === id)?.sessionId ?? null;
      setRunning((prev) => new Set(prev).add(id));
      try {
        await bridge.invoke("chat_start", {
          key: keyFor(id),
          cwd: project.primary_path ?? "",
          // A project can group several folders, and the chat starts in only
          // one of them. The rest are named here so the agent can reach the
          // whole project, the same way a terminal in it can.
          extraDirs: project.paths ?? [],
          agent: choice.agent,
          model: choice.flag || null,
          access,
          effort,
          images,
          prompt: text,
          // Continuing an earlier conversation: the agent picks its own
          // context back up instead of being handed a transcript to read.
          resume,
        });
      } catch (err) {
        // The process is already up — this browser simply did not know about
        // it (another tab, or a session that outlived a crash). Talk to it
        // rather than reporting a collision as a failure.
        if (String((err as Error).message ?? err).includes("already running")) {
          try {
            await bridge.invoke("chat_send", { key: keyFor(id), text, images });
            return;
          } catch (second) {
            fail(second);
          }
        } else {
          fail(err);
        }
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [project, choice, access, effort, conversationId, chats, conversations, patch],
  );

  /** Stop the running turn. The session survives, ready for the next one. */
  const stop = useCallback(() => {
    if (!conversationId || !runningRef.current.has(conversationId)) return;
    patch(conversationId, (s) => ({ ...s, stopping: true }));
    bridge.invoke("chat_interrupt", { key: keyFor(conversationId) }).catch(() => {});
  }, [conversationId, patch]);

  /** Picking a different model.
   *
   *  A running agent cannot change model or provider: both are fixed on its
   *  command line when the process spawns, and a Claude session cannot become
   *  a Codex one at all — they are different programs with different session
   *  stores. So once a conversation has started, choosing something else opens
   *  a NEW chat on it rather than silently doing nothing, which is what used to
   *  happen. An untouched chat just takes the new setting. */
  /** Tell a running Claude session to change a setting, using the very slash
   *  command you would type yourself (`/model sonnet`, `/effort high`).
   *
   *  Both are reported in the session's own `slash_commands` list, so this is
   *  the agent's supported way to change them — and it keeps the conversation:
   *  the alternative is killing the process, which is a heavy price for
   *  swapping models halfway through a thought. Returns whether it was sent. */
  const tellSession = useCallback(
    (command: string): boolean => {
      if (!conversationId || !runningRef.current.has(conversationId)) return false;
      bridge.invoke("chat_send", { key: keyFor(conversationId), text: command }).catch(() => {});
      // Show it in the transcript. It IS a turn — the agent answers it — and a
      // setting that changed with no trace is a setting you cannot trust.
      patch(conversationId, (st) => addUserTurn(st, command));
      return true;
    },
    [conversationId, patch],
  );

  const changeModel = useCallback(
    (c: ModelChoice) => {
      const previous = choice;
      setChoice(c);
      localStorage.setItem(CHOICE_KEY, c.id);
      // The two providers do not offer the same effort levels, so carry the
      // choice across only when it exists over there.
      const kept = effortFor(c.agent, effort);
      if (kept !== effort) {
        setEffort(kept);
        localStorage.setItem(EFFORT_KEY, kept);
      }
      if (conversationId && meta.current[conversationId]) {
        meta.current[conversationId].modelId = c.id;
      }

      // An untouched chat simply starts with the new choice.
      if (chat.messages.length === 0) return;

      // Changing PROVIDER cannot be done in place at any price: a Claude
      // session id means nothing to Codex, and the two are different programs.
      if (c.agent !== previous.agent) {
        if (project) startBlank(project.id);
        return;
      }

      // Same provider, mid-conversation. Claude can be told to switch, which
      // keeps everything said so far. `Default` has no name to pass, so that
      // one still needs a fresh chat.
      if (c.agent === "claude" && c.flag && tellSession(`/model ${c.flag}`)) return;

      // Nothing running: the next message respawns the agent, and it will carry
      // the new --model with --resume, so the conversation survives anyway.
      if (!runningRef.current.has(conversationId ?? "")) return;

      if (project) startBlank(project.id);
    },
    [chat.messages.length, project, startBlank, effort, choice, conversationId, tellSession],
  );

  /** Changing what the agent may do starts a new agent: the mode is fixed when
   *  the process spawns, so leaving the old one running would make the pill on
   *  screen a lie about the chat in front of you. */
  /** Effort is fixed on the agent's command line, the same as permission mode.
   *  Ending the process rather than the conversation means the next message
   *  starts a fresh agent on the SAME session, under the new setting. */
  const changeEffort = useCallback(
    (e: Effort) => {
      setEffort(e);
      localStorage.setItem(EFFORT_KEY, e);
      // Claude takes `/effort` the same way it takes `/model`, so a running
      // session changes in place rather than being restarted.
      if (choice.agent === "claude" && tellSession(`/effort ${e}`)) return;
      // Otherwise the setting is on the command line, so the process has to go
      // — the conversation does not: the next message resumes the same session
      // under the new level.
      if (conversationId) endSession(conversationId);
    },
    [conversationId, endSession, choice.agent, tellSession],
  );

  const changeAccess = useCallback(
    (p: AccessLevel) => {
      setAccess(p);
      localStorage.setItem(ACCESS_KEY, p);
      // Ending this conversation's process, not the transcript: the next thing
      // you say starts a fresh agent on the SAME session, under the new mode.
      if (conversationId) endSession(conversationId);
    },
    [conversationId, endSession],
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
        {/* No "new chat" button here. Every project row in the sidebar carries
            its own, next to the project a new chat would belong to — a second
            one up here only raises the question of which project it means. */}
        <div className="topbar-title">{project?.name ?? "OctiqFlow"}</div>
        <Usage />
      </header>

      <div className="body">
        <div className="scrim" onClick={() => setDrawer(false)} />

        <Sidebar
          projects={workspaces}
          conversations={grouped}
          currentProject={projectId}
          currentConversation={conversationId}
          running={running}
          busy={busySet}
          expanded={expanded}
          onToggle={toggleFolder}
          onPickProject={pickProject}
          onPickConversation={openConversation}
          onNewChat={startBlank}
          onDelete={deleteConversation}
          onSettings={setSettingsFor}
          onNewProject={() => setSettingsFor("new")}
        />

        <main className="main">
          {chat.messages.length === 0 ? (
            <div className="hero">
              <h1 className="hero-title">
                What do you want to do{project ? ` in ${project.name}` : ""}?
              </h1>
              {chat.sessionId && <p className="hero-sub">continuing an earlier session</p>}
            </div>
          ) : (
            <MessageList
              messages={chat.messages}
              busy={chat.busy}
              stoppedAt={chat.stoppedAt}
              cwd={project?.primary_path ?? ""}
              conversationId={conversationId ?? undefined}
            />
          )}

          {chat.failure && (
            <div className={`failure ${chat.failure.outOfCredit ? "is-quota" : ""}`} role="alert">
              <div className="failure-title">{chat.failure.title}</div>
              {chat.failure.detail && <div className="failure-detail">{chat.failure.detail}</div>}
              {chat.failure.link && (
                <a
                  className="failure-link"
                  href={chat.failure.link}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {chat.failure.link}
                </a>
              )}
            </div>
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

          {termOpen && project && (
            <div className="drawer">
              <div className="drawer-head">
                <span className="drawer-title">Terminal · {project.name}</span>
                <span className="drawer-path" title={project.primary_path}>
                  <bdi>{project.primary_path}</bdi>
                </span>
                <button
                  className="drawer-close"
                  type="button"
                  title="Hide the terminal (the shell keeps running)"
                  onClick={() => {
                    setTermOpen(false);
                    localStorage.setItem(TERM_KEY, "0");
                  }}
                >
                  ✕
                </button>
              </div>
              {/* Keyed by project: switching project gets that project's own
                  shell, and coming back reattaches to it rather than starting
                  a second one. */}
              <TerminalPane
                key={project.id}
                id={`term:${project.id}`}
                cwd={project.primary_path ?? ""}
              />
            </div>
          )}

          <Composer
            choice={choice}
            onChoice={changeModel}
            started={chat.messages.length > 0}
            access={access}
            onAccess={changeAccess}
            onSend={send}
            onStop={stop}
            busy={chat.busy}
            disabled={!project}
            commands={(projectId && commands[projectId]) || []}
            contextTokens={chat.contextTokens}
            contextWindow={chat.contextWindow}
            effort={effort}
            onEffort={changeEffort}
            cwd={project?.primary_path ?? ""}
            terminalOpen={termOpen}
            onTerminal={
              project
                ? () =>
                    setTermOpen((open) => {
                      localStorage.setItem(TERM_KEY, open ? "0" : "1");
                      return !open;
                    })
                : undefined
            }
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

      {settingsFor && (
        <ProjectSettings
          project={
            settingsFor === "new" ? null : workspaces.find((w) => w.id === settingsFor) ?? null
          }
          onChanged={loadWorkspaces}
          onClose={() => setSettingsFor(null)}
          onDeleted={(id) => {
            // Its chats have nowhere to live now, so they go with it.
            setConversations((prev) => {
              const list = prev.filter((c) => c.projectId !== id);
              saveConversations(list);
              return list;
            });
          }}
        />
      )}
    </div>
  );
}
