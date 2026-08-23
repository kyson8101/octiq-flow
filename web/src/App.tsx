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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./lib/bridge";
import type { RoundState } from "./components/RoundBar";
import {
  addUserTurn,
  emptyChat,
  isThinking,
  reduceChat,
  thinkingNow,
  turnOutput,
  turnOutputApprox,
  type ChatState,
  type RoomView,
  type Seat,
} from "./lib/chat";
import {
  byProject,
  loadConversations,
  opensBlank,
  saveConversations,
  shortTitle,
  titleFrom,
  type Conversation,
} from "./lib/store";
import { forgetIndexEntry, saveIndexEntry } from "./lib/chatIndex";
import {
  focusNow,
  isOn as notifyIsOn,
  lastSaid,
  noticeFor,
  owed,
  permissionNow,
  show as showNotice,
  type NoticeKind,
} from "./lib/notify";
import * as push from "./lib/push";
import { AgentFocus } from "./components/AgentFocus";
import { AgentRail } from "./components/AgentRail";
import { Todos } from "./components/Todos";
import { latestTodos } from "./lib/todos";
import { useMedia, WIDE } from "./lib/media";
import { MessageList } from "./components/MessageList";
import {
  ACCESS,
  Composer,
  MODELS,
  modelFromId,
  type Attachment,
  type Effort,
  effortFor,
  type ModelChoice,
  type AccessLevel,
  type Provider,
} from "./components/Composer";
import { Connect } from "./components/Connect";
import { SessionSearch } from "./components/SessionSearch";
import { isUnder, readSession, replaySession, type HistorySession } from "./lib/history";
import { Sidebar, type Project } from "./components/Sidebar";
import { AgentsPage, loadAgents, type AgentInstall } from "./components/AgentsPage";
import { ShelvedProjects } from "./components/ShelvedProjects";
import { ProjectSettings } from "./components/ProjectSettings";
import { Settings } from "./components/Settings";
import { savedThemeId } from "./lib/themeStore";
import { Usage } from "./components/Usage";
import { GitButton, GitPanel } from "./components/GitPanel";
import { FilesButton, SessionFilesPanel, useSessionFiles } from "./components/SessionFiles";
import { PathCwdProvider } from "./components/ProsePath";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { PermissionAsk, askSummary, type Ask } from "./components/PermissionAsk";
import { UserQuestion, type Question } from "./components/UserQuestion";
import { useConfirm } from "./components/Confirm";

/** The editor and its text-editing engine are a third of the app's code and
 *  nobody who only ever chats should download them. Split off here, they arrive
 *  the first time someone taps Files. */
const EditorMode = lazy(() =>
  import("./components/EditorMode").then((m) => ({ default: m.EditorMode })),
);

type Workspace = Project & {
  paths?: string[];
  shelved?: boolean;
  description?: string;
  /** The project's saved commands, straight from the store. Read through
   *  `parseCommands` where they are drawn — see the terminal drawer. */
  actions?: unknown;
};

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
/** Whether new chats start clean. Kept here rather than per project: it is a
 *  way of working, not a property of the code you are working on. */
const LITE_KEY = "octiq.v2.lite";
const TERM_KEY = "octiq.v2.terminalOpen";
/** What the address bar says you are looking at.
 *
 *  The hash rather than the path: every path is served the same page, and
 *  `?token=…` already owns the query string (it is read once and stripped).
 *  A hash needs no server route and survives a reload.
 *
 *  Shape: #/p/<projectId>/c/<chatId> — the chat half is dropped for a project
 *  with nothing open yet. */
function readLocation(): { project?: string; chat?: string } {
  const m = /^#\/p\/([^/]+)(?:\/c\/([^/]+))?/.exec(location.hash);
  return m ? { project: decodeURIComponent(m[1]), chat: m[2] && decodeURIComponent(m[2]) } : {};
}

function writeLocation(project: string | null, chat: string | null): void {
  const next = project
    ? `#/p/${encodeURIComponent(project)}${chat ? `/c/${encodeURIComponent(chat)}` : ""}`
    : "";
  if (next === location.hash) return;
  // replaceState, not a hash assignment: switching chats is not navigation you
  // want to walk back through one at a time, and assigning to location.hash
  // would push an entry for every click.
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

/** The chat that was on screen when the page was last left. */
const LAST_KEY = "octiq.v2.lastChat";
const GIT_KEY = "octiq.v2.gitOpen";
const FILES_KEY = "octiq.v2.filesOpen";
/** How long the panel's slide-out takes. Kept in step with the transition in
 *  styles.css; it only decides when the closed panel leaves the DOM. */
const GIT_SLIDE_MS = 220;
const MODE_KEY = "octiq.v2.mode";

/** The two top-level views. Chat is the conversation about the code; the editor
 *  is the code. They share the project sidebar and the connection, and neither
 *  stops when you look at the other. */
type Mode = "chat" | "editor";

export default function App() {
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [shelved, setShelved] = useState<Workspace[]>([]);
  const [shelfOpen, setShelfOpen] = useState(false);
  /** Which agent CLIs this machine has. Asked once on arrival: it decides what
   *  the model picker may offer, so it is not only the Agents page's business. */
  const [agents, setAgents] = useState<AgentInstall[]>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  /** What the address bar asked for on arrival. Read once: after this the URL
   *  follows the app, not the other way round. */
  const opened = useRef(readLocation());
  // Every chat that is loaded or running, keyed by conversation id. Chats run
  // in PARALLEL: switching to another one leaves this one working, and its
  // answer lands in here whether or not you are looking at it.
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  // The conversations with a live agent process behind them.
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [drawer, setDrawer] = useState(false);
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem(MODE_KEY) === "editor" ? "editor" : "chat",
  );
  // Once the editor has been opened it stays MOUNTED behind the chat, hidden
  // rather than unmounted. Its open files hold unsaved drafts, and a tap on
  // "Chat" is not a decision to throw them away.
  const [editorSeen, setEditorSeen] = useState(() => localStorage.getItem(MODE_KEY) === "editor");
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [conversationId, setConversationId] = useState<string | null>(null);
  /** Which agent the rail has opened, by `task_id`, or null for the whole
   *  conversation. View state, not chat state: it is about what this person is
   *  reading, and it must not survive into another conversation. */
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  /** Wide enough for a sidebar column — and so for a top bar that can hold the
   *  view switch and the usage meter. Below it those live in the drawer. */
  const wide = useMedia(WIDE);
  // Switching conversations closes the focus panel. Without this the next
  // conversation opens showing "conversation" as a back arrow over a blank
  // panel until something is clicked.
  useEffect(() => setFocusedAgent(null), [conversationId]);
  // Which project's settings are open: an id, "new" while creating one, or
  // null for closed.
  const [settingsFor, setSettingsFor] = useState<string | "new" | null>(null);
  // The shell drawer under the chat. Remembered, because someone who works
  // with it open wants it open next time too.
  // The app's own settings sheet, and the theme it is showing as chosen.
  // `main.tsx` has already applied this one; the state is here only so the
  // tick in the sheet has something to read.
  const [appSettings, setAppSettings] = useState(false);
  const [themeId, setThemeId] = useState(savedThemeId);

  const [termOpen, setTermOpen] = useState(() => localStorage.getItem(TERM_KEY) === "1");
  // The git column beside the chat. It lives up here rather than inside the
  // panel because the button that opens it is in the top bar and the panel it
  // opens is a column in the body — two places, one piece of state.
  const [gitOpen, setGitOpen] = useState(() => localStorage.getItem(GIT_KEY) === "1");
  /** Kept mounted while the panel slides away, so closing it on a phone is the
   *  reverse of opening rather than the panel blinking out. Unmounting on
   *  `gitOpen` alone would cut the animation off at its first frame. */
  const [gitMounted, setGitMounted] = useState(gitOpen);
  // The files column, on the same terms as the git one beside it: the button
  // that opens it is in the top bar, the panel it opens is a column in the
  // body, and only one piece of state joins them.
  const [filesOpen, setFilesOpen] = useState(() => localStorage.getItem(FILES_KEY) === "1");
  const [filesMounted, setFilesMounted] = useState(filesOpen);
  // Tool calls an agent is blocked on, by conversation. Not in ChatState: a
  // question belongs to the moment, not to the transcript.
  const [asks, setAsks] = useState<Record<string, Ask[]>>({});
  // Questions the agent is blocked on, by conversation.
  const [questions, setQuestions] = useState<Record<string, Question[]>>({});
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
    () => modelFromId(localStorage.getItem(CHOICE_KEY)) ?? MODELS[0],
  );
  // What the agent may do unattended. Defaults to the cautious end: a chat has
  // no way to answer a permission prompt, so this is the whole of the answer.
  const [access, setAccess] = useState<AccessLevel>(() => {
    const saved = localStorage.getItem(ACCESS_KEY);
    // Values written before this was one shared level, when it held Claude's
    // own permission-mode names — plus "edit", the middle level's old id, from
    // when it meant acceptEdits rather than auto. Anyone who picked the middle
    // stays on the middle; dropping these would silently move them to "read".
    const legacy: Record<string, AccessLevel> = {
      plan: "read",
      // `acceptEdits` is a level of its own again — but a value written under
      // the old scheme meant "the middle one", which was `auto`. Reading it as
      // `edits` now would quietly TAKE AWAY permission somebody already has.
      acceptEdits: "auto",
      edit: "auto",
      bypassPermissions: "full",
    };
    if (saved && legacy[saved]) return legacy[saved];
    const known: AccessLevel[] = ["read", "manual", "edits", "auto", "full"];
    return known.includes(saved as AccessLevel) ? (saved as AccessLevel) : "read";
  });
  // How hard the model thinks. Fixed on the agent's command line, so changing
  // it takes effect from the next message — see changeEffort.
  const [effort, setEffort] = useState<Effort>(
    () => (localStorage.getItem(EFFORT_KEY) as Effort | null) ?? "medium",
  );
  // A clean chat: none of this machine's skills, hooks or other MCP servers.
  // Read once, when the agent process starts, so turning it on part way through
  // a conversation changes nothing until a new chat begins. Off by default —
  // the skills and hooks are there because somebody installed them.
  const [lite, setLite] = useState<boolean>(() => localStorage.getItem(LITE_KEY) === "1");
  const changeLite = useCallback((on: boolean) => {
    setLite(on);
    try {
      localStorage.setItem(LITE_KEY, on ? "1" : "0");
    } catch {
      /* storage blocked: the choice holds for this session only */
    }
  }, []);

  // Chats that were picked up from an agent's own history, by conversation id.
  // Only so the empty page can say WHICH session it is about to continue —
  // "continuing an earlier session" on its own asks you to take it on trust.
  /** Past sessions picked up this visit, by conversation id. `problem` is set
   *  when the transcript could not be read — the chat still works, so this is a
   *  note beside the caption rather than a failure of the conversation. */
  const [resumed, setResumed] = useState<Record<string, HistorySession & { problem?: string }>>({});
  // Conversations whose transcript is still being read back off disk. A
  // resumed session has no messages until that read lands, and "no messages"
  // is also what a BRAND NEW chat looks like — so without this the page you
  // land on after picking a session is the page you pick a session from.
  const [reading, setReading] = useState<Record<string, boolean>>({});

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
  // The same, for the loaded chats. `openConversation` has to know whether the
  // one being opened already has words in it — and it must NOT be rebuilt every
  // time any chat says anything, because the sidebar and the notification
  // handler both hold on to it.
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  // The level each chat was last asked to change to. An agent that will not
  // take the change says so on its own event, well after the tap, so this is
  // what names the change it is refusing — for a background chat as much as
  // the one on screen.
  const wantedAccess = useRef<Record<string, AccessLevel>>({});
  // And the fallback to run when that refusal arrives. Held in a ref because
  // the listener below is set up long before `endSession` exists to build it.
  const onAccessRefused = useRef<(id: string, why: string) => void>(() => {});

  // The last event we have seen for each chat, so a reconnect can ask for what
  // it missed. The agent kept working while we were away — the record of it is
  // on the server, and this is our place in it.
  const seen = useRef<Record<string, number>>({});

  // Desktop notifications, for the chats you are NOT looking at.
  //
  // Chats run in parallel, so the moment worth acting on lands in a window
  // behind an editor or in a conversation you left an hour ago — and two of the
  // three moments (a permission, a question) time out. The rule for what counts
  // as "not looking" lives in lib/notify.ts; here is only what fires it.
  const [notifyOn, setNotifyOn] = useState(notifyIsOn);
  // Whether the SERVER is doing the announcing. When it is, this page must not
  // announce as well — the same moment would draw a banner from each — and it
  // is the server's that survives the page being closed, which is the whole
  // point on a phone. Asked of the browser rather than remembered, because the
  // browser is what can quietly drop a subscription.
  const [pushOn, setPushOn] = useState(false);
  useEffect(() => {
    void push.isOn().then(setPushOn);
  }, []);
  // Everything `announce` needs, read at the moment it fires rather than closed
  // over. The listeners that raise notices are registered ONCE, and neither the
  // switch changing nor opening another chat may tear them down and rebuild
  // them — the same reason `runningRef` exists.
  const notifying = useRef({
    on: notifyOn,
    push: pushOn,
    reading: conversationId,
    list: conversations,
  });
  notifying.current = {
    on: notifyOn,
    push: pushOn,
    reading: conversationId,
    list: conversations,
  };
  // Set long before `openConversation` exists, like `onAccessRefused` below.
  const onOpenChat = useRef<(id: string) => void>(() => {});
  // Answered ids, so one ask does not announce twice. It reaches this page down
  // two routes — the live broadcast and the refill on connect — and the second
  // arrival is the same question, not a new one.
  const announced = useRef<Set<string>>(new Set());

  /** Put one moment on the desktop, unless it is already in front of you. */
  const announce = useCallback((kind: NoticeKind, id: string, detail: string) => {
    const { on, push: viaPush, reading, list } = notifying.current;
    // The server has this covered, and its banner arrives whether or not this
    // page is still here. Raising one too would only double it.
    if (viaPush) return;
    if (!owed({ enabled: on, permission: permissionNow() }, focusNow(reading), id)) return;
    const notice = noticeFor({
      kind,
      conversationId: id,
      chatTitle: list.find((c) => c.id === id)?.title ?? "",
      detail,
    });
    showNotice(notice, (open) => onOpenChat.current(open));
  }, []);

  /** The same, for something with an id that must only ever be announced once. */
  const announceOnce = useCallback(
    (key: string, kind: NoticeKind, id: string, detail: string) => {
      if (announced.current.has(key)) return;
      announced.current.add(key);
      announce(kind, id, detail);
    },
    [announce],
  );

  const confirm = useConfirm();

  const pickMode = useCallback((next: Mode) => {
    setMode(next);
    if (next === "editor") setEditorSeen(true);
    localStorage.setItem(MODE_KEY, next);
  }, []);

  useEffect(() => bridge.onState(setConn), []);

  // Reconnected: ask each live chat for everything that happened while we were
  // away. Without this, closing a laptop mid-answer loses the rest of it — the
  // agent finished perfectly well, we simply were not listening.
  useEffect(() => {
    if (conn !== "open") return;
    for (const id of runningRef.current) {
      const key = keyFor(id);
      bridge
        .invoke<{ seq: number; event: unknown }[]>("chat_since", {
          key,
          after: seen.current[key] ?? 0,
        })
        .then((missed) => {
          for (const item of missed ?? []) {
            if (item.seq <= (seen.current[key] ?? 0)) continue;
            seen.current[key] = item.seq;
            patch(id, (st) => reduceChat(st, item.event));
          }
        })
        .catch(() => {});
    }
    // `patch` is stable; running is read through the ref so a chat starting
    // mid-reconnect does not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

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
        // Kept separately rather than dropped. Shelving used to remove a project
        // from the only list that renders it, and the control that brings it
        // back lives behind that project's own gear — so a shelved project was
        // a one-way door.
        setShelved((list ?? []).filter((w) => w.shelved));
        setProjectId((cur) => {
          if (cur && active.some((w) => w.id === cur)) return cur;
          // The link wins over "first in the list", but only if it still exists
          // — a shelved or deleted project must not leave you on nothing.
          const asked = opened.current.project;
          if (asked && active.some((w) => w.id === asked)) return asked;
          return active[0]?.id ?? null;
        });
        // The project you land in is open; anything else keeps its saved state.
        if (active[0]) setExpanded((prev) => new Set(prev).add(active[0].id));
      })
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(loadWorkspaces, [loadWorkspaces]);

  /** Ask the backend which agent CLIs resolve on this machine.
   *
   *  Fails SOFT, to an empty list: a backend too old to know this command still
   *  has to be usable, and "we could not ask" must never read as "nothing is
   *  installed". Everything downstream treats an empty list as "no answer" and
   *  offers every agent, exactly as it did before this page existed. */
  const loadAgentList = useCallback((refresh?: boolean) => {
    loadAgents(refresh === true)
      .then((list) => setAgents(list ?? []))
      .catch(() => setAgents([]));
  }, []);

  useEffect(loadAgentList, [loadAgentList]);

  /** The agents this machine has, or undefined while we have no answer.
   *  Undefined and empty mean different things downstream — "could not ask" vs
   *  "asked, has none" — so they are kept apart rather than both being []. */
  const installed: Provider[] | undefined = useMemo(
    () => (agents.length > 0 ? agents.filter((a) => a.installed).map((a) => a.id) : undefined),
    [agents],
  );

  /* A saved choice can name an agent this machine does not have — you picked
   * Codex on the laptop, and this is the desktop that never had it. Left alone
   * it starts a chat that spawns a shell, prints "command not found" and dies,
   * which reads as the app being broken. So the choice moves to something that
   * is actually here. Only the PICKER moves; no chat is touched. */
  useEffect(() => {
    if (!installed || installed.length === 0) return;
    if (installed.includes(choice.agent)) return;
    const next = MODELS.find((m) => installed.includes(m.agent));
    if (!next) return;
    setChoice(next);
    localStorage.setItem(CHOICE_KEY, next.id);
  }, [installed, choice.agent]);

  // The chat list lives on the server, so a chat started on the phone shows up
  // on the laptop. The local copy is a cache: it paints immediately, and the
  // server's answer FOLDS INTO it a moment later. Messages are NOT here — they
  // are replayed from each chat's transcript when it is opened.
  //
  // Folds into, rather than replaces. Replacing meant the server's list was the
  // only list: a chat the server had not heard of was dropped from state AND
  // written out of storage on the same tick, so one reload deleted it for good.
  // That is not a rare shape — `chat_index_save` is sent 700ms after the last
  // message and its failure is swallowed, so a backend that restarts, or a tab
  // closed early, leaves a chat this browser has and the server does not.
  // The browser's own chats are now kept, and the next save re-offers them to
  // the index.
  useEffect(() => {
    bridge
      .invoke<
        {
          id: string;
          projectId: string;
          title: string;
          sessionId?: string;
          modelId?: string;
          access?: string;
          createdAt: number;
          updatedAt: number;
        }[]
      >("chat_index_list")
      .then((remote) => {
        // An EMPTY answer is not news, it is the absence of news. `index.json`
        // missing, unreadable, or belonging to a profile that was switched all
        // read back as zero chats, and treating that as the truth would wipe
        // every conversation this browser holds. A server that genuinely has
        // none has nothing to tell us either, so ignoring it costs nothing.
        if (!remote || remote.length === 0) return;
        setConversations((local) => {
          const byId = new Map(local.map((c) => [c.id, c]));
          const merged = remote.map((r) => {
            const cached = byId.get(r.id);
            return {
              ...r,
              permission: r.access ?? cached?.permission,
              // Keep the cached messages so the chat opens instantly; the
              // transcript tops it up on open. A chat this device has never
              // seen has none, and replays in full.
              messages: cached?.messages ?? [],
              seq: cached?.seq,
              // Listed by the server, so from now on its absence means
              // something: see `synced` in lib/store.ts.
              synced: true,
            } as Conversation;
          });
          // Chats this browser has that the server did not list.
          //
          // Kept when the server has NEVER listed them — that is an index write
          // that has not landed, and dropping it here deleted the conversation
          // from storage on the same tick, which is how a reload used to lose a
          // chat outright.
          //
          // Dropped when the server HAS listed them before, because then the
          // list is authoritative and the chat was deleted on another device.
          const known = new Set(remote.map((r) => r.id));
          const mine = local.filter((c) => !known.has(c.id) && !c.synced);
          const all = [...merged, ...mine];
          saveConversations(all);
          return all;
        });
      })
      .catch(() => {});
  }, []);

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

  // What is waiting on YOU right now, asked for rather than waited for.
  //
  // A permission card and an `ask_user` question are announced ONCE, on a
  // broadcast with no replay, and they live only in this page's memory. So a
  // reload used to lose them outright — while the server went on holding the
  // agent's turn open, three minutes for a permission and ten for a question,
  // for an answer that could no longer be given. The chat just sat there, and
  // the way out was to send something and start a fresh turn.
  //
  // The server is the one that knows what is still waiting, so it is asked, on
  // every connect. Its answer REPLACES what is here: a card this page is still
  // drawing that the server no longer lists was decided somewhere else, or
  // timed out while we were away, and a card that cannot be answered is worse
  // than no card at all.
  useEffect(() => {
    if (conn !== "open") return;
    const byConversation = <T extends { chatKey?: string }>(list: T[] | null) => {
      const out: Record<string, T[]> = {};
      for (const item of list ?? []) {
        const id = item.chatKey ? convOf(item.chatKey) : null;
        if (!id) continue;
        (out[id] ??= []).push(item);
      }
      return out;
    };
    bridge
      .invoke<Ask[]>("permission_pending")
      .then((list) => setAsks(byConversation(list)))
      .catch(() => {
        /* an older server has no such command: the live events still work */
      });
    bridge
      .invoke<Question[]>("question_pending")
      .then((list) => setQuestions(byConversation(list)))
      .catch(() => {});
  }, [conn]);

  useEffect(() => {
    const offAsk = bridge.on<Ask>("permission-ask", (ask) => {
      const id = ask?.chatKey ? convOf(ask.chatKey) : null;
      if (!id || !ask.id) return;
      announceOnce(ask.id, "permission", id, askSummary(ask));
      // Guarded against arriving twice: an ask raised in the moment between the
      // refill above being answered and this listener seeing it comes down both
      // routes, and two cards for one question can only be answered once.
      setAsks((prev) =>
        prev[id]?.some((a) => a.id === ask.id)
          ? prev
          : { ...prev, [id]: [...(prev[id] ?? []), ask] },
      );
    });
    // Nobody answered in time, so the server said no on our behalf. The card
    // must go: leaving it would offer a choice that no longer exists.
    const offGone = bridge.on<{ id: string }>("permission-expired", (gone) => {
      if (!gone?.id) return;
      setAsks((prev) => {
        const next: Record<string, Ask[]> = {};
        for (const [key, list] of Object.entries(prev)) {
          next[key] = list.filter((a) => a.id !== gone.id);
        }
        return next;
      });
    });
    const offQuestion = bridge.on<Question>("user-question", (q) => {
      const id = q?.chatKey ? convOf(q.chatKey) : null;
      if (!id || !q.id) return;
      announceOnce(q.id, "question", id, q.question ?? "");
      setQuestions((prev) =>
        prev[id]?.some((x) => x.id === q.id)
          ? prev
          : { ...prev, [id]: [...(prev[id] ?? []), q] },
      );
    });
    const offQuestionGone = bridge.on<{ id: string }>("question-expired", (gone) => {
      if (!gone?.id) return;
      setQuestions((prev) => {
        const next: Record<string, Question[]> = {};
        for (const [key, list] of Object.entries(prev)) {
          next[key] = list.filter((q) => q.id !== gone.id);
        }
        return next;
      });
    });
    return () => {
      offAsk();
      offGone();
      offQuestion();
      offQuestionGone();
    };
  }, [announceOnce]);

  /** Apply a change to ONE conversation's chat, whether or not it is the one on
   *  screen. Every update goes through here, which is what makes a background
   *  chat keep working while you read another. */
  const patch = useCallback((id: string, fn: (s: ChatState) => ChatState) => {
    setChats((prev) => ({ ...prev, [id]: fn(prev[id] ?? EMPTY) }));
  }, []);

  useEffect(
    () =>
      bridge.on<{ key: string; seq?: number; event: unknown }>("chat-event", (payload) => {
        const id = payload && convOf(payload.key);
        if (!id) return;
        // Out of order, or one we already folded in during a catch-up.
        if (typeof payload.seq === "number") {
          if (payload.seq <= (seen.current[payload.key] ?? 0)) return;
          seen.current[payload.key] = payload.seq;
        }
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
          if (payload.kind === "access-refused") {
            // The running agent will not make this change. Fall back to the way
            // it worked before there was a control channel to ask down.
            onAccessRefused.current(id, payload.text);
            return;
          }
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
        const changedIds = new Set<string>();
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
            seq: seen.current[keyFor(id)] ?? before?.seq,
            // Carried, not recomputed. Rewriting the row must not forget that
            // the server has already vouched for this chat.
            synced: before?.synced,
          };
          list = [next, ...list.filter((c) => c.id !== id)];
          changedIds.add(id);
          touched = true;
        }
        if (!touched) return prev;
        saveConversations(list);
        // And to the server, so every device sees this chat exists. Metadata
        // only — the messages are already in the transcript. Through
        // saveIndexEntry, which keeps trying: an entry that does not land is
        // what makes the server delete the transcript at its next start.
        for (const c of list) {
          if (!changedIds.has(c.id)) continue;
          saveIndexEntry({
            id: c.id,
            projectId: c.projectId,
            title: c.title,
            sessionId: c.sessionId ?? null,
            modelId: c.modelId ?? null,
            access: c.permission ?? null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          });
        }
        return list;
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [chats]);

  // Leaving the page no longer stops anything.
  //
  // It used to, because the browser was the only record: an agent still working
  // after you left was producing output nobody would ever see. Now the server
  // writes every event down (transcript.rs), so closing a laptop mid-answer is
  // a pause rather than a loss — you come back and ask for the rest.
  //
  // Killing on pagehide would throw away exactly what makes that possible: the
  // long task you closed the lid on is the one you most want to survive. What
  // is left running is adopted on the next load through chat_list, and stopping
  // is a thing you ask for.

  // The address bar mirrors what you are looking at, so a link to this chat is
  // just the URL — which is the only way to get back to one specific
  // conversation from a phone's home screen or another device.
  useEffect(() => {
    writeLocation(projectId, conversationId);
    // And in storage, because the URL is not always there to carry it. The app
    // is opened from a saved link and from a home-screen icon, and both are the
    // ORIGINAL address with no `#/p/…/c/…` on the end — so a reload from one of
    // those had nothing to say which chat you were in.
    try {
      if (conversationId) localStorage.setItem(LAST_KEY, conversationId);
    } catch {
      /* storage blocked: the URL is still the way back */
    }
  }, [projectId, conversationId]);

  const project = useMemo(
    () => workspaces.find((w) => w.id === projectId) ?? null,
    [workspaces, projectId],
  );
  const grouped = useMemo(() => byProject(conversations), [conversations]);

  /** The chat on screen. Everything else is still running behind it. */
  const chat = (conversationId && chats[conversationId]) || EMPTY;
  /** The newest plan this chat wrote down — see lib/todos. */
  const todos = useMemo(() => latestTodos(chat.messages), [chat.messages]);
  /** Every file this chat has touched. Read once up here rather than twice
   *  below: the button needs the count and the panel needs the list, and
   *  scanning the transcript for each of them would do the same work twice. */
  const sessionFiles = useSessionFiles(
    chat.messages,
    project?.primary_path ?? "",
    filesOpen,
    chat.busy,
  );
  // The agent the rail opened, resolved against THIS conversation. Looking it
  // up rather than storing the object keeps it live: a running agent's focus
  // view updates as its events arrive. It resolves to nothing after switching
  // conversations, which is what closes the panel.
  const focused = focusedAgent ? chat.agents.find((a) => a.id === focusedAgent) : undefined;

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

  // A turn that ended, announced to the desktop.
  //
  // Read off `busy` going true → false rather than off any one event: a turn
  // ends several ways — a final result, an error, the process exiting — and all
  // of them come down to the same thing here. A chat whose `busy` was never
  // seen true has no transition, so seeding a stored transcript on load, or
  // adopting a session already running on the server, announces nothing.
  const wasBusy = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const [id, s] of Object.entries(chats)) {
      const before = wasBusy.current[id];
      wasBusy.current[id] = s.busy;
      if (before && !s.busy) announce("done", id, lastSaid(s.messages));
    }
  }, [chats, announce]);

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

  /** Carry on a session the AGENT remembers — one from ~/.claude or ~/.codex,
   *  found through the search on the empty-chat page (components/SessionSearch).
   *
   *  Nothing is started here. A conversation is only prepared: the agent's
   *  session id is put on it, so the first thing said goes out as `--resume
   *  <id>` and comes back with its context rather than as a stranger. That is
   *  the same path a chat of our own takes when it is reopened.
   *
   *  Three things travel WITH the session rather than being taken from the
   *  pickers on screen:
   *
   *    - the agent, because a Claude session means nothing to Codex,
   *    - the model and effort it was last recorded under, so picking up
   *      yesterday's work does not quietly move it to a different model,
   *    - the folder, because a session's memory is of a particular project;
   *      resuming it somewhere else would leave the agent talking about files
   *      that are not there.
   *
   *  A model we do not offer (the agent may be on one this app has no entry
   *  for) falls back to that agent's default rather than to something from the
   *  other family. */
  const resumeHistory = useCallback(
    (session: HistorySession) => {
      const home = workspaces.find(
        (w) =>
          (w.primary_path && isUnder(session.cwd, w.primary_path)) ||
          (w.paths ?? []).some((p) => isUnder(session.cwd, p)),
      );
      const forProject = home?.id ?? projectId;
      if (!forProject) return;

      const model =
        MODELS.find((m) => m.agent === session.agent && m.flag && session.model?.includes(m.flag)) ??
        MODELS.find((m) => m.agent === session.agent && !m.flag) ??
        MODELS[0];
      const kept = effortFor(session.agent, (session.effort as Effort) ?? effort);

      // The blank chat already on screen is the one to use — it is what the
      // person was looking at when they searched. A conversation that has been
      // spoken in gets a new row instead, so nothing is written over.
      const blank = conversationId && (chats[conversationId]?.messages.length ?? 0) === 0;
      const id = blank ? conversationId! : crypto.randomUUID();

      meta.current[id] = { projectId: forProject, modelId: model.id, access };
      setChoice(model);
      setEffort(kept);
      try {
        localStorage.setItem(EFFORT_KEY, kept);
      } catch {
        /* storage blocked: the effort holds for this session only */
      }
      setResumed((prev) => ({ ...prev, [id]: session }));
      patch(id, (s) => ({ ...s, sessionId: session.sessionId }));

      // ...and READ it, so the history can be looked at rather than merely
      // pointed at. Picking a session used to leave a blank page with one line
      // of caption on it, which is indistinguishable from nothing happening.
      //
      // Asynchronous on purpose: everything above is what makes the chat usable
      // and must not wait on a file that may be megabytes. The transcript
      // arrives after, into `id` — which is the conversation that was picked,
      // not whichever one is on screen by then.
      setReading((prev) => ({ ...prev, [id]: true }));
      void readSession(session)
        .then((events) => {
          const past = replaySession(events);
          if (past.messages.length === 0) return;
          patch(id, (s) =>
            // Anything said in the meantime WINS. The agent answers into this
            // same state, and a slow read landing on top of a live turn would
            // wipe it. Seeding is only for a conversation still untouched.
            s.messages.length > 0
              ? s
              : { ...s, messages: past.messages, agents: past.agents },
          );
        })
        .catch((err: unknown) => {
          // Say so rather than leaving the same blank page this change exists
          // to fix. The chat still works: the session id is already on it, so
          // typing resumes the real session even when its file cannot be read.
          const problem = err instanceof Error ? err.message : String(err);
          setResumed((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], problem } } : prev));
        })
        .finally(() =>
          setReading((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }),
        );
      setProjectId(forProject);
      setConversationId(id);
      setDrawer(false);
    },
    [workspaces, projectId, conversationId, chats, access, effort, patch],
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

    // Fill in anything this device has not seen. On the device that held the
    // conversation that is the tail of an interrupted answer; on a device that
    // has never seen it, `seq` is absent and this replays the whole thing.
    const key = keyFor(c.id);
    const from = seen.current[key] ?? c.seq ?? 0;
    // ...and when that replay is the WHOLE conversation, say so while it runs.
    // The chat list comes from the server and the messages do not, so a chat
    // held on another device opens with nothing in it — and a conversation with
    // no messages draws the page you START one from. Picking yesterday's work
    // out of the sidebar on a phone therefore looked exactly like a chat that
    // had been thrown away, for as long as the replay took.
    const blank = opensBlank(c, chatsRef.current[c.id]);
    if (blank) setReading((prev) => ({ ...prev, [c.id]: true }));
    bridge
      .invoke<{ seq: number; event: unknown }[]>("chat_since", { key, after: from })
      .then((missed) => {
        for (const item of missed ?? []) {
          if (item.seq <= (seen.current[key] ?? 0)) continue;
          seen.current[key] = item.seq;
          patch(c.id, (st) => reduceChat(st, item.event));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!blank) return;
        // Whatever came back — the conversation, nothing at all, or a failure —
        // the waiting is over. An empty answer falls through to the ordinary
        // empty page, which is then the truth about this chat.
        setReading((prev) => {
          if (!prev[c.id]) return prev;
          const next = { ...prev };
          delete next[c.id];
          return next;
        });
      });
    setProjectId(c.projectId);
    setConversationId(c.id);
    if (c.modelId) {
      const model = MODELS.find((m) => m.id === c.modelId);
      if (model) setChoice(model);
    }
    if (c.permission) setAccess(c.permission as AccessLevel);
    setDrawer(false);
  }, [patch]);

  // Clicking a desktop notification brings the window forward — this is what
  // then puts the chat it came from on screen, so the banner lands you on the
  // thing it was about rather than wherever you left off.
  onOpenChat.current = (id) => {
    const found = notifying.current.list.find((c) => c.id === id);
    if (found) openConversation(found);
  };

  // The same, for a banner the SERVICE WORKER raised. It cannot reach into the
  // page, so tapping one only brings the window forward and posts the chat it
  // came from; this is the half that opens it.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "open-chat" && typeof data.conversationId === "string") {
        onOpenChat.current(data.conversationId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // Keep the worker told which chat is on screen, so it can stay quiet about
  // that one. It is killed and restarted freely and forgets — hence also on
  // focus and visibility, not only when the chat changes.
  useEffect(() => {
    const tell = () => push.setReading(document.hidden ? null : conversationId);
    tell();
    window.addEventListener("focus", tell);
    window.addEventListener("blur", tell);
    document.addEventListener("visibilitychange", tell);
    return () => {
      window.removeEventListener("focus", tell);
      window.removeEventListener("blur", tell);
      document.removeEventListener("visibilitychange", tell);
    };
  }, [conversationId]);

  // Go back to the chat you were last in, once the list it lives in arrives.
  //
  // Through `openConversation`, which is the ONLY thing that puts a stored
  // transcript back on screen: it seeds the messages and asks the server for
  // anything it missed. This used to set the project and conversation ids by
  // hand instead, which named the chat in the title bar and left the page
  // blank underneath — a reload looked exactly like a conversation that had
  // been thrown away.
  //
  // The URL wins, since it is a link to one particular chat; the remembered one
  // is the fallback for an address that names none. Once only: from then on the
  // app drives the URL, and a restore landing later would drag you out of
  // whatever you had already started.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    if (conversationId) {
      restored.current = true;
      return;
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_KEY);
    } catch {
      /* storage blocked: the URL is the only way back */
    }
    const wanted = opened.current.chat ?? last;
    if (!wanted) {
      restored.current = true;
      return;
    }
    // Not here YET is not the same as gone: the server's list folds in a moment
    // after the cached one, so this waits rather than giving up.
    const found = conversations.find((c) => c.id === wanted);
    if (!found) return;
    restored.current = true;
    opened.current = {};
    openConversation(found);
  }, [conversations, conversationId, openConversation]);

  /** Remember whether a side column is open. Split out because two of them do
   *  the same thing, and a flag that drifts from what is on screen is a panel
   *  that comes back closed. */
  const remember = (key: string, next: boolean) => {
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* storage blocked: it just forgets between visits */
    }
  };

  /** Show or hide the git column, and remember it — every way in and out goes
   *  through here, so the stored flag cannot drift from what is on screen.
   *
   *  Opening it puts the files column away. They are alternatives, not a pair:
   *  side by side they leave the chat a strip too narrow to read, and on a
   *  phone they are both full sheets, where the second one drawn over the first
   *  just loses you. */
  const showGit = useCallback((next: boolean) => {
    setGitOpen(next);
    // Mount at once so the panel exists to slide IN; unmount only after it has
    // finished sliding OUT. The delay matches the transform transition in
    // styles.css — shorter and the panel disappears mid-slide.
    if (next) {
      setGitMounted(true);
      setFilesOpen(false);
      remember(FILES_KEY, false);
    }
    remember(GIT_KEY, next);
  }, []);

  /** The same, for the files column. */
  const showFiles = useCallback((next: boolean) => {
    setFilesOpen(next);
    if (next) {
      setFilesMounted(true);
      setGitOpen(false);
      remember(GIT_KEY, false);
    }
    remember(FILES_KEY, next);
  }, []);

  useEffect(() => {
    if (gitOpen) return;
    const timer = setTimeout(() => setGitMounted(false), GIT_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [gitOpen]);

  useEffect(() => {
    if (filesOpen) return;
    const timer = setTimeout(() => setFilesMounted(false), GIT_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [filesOpen]);

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
      // The record on the server goes as well — the point of deleting a chat
      // is that it is gone, not that it is hidden on this device. Drop any
      // unsent index entry first, or a retry still in the queue would put the
      // chat back moments after it was removed.
      forgetIndexEntry(id);
      bridge.invoke("chat_index_remove", { id, key: keyFor(id) }).catch(() => {});
      // The room goes with the chat. Closing it on the backend empties its
      // seats; leaving it would hold a room, and everyone in it, for the life
      // of the process on behalf of a conversation that no longer exists.
      bridge.invoke("chat_set_room", { key: keyFor(id), open: false }).catch(() => {});
      delete seen.current[keyFor(id)];
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
      setSeats((prev) => {
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

      /* `/clear` empties the conversation here as well as in the agent.
       *
       * The agent handles it locally and answers with nothing, so without this
       * the agent forgets the conversation while the screen still shows every
       * word of it — the two disagree about what has been said, which is worse
       * than either state on its own.
       *
       * The transcript goes too, or a reload brings it all back. Resetting
       * `seen` is not optional: `transcript::forget` drops the server's
       * sequence counter to zero, and a client still holding the old high
       * number would discard every event after this as already seen. */
      if (text.trim() === "/clear") {
        const key = keyFor(id);
        if (runningRef.current.has(id)) {
          bridge.invoke("chat_send", { key, text }).catch(() => undefined);
        }
        bridge.invoke("chat_forget", { key }).catch(() => undefined);
        seen.current[key] = 0;
        patch(id, (s) => ({ ...emptyChat(), sessionId: s.sessionId }));
        // The saved copy has to be emptied here rather than left to the sync
        // effect, which skips any chat with no messages — that guard is what
        // stops a brand-new chat being saved, and it also meant a cleared one
        // kept its old messages on disk and got them all back on reload.
        setConversations((prev) => {
          const list = prev.map((c) =>
            c.id === id ? { ...c, messages: [], seq: 0, updatedAt: Date.now() } : c,
          );
          saveConversations(list);
          return list;
        });
        return;
      }
      meta.current[id] = {
        projectId: project.id,
        modelId: choice.id,
        access,
      };
      // The same files the agent is given, kept on the bubble so the message
      // shows what was sent with it. The object URLs are dropped: they are this
      // page's copy of the bytes, and a stored one points at nothing.
      // Who this one is for, resolved BEFORE anything is sent so the bubble and
      // the wire agree.
      const seat = mySeats.find((s) => s.id === target) ?? null;
      patch(id, (s) =>
        addUserTurn(
          s,
          text,
          attachments.map((a) => ({ path: a.path, name: a.name, isImage: !!a.isImage })),
          undefined,
          seat ? { id: seat.id, name: seat.name } : undefined,
        ),
      );

      // Put the chat in the index NOW, before the agent is even started —
      // rather than leaving it to the debounced save 700ms later.
      //
      // The transcript starts filling the moment the agent speaks, and
      // `chat_index::reconcile` deletes, at every backend start, any transcript
      // no index entry points at. The gap between "the agent is talking" and
      // "the index has heard of this chat" is therefore a window in which a
      // restart destroys the conversation. Writing the entry first closes it:
      // an entry with no transcript is the harmless direction, and reconcile
      // keeps it on purpose.
      const held = conversations.find((c) => c.id === id);
      const startedAt = Date.now();
      saveIndexEntry({
        id,
        projectId: project.id,
        // A chat is named after the FIRST thing asked in it, so an existing one
        // keeps the name it already has.
        title: held?.title ?? shortTitle(text),
        sessionId: chats[id]?.sessionId ?? held?.sessionId ?? null,
        modelId: choice.id,
        access,
        createdAt: held?.createdAt ?? startedAt,
        updatedAt: startedAt,
      });

      const fail = (err: unknown) =>
        patch(id, (s) => ({
          ...s,
          busy: false,
          notices: [...s.notices, String((err as Error).message ?? err)],
        }));

      // Addressed to a SEAT. Its own process, started by its first message —
      // the same two-call shape the host has always had, which is why this
      // reads like the branch below it rather than like something new.
      if (seat) {
        try {
          await bridge.invoke("chat_send", { key: keyFor(id), text, images, to: seat.id });
        } catch (err) {
          const said = String((err as Error).message ?? err);
          if (!said.includes("not running")) {
            fail(err);
            return;
          }
          // It has never spoken, so there is nothing to write to yet.
          try {
            await bridge.invoke("chat_seat_start", {
              key: keyFor(id),
              seatId: seat.id,
              cwd: project.primary_path ?? "",
              extraDirs: project.paths ?? [],
              access,
              effort,
              images,
              prompt: text,
            });
          } catch (second) {
            fail(second);
          }
        }
        return;
      }

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
          lite,
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
    [project, choice, access, effort, lite, conversationId, chats, conversations, patch],
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

  /** Picking an agent on the Agents page.
   *
   *  Provider and model are one choice on the command line, so choosing an
   *  agent means choosing one of its models: its first, which is the one the
   *  picker would show. Everything else — carrying effort across, and the fact
   *  that a started conversation cannot change provider in place — is already
   *  `changeModel`'s job, so this only decides WHICH row and hands it over. */
  const pickAgent = useCallback(
    (agent: Provider) => {
      if (agent === choice.agent) return;
      const first = MODELS.find((m) => m.agent === agent);
      if (first) changeModel(first);
    },
    [choice.agent, changeModel],
  );

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

  /** What a level is called, in the words of the agent THAT chat runs — the one
   *  on screen may by then be showing another. */
  const accessLabel = useCallback((id: string, level: AccessLevel) => {
    const agent = modelFromId(meta.current[id]?.modelId ?? null)?.agent ?? "claude";
    return ACCESS[agent].find((a) => a.id === level)?.label ?? level;
  }, []);

  /** The fallback for a change the running agent will not take: end its process
   *  and SAY SO.
   *
   *  The transcript stays, so the next message resumes the same session under
   *  the new level. A turn in flight is lost, though — and a chat that stops
   *  mid-answer with nothing on screen to explain it is the thing this whole
   *  path exists to avoid, so the reason goes up as a notice. */
  const restartForAccess = useCallback(
    (id: string, why: string) => {
      endSession(id);
      const level = wantedAccess.current[id];
      const what = level ? accessLabel(id, level) : "That access level";
      patch(id, (s) => ({
        ...s,
        notices: [
          ...s.notices,
          `${what} needs a fresh agent: ${why}. The conversation is kept — say anything to carry on.`,
        ].slice(-8),
      }));
    },
    [endSession, patch, accessLabel],
  );
  onAccessRefused.current = restartForAccess;

  /** Changing what the agent may do, WITHOUT throwing the conversation away.
   *
   *  The mode is fixed on the agent's command line, so this used to kill the
   *  process and let the next message start a new one. That lost whatever the
   *  agent was in the middle of and put nothing on screen to say why the answer
   *  had stopped half-written.
   *
   *  Claude takes the change on the same control channel `chat_interrupt` uses,
   *  so the running turn carries on under the new level instead — and the hook
   *  is told separately by the backend, because it decides BEFORE the mode does
   *  (see agent_chat.rs). Codex needs no channel: its next turn is a new
   *  process and takes the new sandbox on its command line.
   *
   *  Not every change can be made in place — the agent refuses to turn its own
   *  permissions off part-way, and says so — so `restartForAccess` is still
   *  there for the ones that cannot. Nothing running is the easy case: the next
   *  message starts an agent on the new level anyway. */
  // Card 66 — is this chat a room, and who is in it.
  //
  // The switch is stored on the CONVERSATION (it must survive a reload, the
  // same way the model and the permission do). The seat list is the BACKEND's,
  // held in memory there, so it is asked for rather than remembered — a
  // restarted server has forgotten every room while this browser still has the
  // switch drawn on, and `chat_room` answering `open: false` is how that shows.
  const room = conversations.find((c) => c.id === conversationId)?.room ?? false;
  const [seats, setSeats] = useState<Record<string, Seat[]>>({});
  // Who the NEXT message is for, per conversation. `null` is the whole room,
  // which is where every message has always gone — so a chat that never opens
  // a room never leaves this state.
  const [sendTo, setSendTo] = useState<Record<string, string | null>>({});
  const mySeats = (conversationId && seats[conversationId]) || [];
  const myTarget = (conversationId && sendTo[conversationId]) || null;
  // A seat that has been removed cannot stay chosen, or the next message would
  // be refused by a backend that no longer knows the name.
  const target = mySeats.some((s) => s.id === myTarget) ? myTarget : null;

  /** Ask the backend who is in this room. */
  const refreshSeats = useCallback(async (id: string) => {
    try {
      const view = (await bridge.invoke("chat_room", { key: keyFor(id) })) as RoomView;
      setSeats((prev) => ({ ...prev, [id]: view.seats }));
    } catch {
      // A backend that cannot answer leaves the list alone rather than
      // emptying it — an empty rail would read as "everyone left".
    }
  }, []);

  // Who is in the room of the chat now on screen.
  //
  // Rooms live in the BACKEND's memory, so the browser cannot know them from
  // `localStorage` the way it knows the switch. Without this, opening a chat
  // that already has seats showed an empty room until you touched the switch —
  // the switch came back and the people in it did not.
  useEffect(() => {
    if (!conversationId) return;
    void refreshSeats(conversationId);
  }, [conversationId, refreshSeats]);

  const toggleRoom = useCallback(
    async (open: boolean) => {
      if (!conversationId) return;
      const id = conversationId;
      setConversations((prev) => {
        const next = prev.map((c) => (c.id === id ? { ...c, room: open } : c));
        saveConversations(next);
        return next;
      });
      try {
        await bridge.invoke("chat_set_room", { key: keyFor(id), open });
      } catch {
        // The switch is the user's answer and stays where they put it. The
        // backend is re-told on the next thing that needs it.
      }
      // Closing a room empties it on the backend, so the list is re-read
      // either way rather than assumed.
      void refreshSeats(id);
    },
    [conversationId, refreshSeats],
  );

  const addSeat = useCallback(
    async (want: { label: string; agent: "claude" | "codex"; kind?: "on_demand"; provider?: string; context?: "room_only" }) => {
      if (!conversationId) return;
      const id = conversationId;
      try {
        // Say it is a room FIRST. The switch is written optimistically and kept
        // even when its own call failed, and the backend forgets every room it
        // had when it restarts — so by the time someone adds a seat, this
        // browser can be the only one that still thinks this is a room. One
        // idempotent call closes both gaps, and card 67 needs the same thing
        // before a seat can speak.
        await bridge.invoke("chat_set_room", { key: keyFor(id), open: true });
        await bridge.invoke("chat_add_agent", {
          key: keyFor(id),
          seat: {
            name: want.label,
            agent: want.agent,
            kind: want.kind,
            provider: want.provider,
            context: want.context,
          },
        });
      } catch (err) {
        patch(id, (s) => ({ ...s, notices: [...s.notices, String((err as Error).message ?? err)] }));
      }
      void refreshSeats(id);
    },
    [conversationId, refreshSeats],
  );

  const removeSeat = useCallback(
    async (seatId: string) => {
      if (!conversationId) return;
      const id = conversationId;
      try {
        await bridge.invoke("chat_remove_agent", { key: keyFor(id), seatId });
      } catch {
        // Nothing to say: a seat that could not be removed is still listed,
        // which is the truth.
      }
      void refreshSeats(id);
    },
    [conversationId, refreshSeats],
  );

  // Card 68 — the round in flight, per conversation. The BACKEND runs it (a
  // round takes minutes and one driven from here would die with the page), so
  // this is only ever a picture of what it is doing.
  const [rounds, setRounds] = useState<Record<string, RoundState | null>>({});
  const myRound = (conversationId && rounds[conversationId]) || null;

  const refreshRound = useCallback(async (id: string) => {
    try {
      const state = (await bridge.invoke("chat_round_state", {
        key: keyFor(id),
      })) as RoundState;
      setRounds((prev) => ({ ...prev, [id]: state.running ? state : null }));
    } catch {
      // Leave the last picture alone rather than claiming nothing is running.
    }
  }, []);

  const askRoom = useCallback(async () => {
    if (!conversationId || !project) return;
    const id = conversationId;
    // What the room is asked: the last thing YOU said. A round is "put that to
    // everyone", so inventing a different question would put words in your
    // mouth — and there is nothing else in the conversation that is yours.
    const mine = [...(chats[id]?.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = mine?.blocks
      .map((b) => ("text" in b ? b.text : ""))
      .join(" ")
      .trim();
    if (!text) {
      patch(id, (s) => ({
        ...s,
        notices: [...s.notices, "Say something first — a round puts YOUR last message to the room."],
      }));
      return;
    }
    try {
      await bridge.invoke("chat_round", {
        key: keyFor(id),
        order: mySeats.map((s) => s.id),
        text,
        cwd: project.primary_path ?? "",
        extraDirs: project.paths ?? [],
        access,
        effort,
      });
    } catch (err) {
      patch(id, (s) => ({ ...s, notices: [...s.notices, String((err as Error).message ?? err)] }));
    }
    void refreshRound(id);
  }, [conversationId, project, mySeats, access, effort, patch, refreshRound, chats]);

  // Card 69 — whether a topic line has been drawn in this chat.
  //
  // Shown on the ROUND BAR, in the composer, rather than as a rule in the
  // transcript: every control and every notice about the room lives in the
  // composer, by the user's rule of 2026-08-23. The BACKEND is what actually
  // refuses to show a seat anything older; this is only the acknowledgement.
  const [topicDrawn, setTopicDrawn] = useState<Record<string, boolean>>({});

  const newTopic = useCallback(async () => {
    if (!conversationId) return;
    const id = conversationId;
    try {
      await bridge.invoke("chat_new_topic", { key: keyFor(id) });
    } catch {
      // Not acknowledged if the backend did not take it — saying the seats have
      // forgotten, when they have not, is worse than saying nothing.
      return;
    }
    setTopicDrawn((prev) => ({ ...prev, [id]: true }));
  }, [conversationId]);

  const stopRound = useCallback(async () => {
    if (!conversationId) return;
    const id = conversationId;
    try {
      await bridge.invoke("chat_round_stop", { key: keyFor(id) });
    } catch {
      // Nothing to say: a round that could not be stopped is still shown
      // running, which is the truth.
    }
    void refreshRound(id);
  }, [conversationId, refreshRound]);

  // A round says when it is over. Between those it is polled, because the
  // seats speak on their own schedule and a bar that only moved at the end
  // would look frozen for the whole discussion.
  useEffect(
    () =>
      bridge.on<{ key: string }>("chat-round", (payload) => {
        const id = payload && convOf(payload.key);
        if (id) void refreshRound(id);
      }),
    [refreshRound],
  );

  useEffect(() => {
    if (!conversationId || !myRound?.running) return;
    const id = conversationId;
    const tick = setInterval(() => void refreshRound(id), 2000);
    return () => clearInterval(tick);
  }, [conversationId, myRound?.running, refreshRound]);

  const changeAccess = useCallback(
    (p: AccessLevel) => {
      setAccess(p);
      localStorage.setItem(ACCESS_KEY, p);
      if (!conversationId) return;
      if (meta.current[conversationId]) meta.current[conversationId].access = p;
      if (!runningRef.current.has(conversationId)) return;
      wantedAccess.current[conversationId] = p;
      const id = conversationId;
      bridge
        .invoke("chat_set_access", { key: keyFor(id), access: p })
        .catch((err) => {
          const why = String((err as Error).message ?? err);
          // The process ended between the tap and the ask. Nothing to change
          // and nothing to restart: the next message starts one on the new
          // level, which is what a restart would have arranged anyway.
          if (why.includes("no such chat")) return;
          // Otherwise the backend is too old to know the command, or the write
          // failed. Either way the change cannot be made in place.
          restartForAccess(id, why);
        });
    },
    [conversationId, restartForAccess],
  );

  if (conn === "unauthorized") return <Connect />;

  /* Chat or Files. Marked by a filled pill, not an edge stripe: on a 48px-tall
     bar a thin marker is a thing you squint at. */
  const viewSwitch = (
    <div className="mode-switch" role="group" aria-label="View">
      <button
        className={`mode-btn ${mode === "chat" ? "is-on" : ""}`}
        type="button"
        aria-pressed={mode === "chat"}
        title="Chat"
        onClick={() => pickMode("chat")}
      >
        <svg className="mode-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.7A8.4 8.4 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z" />
        </svg>
        <span className="mode-label">Chat</span>
      </button>
      <button
        className={`mode-btn ${mode === "editor" ? "is-on" : ""}`}
        type="button"
        aria-pressed={mode === "editor"}
        title="Files"
        onClick={() => pickMode("editor")}
      >
        <svg className="mode-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m8 17-4-5 4-5M16 7l4 5-4 5" />
        </svg>
        <span className="mode-label">Files</span>
      </button>
    </div>
  );

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      {conn !== "open" && (
        <div className="conn-strip">
          {conn === "connecting" ? "Connecting to OctiqFlow…" : "Reconnecting…"}
        </div>
      )}

      <header className="topbar">
        {/* The project name IS the way into the drawer.
            A hamburger beside a project name is two controls saying "projects"
            where one will do, and on a phone the bar has four things to carry
            and 390px to carry them in. Off the phone the sidebar is always
            open, so this stops being a button and is just the title. */}
        <button
          className="topbar-title"
          type="button"
          aria-label="Projects and chats"
          aria-expanded={drawer}
          onClick={() => setDrawer((v) => !v)}
          disabled={wide}
        >
          <span className="topbar-name">{project?.name ?? "OctiqFlow"}</span>
          <span className="topbar-caret" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </button>

        <span className="topbar-gap" />

        {/* The view switch and the usage meter are HERE only on a wide screen.
            On a phone they are in the drawer — see the Sidebar below. Both are
            rendered once, in one place or the other, rather than twice with one
            hidden: the meter polls an endpoint that rate-limits per account. */}
        {wide && viewSwitch}

        {/* The plan: a count on the bar, the list one tap under it. */}
        <Todos todos={todos} />

        {/* The files the chat has touched: a count on the bar, the column one
            tap under it. Beside Git because they are the same kind of thing —
            a column about the code, opened from the bar — and because they take
            turns, so having them next to each other is what makes that read as
            a switch rather than as one closing on its own. */}
        <FilesButton
          count={sessionFiles.length}
          open={filesOpen}
          onToggle={() => showFiles(!filesOpen)}
        />

        <GitButton project={project} open={gitOpen} onToggle={() => showGit(!gitOpen)} />

        <button
          className="icon-btn"
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => setAppSettings(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* A new chat in the project named on the left. Last, at the thumb end
            of the bar, because it is the one thing here you press rather than
            read. */}
        {project && (
          <button
            className="icon-btn new-chat"
            type="button"
            aria-label={`New chat in ${project.name}`}
            title="New chat"
            onClick={() => startBlank(project.id)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}

        {wide && <Usage />}
      </header>

      {/* `id` so the file panel can render INTO this row from where its state
          lives, which is above the whole app — see components/OpenFile. It has
          to be a sibling of the views to take width from them, and nothing that
          opens a file is anywhere near them in the tree. */}
      <div className="body" id="dock">
        <div className="scrim" onClick={() => setDrawer(false)} />

        <Sidebar
          projects={workspaces}
          shelved={shelved}
          onShowShelved={() => setShelfOpen(true)}
          onShowAgents={() => {
            // Read through the cache on open, so the page paints at once; the
            // page's own "Check again" is the one that asks the shell afresh.
            loadAgentList();
            setAgentsOpen(true);
          }}
          agentName={agents.find((a) => a.id === choice.agent)?.name ?? choice.name}
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
          head={wide ? undefined : viewSwitch}
          foot={wide ? undefined : <Usage />}
        />

        <main className="main" hidden={mode !== "chat"}>
          {chat.messages.length === 0 && conversationId && reading[conversationId] ? (
            // Reading the transcript back. Until it lands this conversation
            // has no messages, and the page for a conversation with no
            // messages is the one offering to open a session — the very thing
            // that was just done. So: say it is opening, and say which.
            //
            // Two ways in and one name: a session picked out of the agent's own
            // history is named by the row that was picked, and a chat opened
            // from the sidebar by the name it already carries there.
            <div className="hero is-waiting">
              <div className="dots" aria-label="opening" />
              <p className="hero-sub">
                opening “
                {resumed[conversationId]?.title ??
                  conversations.find((c) => c.id === conversationId)?.title ??
                  "the session"}
                ”…
              </p>
            </div>
          ) : chat.messages.length === 0 ? (
            <div className="hero">
              <h1 className="hero-title">
                What do you want to do{project ? ` in ${project.name}` : ""}?
              </h1>
              {chat.sessionId &&
                (conversationId && resumed[conversationId] ? (
                  <p className="hero-sub">
                    continuing “{resumed[conversationId].title}” ·{" "}
                    {resumed[conversationId].agent === "claude" ? "Claude" : "Codex"}
                    {resumed[conversationId].problem && (
                      // The transcript could not be read. Saying so beats the
                      // blank page that looks like the click did nothing —
                      // typing still resumes the real session.
                      <span className="hero-warn">
                        {" "}
                        · could not read it back ({resumed[conversationId].problem}). Typing still
                        carries on the session.
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="hero-sub">continuing an earlier session</p>
                ))}
              {project && <SessionSearch projectPath={project.primary_path} onResume={resumeHistory} />}
            </div>
          ) : (
            // The transcript and the agent rail sit side by side. The rail
            // draws nothing at all until this conversation starts an agent, so
            // the row collapses back to the plain transcript on its own.
            <div className="chat-body">
              {/* The transcript stays MOUNTED behind the focus panel rather
                  than being swapped out for it. Unmounting would throw away
                  where the reader was, and the list scrolls itself to the
                  bottom on mount — so the back arrow would always land at the
                  end of the conversation instead of where they left. */}
              {/* A path written into a reply is relative to the PROJECT, and
                  only this knows which one is open — see components/ProsePath. */}
              <PathCwdProvider value={project?.primary_path ?? ""}>
                <div className="chat-main">
                  <MessageList
                    messages={chat.messages}
                    busy={chat.busy}
                    stoppedAt={chat.stoppedAt}
                    compactingSince={chat.compactingSince}
                    conversationId={conversationId ?? undefined}
                  />
                  {focused && (
                    <AgentFocus
                      run={focused}
                      messages={chat.messages}
                      onBack={() => setFocusedAgent(null)}
                    />
                  )}
                </div>
              </PathCwdProvider>
              {/* The right column: the agents this chat started, as a card
                  that looks like it is floating but keeps its own space — the
                  conversation ends where the column begins, so nothing is ever
                  underneath it. Drawn only when there is an agent to list. */}
              {chat.agents.length > 0 && (
                <aside className="side">
                  <AgentRail agents={chat.agents} onOpen={setFocusedAgent} />
                </aside>
              )}
            </div>
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

          {(conversationId ? asks[conversationId] ?? [] : []).map((ask) => (
            <PermissionAsk
              key={ask.id}
              ask={ask}
              onAnswered={(id) =>
                setAsks((prev) => ({
                  ...prev,
                  [conversationId!]: (prev[conversationId!] ?? []).filter((a) => a.id !== id),
                }))
              }
            />
          ))}

          {/* A whole batch as ONE card.

              An agent can ask several things in a single turn — Claude batches
              independent tool calls — and every one of them blocks. Shown side
              by side they read as a form dumped on you at once, and the later
              ones often depend on the earlier answers. The card pages through
              them one at a time and sends the set together. */}
          {(() => {
            const pending = conversationId ? questions[conversationId] ?? [] : [];
            if (pending.length === 0) return null;
            return (
              <UserQuestion
                // Keyed on the FIRST question, not the whole list. Keying on
                // the list meant a question arriving mid-batch changed the key,
                // remounting the card and throwing away the answers already
                // given and the page you were on. The first id is stable until
                // the batch is submitted, which is exactly when a fresh card is
                // wanted.
                key={pending[0].id}
                questions={pending}
                onDone={(ids) =>
                  setQuestions((prev) => ({
                    ...prev,
                    [conversationId!]: (prev[conversationId!] ?? []).filter(
                      (x) => !ids.includes(x.id),
                    ),
                  }))
                }
              />
            );
          })()}

          {/* Keyed by project: switching project gets that project's own
              terminals, and coming back reattaches to them rather than
              starting a second set. */}
          {termOpen && project && (
            <TerminalDrawer
              key={project.id}
              project={project}
              onCommandsChanged={loadWorkspaces}
              onHide={() => {
                setTermOpen(false);
                localStorage.setItem(TERM_KEY, "0");
              }}
            />
          )}

          <Composer
            session={conversationId ?? undefined}
            choice={choice}
            onChoice={changeModel}
            started={chat.messages.length > 0}
            access={access}
            onAccess={changeAccess}
            onSend={send}
            onStop={stop}
            busy={chat.busy}
            disabled={!project}
            installed={installed}
            commands={(projectId && commands[projectId]) || []}
            contextTokens={chat.contextTokens}
            contextWindow={chat.contextWindow}
            activity={chat.activity}
            turnStartedAt={chat.turnStartedAt}
            turnTokens={turnOutput(chat)}
            turnApprox={turnOutputApprox(chat)}
            thinking={isThinking(chat)}
            thought={thinkingNow(chat)}
            effort={effort}
            onEffort={changeEffort}
            lite={lite}
            onLite={changeLite}
            room={room}
            seats={mySeats}
            to={target}
            round={myRound}
            onAsk={askRoom}
            onStopRound={stopRound}
            onNewTopic={newTopic}
            topicDrawn={!!(conversationId && topicDrawn[conversationId])}
            onTarget={(seatId) =>
              conversationId && setSendTo((prev) => ({ ...prev, [conversationId]: seatId }))
            }
            onRoom={toggleRoom}
            onAddSeat={addSeat}
            onRemoveSeat={removeSeat}
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

        {editorSeen && (
          <div className="ws-host" hidden={mode !== "editor"}>
            <Suspense fallback={<div className="dots" aria-label="loading" />}>
              <EditorMode project={project} />
            </Suspense>
          </div>
        )}

        {/* On a wide screen a sibling of the views, not something laid over
            them: whichever view is showing gives up width while this is open and
            takes it straight back when it closes. It sits beside the editor too
            — reading a diff next to the file it belongs to is the whole point.
            On a phone the stylesheet turns the same element into a sheet that
            slides in from the right. */}
        {gitMounted && (
          <GitPanel project={project} open={gitOpen} onClose={() => showGit(false)} />
        )}

        {filesMounted && (
          <SessionFilesPanel
            paths={sessionFiles}
            open={filesOpen}
            busy={chat.busy}
            onClose={() => showFiles(false)}
          />
        )}
      </div>

      {agentsOpen && (
        <AgentsPage
          agents={agents}
          current={choice.agent}
          onPick={(agent) => {
            pickAgent(agent);
            setAgentsOpen(false);
          }}
          onReload={() => loadAgentList(true)}
          onClose={() => setAgentsOpen(false)}
        />
      )}

      {shelfOpen && (
        <ShelvedProjects
          projects={shelved}
          onRestored={loadWorkspaces}
          onClose={() => setShelfOpen(false)}
        />
      )}

      {appSettings && (
        <Settings
          current={themeId}
          onPick={setThemeId}
          notify={notifyOn}
          onNotify={(on, viaPush) => {
            setNotifyOn(on);
            setPushOn(on && viaPush);
          }}
          onClose={() => setAppSettings(false)}
        />
      )}

      {settingsFor && (
        <ProjectSettings
          project={
            // Shelved ones are looked up too, or the dialog opened from the
            // shelf would find nothing — and its Bring back button is the only
            // reason to open it.
            settingsFor === "new"
              ? null
              : [...workspaces, ...shelved].find((w) => w.id === settingsFor) ?? null
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
