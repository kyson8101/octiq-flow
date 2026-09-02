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
import { CatchUp } from "./lib/catchUp";
import { CARRY_ON, someoneWorking, wasCutOff } from "./lib/carryOn";
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
  chatName,
  loadConversations,
  rewriteConversation,
  opensBlank,
  sameIndex,
  saveConversations,
  shortTitle,
  type Conversation,
} from "./lib/store";
import { removeIndexEntry, saveIndexEntry } from "./lib/chatIndex";
import { recall, remember } from "./lib/remember";
import { deletedIds, isDeleted, listDeletions, markDeleted } from "./lib/deletions";
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
import { AgentRail, RailButton } from "./components/AgentRail";
import { BackgroundProvider } from "./components/Background";
import { backgroundCalls } from "./lib/background";
import { latestTodos } from "./lib/todos";
import { roomCount } from "./lib/roomCount";
import { readMention } from "./lib/mention";
import { DRAWER, useMedia, WIDE } from "./lib/media";
import { useDrawerSwipe } from "./lib/swipe";
import { neighbour, useChatSwipe } from "./lib/chatSwipe";
import { MessageList } from "./components/MessageList";
import { Composer, type Attachment } from "./components/Composer";
import {
  accessFor,
  accessLabel as providerAccessLabel,
  effortFor,
  liveSettingCommand,
  MODELS,
  modelFromId,
  parseCommandCache,
  providerCommands,
  providerFor,
  type AccessLevel,
  type CommandCache,
  type Effort,
  type ModelChoice,
  type Provider,
} from "./lib/agentProviders";
import { Connect } from "./components/Connect";
import { SessionSearch } from "./components/SessionSearch";
import { isUnder, readSession, replaySession, type HistorySession } from "./lib/history";
import { Sidebar, type Project } from "./components/Sidebar";
import { AgentsPage, loadAgents, type AgentInstall } from "./components/AgentsPage";
import { ShelvedProjects } from "./components/ShelvedProjects";
import { WorkBoard } from "./components/WorkBoard";
import { buildBoard } from "./lib/board";
import { ProjectSettings } from "./components/ProjectSettings";
import { Settings } from "./components/Settings";
import { savedThemeId } from "./lib/themeStore";
import { Usage } from "./components/Usage";
import { GitButton, GitPanel } from "./components/GitPanel";
import { FilesButton, SessionFilesPanel, useSessionPins } from "./components/SessionFiles";
import { FullscreenButton } from "./components/FullscreenButton";
import { useCloseFile } from "./components/OpenFile";
import { PathCwdProvider } from "./components/ProsePath";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { PermissionAsk, askSummary, type Ask } from "./components/PermissionAsk";
import { UserQuestion, type Question } from "./components/UserQuestion";
import { CarryOn } from "./components/CarryOn";
import { RollingNumber, RollingText } from "./components/RollingNumber";
import { appendConversationPin, type ConversationPin } from "./lib/conversationPins";
import { projectSlug } from "./lib/projectSlug";

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

/** One send's identity across the optimistic browser bubble and the durable
 *  Codex prompt event the backend emits after accepting it. */
function userTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-${crypto.randomUUID()}`;
  }
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** How long a deleted chat can be brought back. Long enough to see the ring on
 *  its row start to empty and press it again; short enough that the agent a
 *  delete is meant to stop is not still running a minute later. */
const UNDO_MS = 2000;

/** The final visual beat after an undoable delete commits. Keep this aligned
 *  with `.chat-row`'s transition in styles.css: the row must stay mounted for
 *  the full collapse, or the chats below it snap up at the end. */
const DELETE_COLLAPSE_MS = 180;

/** A delete that has happened on screen and nowhere else yet.
 *
 *  Nothing has reached the server while this is held: the transcript, the index
 *  entry, the room and the agent's own process are all still there, untouched.
 *  That is what lets a cancel leave the chat ALONE rather than build a copy of
 *  it — and it is why the wait is seconds rather than minutes, since a chat
 *  that is still working carries on working for the whole of it.
 *
 *  The row does not move either. It used to go at once, and the way back was a
 *  bar in the corner — which meant that for those seconds the chat was missing
 *  from the list while still listed by the server, and ANY answer arriving in
 *  the window (`chat-index-changed` fires on every save, from any device) put
 *  the row straight back with the bar still on screen. Now the row stays and
 *  counts down in place, so there is no gap for an index answer to fill.
 *
 *  There is one of these per row, not one for the whole list. Clearing out a
 *  handful of chats is several presses in a row on rows sitting next to each
 *  other, and when a second press ended the first chat at once the ring people
 *  were counting on was only ever there for the last one they pressed. Each row
 *  now runs its own clock and its own way back. */
type PendingDeletes = Map<string, ReturnType<typeof setTimeout>>;

/** Rows whose delete is settled but which have one short collapse left before
 *  they can be removed from React's list. */
type PendingRemovals = Map<string, ReturnType<typeof setTimeout>>;

/** No row counting down. A shared object so the empty case is the SAME set
 *  every time: a fresh one each render would tell every memo below that the
 *  sidebar had changed when nothing had. */
const NONE_DELETING: ReadonlySet<string> = new Set();

/** No rows are in their final collapse. Kept stable for the same reason as
 *  `NONE_DELETING`: it keeps the sidebar from seeing a change that did not
 *  happen. */
const NONE_LEAVING: ReadonlySet<string> = new Set();

/** The state of a chat that has nothing in it yet. One shared object: nothing
 *  mutates a ChatState in place, so every not-yet-started conversation can
 *  point at the same one. */
const EMPTY: ChatState = emptyChat();

const CHOICE_KEY = "octiq.v2.model";
const ACCESS_KEY = "octiq.v2.access";
const OPEN_KEY = "octiq.v2.openFolders";
const CMDS_KEY = "octiq.v2.commands";
const EFFORT_KEY = "octiq.v2.effort";
/** How long a ROOM is given to hand a seat's answer to its host before the
 *  chat is called cut off. Long enough to start an agent — the gap is a fresh
 *  process reading its own history, not a stopped backend. */
const HANDOVER_MS = 20_000;
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
 *  Shape: #/p/<projectSlug>/c/<chatId> — the project half is the label's slug
 *  (see `lib/projectSlug`), so the link says where it goes rather than a UUID
 *  that says nothing. Older saved links carry the raw workspace id instead —
 *  both forms are resolved against the workspace list once it arrives (the
 *  `list_workspaces` handler below), never here: this function only returns
 *  the raw decoded token. The chat half is dropped for a project with nothing
 *  open yet. */
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
/** The git column, open. A NEW key rather than the old `gitOpen`: for a while
 *  the desktop column was permanent and this flag only tracked what the smaller
 *  layouts did, so most saved copies of it read "shut" for reasons that no
 *  longer apply — and reading one of those would open the desktop with no
 *  changes column, which is exactly what the column was added to stop. A
 *  missing key means the layout decides; see `gitOpen`. */
const GIT_KEY = "octiq.v2.gitColumn";
/** The project column, put away. Only means anything at 860px and up, where
 *  the sidebar is a column; below that it is a drawer and `drawer` is the flag
 *  that says whether it is out. */
const NAV_KEY = "octiq.v2.navShut";
const FILES_KEY = "octiq.v2.filesOpen";
/** The agent column, put away. Stored the other way round from the two above:
 *  the rail shows itself the moment a chat starts an agent, so what is worth
 *  remembering is the decision to CLOSE it. A missing key is open. */
const RAIL_KEY = "octiq.v2.railShut";
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
  const [boardOpen, setBoardOpen] = useState(false);
  /** What the address bar asked for on arrival. Read once: after this the URL
   *  follows the app, not the other way round. */
  const opened = useRef(readLocation());
  // Every chat that is loaded or running, keyed by conversation id. Chats run
  // in PARALLEL: switching to another one leaves this one working, and its
  // answer lands in here whether or not you are looking at it.
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  // The conversations with a live agent process behind them.
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  /** Whether the server has said what is running yet. Until it has, an empty
   *  `running` means "not asked", not "nothing is". Telling the two apart is
   *  what keeps a cut-turn notice off a chat that is perfectly alive — see
   *  lib/carryOn. */
  const [liveKnown, setLiveKnown] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem(MODE_KEY) === "editor" ? "editor" : "chat",
  );
  // Once the editor has been opened it stays MOUNTED behind the chat, hidden
  // rather than unmounted. Its open files hold unsaved drafts, and a tap on
  // "Chat" is not a decision to throw them away.
  const [editorSeen, setEditorSeen] = useState(() => localStorage.getItem(MODE_KEY) === "editor");
  // The stored list, minus everything this browser has deleted. The two are
  // written at different moments — a save already on its way when the × was
  // clicked lands after it — so the copy on disk can still carry a chat whose
  // delete is settled. See lib/deletions.
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations().filter((c) => !isDeleted(c.id)),
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  /** A pin list click is an instruction for the transcript, not a durable chat
   * setting. The nonce lets the same label take the reader back twice. */
  const [pinJump, setPinJump] = useState<{
    id: string;
    turnId: string;
    nonce: number;
  } | null>(null);
  const [activePinId, setActivePinId] = useState<string | null>(null);
  /** Which agent the rail has opened, by `task_id`, or null for the whole
   *  conversation. View state, not chat state: it is about what this person is
   *  reading, and it must not survive into another conversation. */
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  /** Wide enough for a sidebar column — and so for a top bar that can hold the
   *  view switch and the usage meter. Below it those live in the drawer. */
  const wide = useMedia(WIDE);
  /** A temporary focus view for the tablet layout. On a desktop each column
   *  already has its own control on the bar — the project name, the Git
   *  button — so one more that sweeps both away at once adds nothing. */
  const [chatWide, setChatWide] = useState(false);
  const chatExpanded = chatWide && wide && mode === "chat";
  /** The project column, put away, on the screens where it is a column.
   *  Remembered: someone who works with the chat full width wants it that way
   *  the next time too. */
  const [navShut, setNavShut] = useState(() => localStorage.getItem(NAV_KEY) === "1");
  /** Whether the sidebar is a drawer at all. Not the same question as `wide`:
   *  the top bar gains room at 700px, the drawer only becomes a column at 860.
   *  Between the two there is still something to swipe. */
  const hasDrawer = useMedia(DRAWER);
  /** The app shell, which the drag gesture listens on because it holds both the
   *  drawer and everything the drawer slides over. */
  const shell = useRef<HTMLDivElement | null>(null);
  /** The chat pane, which the OTHER drag gesture listens on: a sideways swipe
   *  over the transcript moves along the project's chats — see lib/chatSwipe. */
  const pane = useRef<HTMLElement | null>(null);
  // Drag in from the left edge to pull the drawer out, and back to put it away.
  // Touch only, and only while the drawer exists — see lib/swipe for how the
  // gesture keeps out of the way of scrolling and of highlighting text.
  useDrawerSwipe(shell, { enabled: hasDrawer && !chatExpanded, open: drawer, onChange: setDrawer });
  // There must always be a visible way back. A narrow layout already gives the
  // chat the whole body, and the editor owns a different kind of workspace.
  useEffect(() => {
    if (!wide || !hasDrawer || mode !== "chat") setChatWide((was) => (was ? false : was));
  }, [wide, hasDrawer, mode]);
  // Switching conversations closes the focus panel. Without this the next
  // conversation opens showing "conversation" as a back arrow over a blank
  // panel until something is clicked.
  useEffect(() => {
    setFocusedAgent(null);
    setPinJump(null);
    setActivePinId(null);
  }, [conversationId]);
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
  //
  // A desktop OPENS with it, because there the workspace is three columns and
  // one you have to fetch on every visit is not one of them. Anywhere it would
  // cover the chat instead, it starts shut. Both are defaults only: the moment
  // it is toggled the remembered flag answers, at every width.
  const [gitOpen, setGitOpen] = useState(() => {
    const saved = recall(GIT_KEY);
    if (saved !== null) return saved === "1";
    // The same question `hasDrawer` answers, asked one render earlier: the
    // media hook has not run yet, and a column that appears a frame late reads
    // as the page still loading.
    return typeof window !== "undefined" && !window.matchMedia(DRAWER).matches;
  });
  /** Kept mounted while the panel slides away, so closing it on a phone is the
   *  reverse of opening rather than the panel blinking out. Unmounting on
   *  `gitOpen` alone would cut the animation off at its first frame. */
  const [gitMounted, setGitMounted] = useState(gitOpen);
  /** Column, not overlay: above the drawer breakpoint the panel is the third
   *  column of the workspace and takes its width from the chat rather than
   *  covering it. About its SHAPE, not about whether it can be put away — it
   *  can, in either shape, from the same top-bar button. */
  const desktopGit = !hasDrawer;
  // The files column, on the same terms as the git one beside it: the button
  // that opens it is in the top bar, the panel it opens is a column in the
  // body, and only one piece of state joins them.
  const [filesOpen, setFilesOpen] = useState(() => localStorage.getItem(FILES_KEY) === "1");
  const [filesMounted, setFilesMounted] = useState(filesOpen);
  // The agent column. Shown by default and closed by hand, so the flag it
  // keeps is the closing — see RAIL_KEY.
  const [railShut, setRailShut] = useState(() => localStorage.getItem(RAIL_KEY) === "1");
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
    () => modelFromId(recall(CHOICE_KEY)) ?? MODELS[0],
  );
  // What the agent may do unattended. Defaults to the cautious end: a chat has
  // no way to answer a permission prompt, so this is the whole of the answer.
  const [access, setAccess] = useState<AccessLevel>(() => {
    const saved = recall(ACCESS_KEY);
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
    if (saved && legacy[saved]) return accessFor(choice.agent, legacy[saved]);
    const known: AccessLevel[] = ["read", "manual", "edits", "auto", "full"];
    return accessFor(
      choice.agent,
      known.includes(saved as AccessLevel) ? (saved as AccessLevel) : "read",
    );
  });
  // How hard the model thinks. Fixed on the agent's command line, so changing
  // it takes effect from the next message — see changeEffort.
  const [effort, setEffort] = useState<Effort>(
    () => (recall(EFFORT_KEY) as Effort | null) ?? "medium",
  );
  // A clean chat: none of this machine's skills, hooks or other MCP servers.
  // Read once, when the agent process starts, so turning it on part way through
  // a conversation changes nothing until a new chat begins. Off by default —
  // the skills and hooks are there because somebody installed them.
  const [lite, setLite] = useState<boolean>(() => recall(LITE_KEY) === "1");
  const changeLite = useCallback((on: boolean) => {
    setLite(on);
    remember(LITE_KEY, on ? "1" : "0");
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
  // And for the list itself, so the server's answer can be compared against
  // what this page holds without rebuilding the effect that asks for it.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  /** Chats this page knows are GONE: deleted here — this visit or an earlier
   *  one — or listed as deleted by the server.
   *
   *  Worth writing down because a missing row is ambiguous. The debounced save
   *  builds a row for any loaded chat the list has none for — that is how a
   *  brand-new chat is first written down — and it cannot otherwise tell one
   *  from a chat that was thrown away a moment ago. Told which is which, it
   *  leaves the second alone.
   *
   *  It starts from the stored deletion list rather than empty, because the
   *  ambiguity outlives the page: a reload arrives holding a cached row, a
   *  cached transcript and, if the removal never landed, a server entry still
   *  naming the chat — all three of which read as a chat nobody has deleted.
   *  What is only in memory here is the second half, the chats the SERVER said
   *  were deleted; those need no tombstone, since the same list will say so
   *  again. See lib/deletions. */
  const gone = useRef<Set<string>>(deletedIds());

  /** A committed delete keeps its row in React just long enough for its height
   *  to collapse. The index refresh reads this ref too, so an answer from the
   *  server cannot unmount the row before that transition gets a frame. */
  const leavingRef = useRef<Set<string>>(new Set());

  /** Drop everything this page holds of a chat. The record on the server is
   *  someone else's business — `commitDelete` deletes it, and the index says so
   *  when another device did — this is only the copy in front of you: its
   *  transcript in memory, what it was started with, how far it had been read,
   *  its seats, and the screen if it is the one you are looking at. */
  const forgetLocally = useCallback((id: string) => {
    gone.current.add(id);
    catchUp.current.forget(keyFor(id));
    setChats((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSeats((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    delete meta.current[id];
    setConversationId((open) => (open === id ? null : open));
    // The chat you were last in is remembered by id, and a deleted one left
    // there is a restore that waits for a row that is never coming.
    try {
      if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
    } catch {
      /* storage blocked: nothing was remembered to forget */
    }
  }, []);

  // The level each chat was last asked to change to. An agent that will not
  // take the change says so on its own event, well after the tap, so this is
  // what names the change it is refusing — for a background chat as much as
  // the one on screen.
  const wantedAccess = useRef<Record<string, AccessLevel>>({});
  // And the fallback to run when that refusal arrives. Held in a ref because
  // the listener below is set up long before `endSession` exists to build it.
  const onAccessRefused = useRef<(id: string, why: string) => void>(() => {});

  // How much of each chat's record this page actually holds.
  //
  // Two facts, not one: how far we have read, and whether that reading started
  // at the beginning. They used to be the same number, and on a second device
  // they are not: the agent talking in a chat this page holds NOTHING of pushed
  // the number past the whole transcript, so opening it asked for the tail,
  // got nothing, and drew an empty page. See lib/catchUp.
  const catchUp = useRef(new CatchUp());

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
  //
  // The projects are in here for the banner's title, which names the project
  // before the chat — and a shelved project's chats still announce themselves,
  // so both lists count.
  const notifying = useRef({
    on: notifyOn,
    push: pushOn,
    reading: conversationId,
    list: conversations,
    projects: workspaces,
    shelved,
  });
  notifying.current = {
    on: notifyOn,
    push: pushOn,
    reading: conversationId,
    list: conversations,
    projects: workspaces,
    shelved,
  };
  // Set long before `openConversation` exists, like `onAccessRefused` below.
  const onOpenChat = useRef<(id: string) => void>(() => {});
  /** A chat a tapped banner asked for that the list did not have yet.
   *
   *  A phone wakes with the socket dropped and the conversation list still on
   *  its way. The tap must not be spent on a chat this page has not heard of,
   *  so it is remembered here and opened the moment the list lands. */
  const awaited = useRef<string | null>(null);
  // Answered ids, so one ask does not announce twice. It reaches this page down
  // two routes — the live broadcast and the refill on connect — and the second
  // arrival is the same question, not a new one.
  const announced = useRef<Set<string>>(new Set());

  /** Put one moment on the desktop, unless it is already in front of you. */
  const announce = useCallback((kind: NoticeKind, id: string, detail: string) => {
    const { on, push: viaPush, reading, list, projects, shelved: away } = notifying.current;
    // The server has this covered, and its banner arrives whether or not this
    // page is still here. Raising one too would only double it.
    if (viaPush) return;
    if (!owed({ enabled: on, permission: permissionNow() }, focusNow(reading), id)) return;
    const chat = list.find((c) => c.id === id);
    const notice = noticeFor({
      kind,
      conversationId: id,
      projectName: [...projects, ...away].find((w) => w.id === chat?.projectId)?.name ?? "",
      chatTitle: chat?.title ?? "",
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

  const pickMode = useCallback((next: Mode) => {
    setMode(next);
    if (next === "editor") setEditorSeen(true);
    remember(MODE_KEY, next);
  }, []);

  useEffect(() => bridge.onState(setConn), []);

  useEffect(() => {
    remember(OPEN_KEY, JSON.stringify([...expanded]));
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
          // — a shelved or deleted project must not leave you on nothing. An
          // old saved link carries the raw id rather than a slug, and still
          // lands: matched against both.
          const asked = opened.current.project;
          if (asked) {
            const hit = active.find(
              (w) => w.id === asked || projectSlug(w.name) === projectSlug(asked),
            );
            if (hit) return hit.id;
          }
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
    remember(CHOICE_KEY, next.id);
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
  const refreshIndex = useCallback(() => {
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
      .then((answer) => {
        // An EMPTY answer is not news, it is the absence of news. `index.json`
        // missing, unreadable, or belonging to a profile that was switched all
        // read back as zero chats, and treating that as the truth would wipe
        // every conversation this browser holds. A server that genuinely has
        // none has nothing to tell us either, so ignoring it costs nothing.
        if (!answer || answer.length === 0) return;
        // Anything this browser deleted is not on offer, however the server
        // answers. An entry that is still listed says the removal never landed
        // — the call was in flight when the socket closed, or the backend
        // restarted under it — so it is sent again here rather than shown as a
        // chat. This is the compare the whole deletion list exists for.
        const buried = listDeletions();
        for (const d of buried) {
          if (answer.some((r) => r.id === d.id)) removeIndexEntry(d.id, d.key);
        }
        const gravestones = new Set(buried.map((d) => d.id));
        const remote = gravestones.size ? answer.filter((r) => !gravestones.has(r.id)) : answer;
        // Every chat the server still lists is one this browser has deleted:
        // nothing to fold in, and an empty list here means the same as an empty
        // answer above — no news.
        if (remote.length === 0) return;
        // A chat this page has seen LISTED and the list no longer carries has
        // been deleted — here a moment ago, or on another device. The row is
        // dropped for it below, and everything this page holds of it goes with
        // the row.
        //
        // Going with the row is the point. This page reopens the chat you were
        // last in straight from its cached copy, a tick before this answer
        // lands — so a chat deleted on the last visit was on screen, loaded,
        // and missing only its row. The debounced save writes a row for exactly
        // that shape, and did: a new row, a new createdAt, and a fresh entry
        // pushed back into the server's index. The delete undid itself, and the
        // chat was back in the sidebar every time it was thrown away.
        const known = new Set(remote.map((r) => r.id));
        for (const c of conversationsRef.current) {
          // A local delete has already committed, but its sidebar row gets a
          // brief collapse before React unmounts it. Do not let the index
          // answer cut that visual transition short.
          if (c.synced && !known.has(c.id) && !leavingRef.current.has(c.id)) {
            forgetLocally(c.id);
          }
        }
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
              // Pins are a reader’s local index into the transcript. They are
              // deliberately not server-index metadata, so keep them through a
              // routine index refresh instead of letting an unrelated rename
              // make them disappear.
              conversationPins: cached?.conversationPins,
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
          const mine = local.filter(
            (c) => !known.has(c.id) && (!c.synced || leavingRef.current.has(c.id)),
          );
          const all = [...merged, ...mine];
          // Most answers say exactly what this page already holds — a
          // reconnection, or the echo of this page's own save — and folding one
          // of those in is not free: every row is rebuilt, the app re-renders,
          // and the whole store is written back to localStorage, transcripts
          // and all. An answer that changes nothing is dropped instead.
          if (sameIndex(local, all)) return local;
          saveConversations(all);
          return all;
        });
      })
      .catch(() => {});
  }, [forgetLocally]);

  // Asked for on every CONNECT rather than once on load, and again the moment
  // the server says the list has changed.
  //
  // Once on load was the whole of it, and it made the sidebar a snapshot: a
  // chat started on the phone — or deleted on it — reached the laptop at the
  // next reload and not before. A connect covers the device that was asleep
  // while the change happened; the event covers the one that was watching.
  useEffect(() => {
    if (conn !== "open") return;
    refreshIndex();
  }, [conn, refreshIndex]);

  useEffect(() => {
    // Coalesced: a save and its neighbours arrive in a burst, and the answer to
    // all of them is the same one list.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = bridge.on("chat-index-changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refreshIndex, 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refreshIndex]);

  // A chat can arrive from another device for a project this page has never
  // heard of, because the project was made over there too. The row would then
  // render nowhere at all — the sidebar draws chats INSIDE their project, so a
  // chat whose folder is missing is simply invisible.
  //
  // Asked ONCE per unknown project, which is the whole reason for the ref: a
  // project that is genuinely gone stays unknown after the reload, and
  // re-asking on that would be a loop that never settles. Shelved ones count as
  // known for the same reason — they are deliberately not in `workspaces`.
  const askedAbout = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (workspaces.length === 0) return;
    const known = new Set([...workspaces, ...shelved].map((w) => w.id));
    const strangers = conversations
      .map((c) => c.projectId)
      .filter((id) => !known.has(id) && !askedAbout.current.has(id));
    if (strangers.length === 0) return;
    for (const id of strangers) askedAbout.current.add(id);
    loadWorkspaces();
  }, [conversations, workspaces, shelved, loadWorkspaces]);

  // Adopt whatever is already running on the server. This is what the
  // conversation-derived key buys: a chat left working when the browser was
  // closed — or open in another tab — is recognised as belonging to a
  // conversation we already know, rather than being an orphan process that
  // blocks the next `chat_start` on that key.
  //
  // Asked on every CONNECT, not once on load, and its answer REPLACES what is
  // here rather than adding to it. A backend restart is a reconnect in which
  // every one of those processes has gone: asked once, this page would go on
  // showing live dots for chats that no longer exist, and a chat cut off
  // mid-turn would spin forever waiting for an answer nothing is writing.
  // A `chat_start` racing the reply loses its dot until the next connect,
  // which is the same trade the waiting-cards effect below makes.
  useEffect(() => {
    if (conn !== "open") return;
    bridge
      .invoke<string[]>("chat_list")
      .then((keys) => {
        const ids = (keys ?? []).map(convOf).filter((id): id is string => !!id);
        setRunning(new Set(ids));
        setLiveKnown(true);
      })
      .catch(() => {});
  }, [conn]);

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

  /** Read whatever this page is missing of a chat's record, and fold it in.
   *
   *  `storedSeq` is how far the copy in this browser's storage runs — absent on
   *  a device that has never seen the chat, which is exactly when the whole
   *  conversation has to be replayed.
   *
   *  A replay that started at the very beginning REBUILDS the chat rather than
   *  adding to it. Live events fold into a chat this page does not hold, so
   *  that its working dot still moves in the sidebar, and what that leaves is a
   *  handful of newest events with a hole under them. Folding the record on top
   *  of that would show the conversation twice from there down.
   *
   *  One `patch` for the lot, not one per event: a long conversation is tens of
   *  thousands of events, and a state update each was the difference between
   *  opening and appearing to hang. */
  const catchUpChat = useCallback(
    (id: string, storedSeq?: number) => {
      const key = keyFor(id);
      const from = catchUp.current.begin(key, storedSeq);
      return bridge
        .invoke<{ seq: number; event: unknown }[]>("chat_since", { key, after: from })
        .then((run) => {
          const frames = catchUp.current.end(key, run ?? []);
          if (!frames.length) return;
          patch(id, (st) => {
            let next = from === 0 ? { ...emptyChat(), sessionId: st.sessionId } : st;
            for (const frame of frames) next = reduceChat(next, frame.event);
            return next;
          });
        })
        .catch((err: unknown) => {
          // The chat stays unheld, so the next open replays it in full rather
          // than trusting a mark that nothing filled in.
          catchUp.current.abandon(key);
          throw err;
        });
    },
    [patch],
  );

  // Reconnected: ask each live chat for everything that happened while we were
  // away. Without this, closing a laptop mid-answer loses the rest of it — the
  // agent finished perfectly well, we simply were not listening.
  //
  // Only chats this page HOLDS. One it does not is caught up when it is opened,
  // and reconnecting is no reason to pull a transcript nobody is reading —
  // on a phone that is megabytes per running chat, for a page that shows none
  // of it.
  useEffect(() => {
    if (conn !== "open") return;
    for (const id of runningRef.current) {
      if (!catchUp.current.holds(keyFor(id))) continue;
      catchUpChat(id).catch(() => {});
    }
    // running is read through the ref so a chat starting mid-reconnect does not
    // restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, catchUpChat]);

  useEffect(
    () =>
      bridge.on<{ key: string; seq?: number; event: unknown }>("chat-event", (payload) => {
        const id = payload && convOf(payload.key);
        if (!id) return;
        // What is safe to fold RIGHT NOW. Nothing, while a catch-up for this
        // chat is in the air — that catch-up is about to rebuild it, and would
        // wipe anything folded on top in the meantime.
        for (const frame of catchUp.current.live(payload.key, payload.seq, payload.event)) {
          patch(id, (s) => reduceChat(s, frame.event));
        }
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
              ? // Its background children die with it, so nothing is still
                // running — and a strip left counting a dead run would be the
                // same lie the other way round.
                { ...s, busy: false, background: [], exited: { code: payload.code } }
              : { ...s, notices: [...s.notices, payload.text].slice(-8) },
          );
        },
      ),
    [patch],
  );

  // The commands a session reports at startup, kept per PROJECT AND PROVIDER.
  // A provider owns its command syntax: Claude's `/compact` must not show up
  // after the same project is switched to Codex (or a future provider).
  const [commands, setCommands] = useState<CommandCache>(() => {
    try {
      return parseCommandCache(JSON.parse(localStorage.getItem(CMDS_KEY) || "{}"));
    } catch {
      return {};
    }
  });

  // The command list comes from the session's own startup announcement, and is
  // cached per provider from then on. It cannot be fetched ahead of time: the
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
        const agent = modelFromId(meta.current[id]?.modelId ?? null)?.agent;
        if (!pid || !agent || !s.commands?.length) continue;
        const before = prev[pid]?.[agent];
        if (before?.length === s.commands.length && before.every((command, i) => command === s.commands![i])) {
          continue;
        }
        next = { ...next, [pid]: { ...next[pid], [agent]: s.commands } };
      }
      if (next === prev) return prev;
      remember(CMDS_KEY, JSON.stringify(next));
      return next;
    });
  }, [chats]);

  // Save every loaded conversation as it grows, the background ones included:
  // an answer that arrived while you were elsewhere has to survive a reload the
  // same as one you watched. Storing on every delta would serialise the whole
  // transcript 60 times a second, so this waits for a quiet moment.
  useEffect(() => {
    const timer = setTimeout(() => {
      // A missing row does not always mean a chat nobody has saved yet. It
      // also means one the server has already deleted, which this page can
      // still be holding, open, from its cached copy: rebuilt from that, a
      // deleted chat came back with a new createdAt and a fresh entry in the
      // server's index, so deleting it never took.
      //
      // Chats counting down are skipped for the other half of that. Their rows
      // are still there, so nothing would be rebuilt — but the save also pushes
      // an index entry, and an entry written in the second before
      // `removeIndexEntry` is a race the delete can lose.
      const undoable = pendingDelete.current;
      setConversations((prev) => {
        let list = prev;
        let touched = false;
        const changedIds = new Set<string>();
        for (const [id, s] of Object.entries(chats)) {
          if (undoable.has(id) || gone.current.has(id)) continue;
          const info = meta.current[id];
          if (!info || s.messages.length === 0) continue;
          const before = list.find((c) => c.id === id);
          if (before && before.messages === s.messages) continue;
          // Everything the row already knew is CARRIED, and only what this
          // save actually recomputes is laid over it. Listing the carried
          // fields by hand is how `synced` went missing once and `room` went
          // missing again — see `rewriteConversation`.
          const next: Conversation = rewriteConversation(before, {
            ...(before ?? ({} as Conversation)),
            id,
            projectId: info.projectId,
            // The name it already has, and only otherwise one from the
            // messages — see `chatName`. Re-deriving it every save renamed a
            // chat after a partial view of itself.
            title: chatName(before?.title, s.messages),
            sessionId: s.sessionId ?? before?.sessionId,
            messages: s.messages,
            modelId: info.modelId,
            permission: info.access,
            // Set once, on the first save. Its whole job is to stay put — see
            // byProject in lib/store.ts.
            createdAt: before?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            // Only when this page holds the chat from the beginning. For one
            // it does not, its own mark is 0 — writing that would throw away a
            // perfectly good stored position and replay the lot next time.
            seq: catchUp.current.holds(keyFor(id))
              ? catchUp.current.mark(keyFor(id))
              : before?.seq,
          });
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
    // The label's slug, not the id: the id is a UUID that says nothing about
    // where the link goes. The raw id fills in only while the workspace list
    // has not arrived, so a reload does not blank the address.
    const ws = workspaces.find((w) => w.id === projectId);
    writeLocation(ws ? projectSlug(ws.name) : projectId, conversationId);
    // Said to the browser chrome too: the tab, the phone's top bar, and a
    // home-screen shortcut all name the page by its <title>, and with several
    // OctiqFlow tabs open a static one makes them indistinguishable. The raw
    // label rather than the slug — this line is read, not typed.
    document.title = ws ? `${ws.name} — OctiqFlow` : "OctiqFlow";
    // And in storage, because the URL is not always there to carry it. The app
    // is opened from a saved link and from a home-screen icon, and both are the
    // ORIGINAL address with no `#/p/…/c/…` on the end — so a reload from one of
    // those had nothing to say which chat you were in.
    // A store that will not take it is survivable here: the URL is still the
    // way back.
    if (conversationId) remember(LAST_KEY, conversationId);
  }, [projectId, conversationId, workspaces]);

  const project = useMemo(
    () => workspaces.find((w) => w.id === projectId) ?? null,
    [workspaces, projectId],
  );
  const grouped = useMemo(() => byProject(conversations), [conversations]);

  /** The chat on screen. Everything else is still running behind it. */
  const chat = (conversationId && chats[conversationId]) || EMPTY;
  /** The reader’s bookmarks live beside the stored transcript, not inside an
   * agent session. That makes them survive a reload without changing what the
   * agent itself remembers. */
  const conversationPins =
    (conversationId ? conversations.find((conversation) => conversation.id === conversationId) : undefined)
      ?.conversationPins ?? [];
  /** The newest plan this chat wrote down — see lib/todos. */
  const todos = useMemo(() => latestTodos(chat.messages), [chat.messages]);
  /** The files this chat says are worth opening — see lib/pins. Read once up
   *  here rather than twice below: the button needs the count and the panel
   *  needs the list, and walking the transcript for each of them would do the
   *  same work twice. */
  const sessionFiles = useSessionPins(
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
  /** A Task card knows the tool-use id that spawned its agent; the focus view
   * needs the task id. Keep that bridge here with the live agent roster. */
  const agentByTool = useMemo(() => {
    const runs = new Map<string, string>();
    for (const run of chat.agents) {
      if (run.toolUseId) runs.set(run.toolUseId, run.id);
    }
    return runs;
  }, [chat.agents]);

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

  /** Every chat under what it wants from you — see `lib/board`. Built only
   *  while the page is open: it walks every loaded transcript for its newest
   *  plan, and there is no reason to do that behind a page nobody is looking
   *  at. */
  const board = useMemo(
    () =>
      boardOpen
        ? buildBoard({ conversations, running, busy: busySet, asks, questions, chats })
        : null,
    [boardOpen, conversations, running, busySet, asks, questions, chats],
  );

  /** The calls whose background work is still running, for the cards. Memoised
   *  on the roster itself: it is a context value read by every card on screen,
   *  and a fresh Set on every render would re-render the whole transcript on
   *  every keystroke. */
  const runningCalls = useMemo(() => backgroundCalls(chat.background), [chat.background]);

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
    (forProject: string, settings?: { model: ModelChoice; access: AccessLevel }) => {
      const id = crypto.randomUUID();
      const next = settings ?? { model: choice, access };
      meta.current[id] = { projectId: forProject, modelId: next.model.id, access: next.access };
      setProjectId(forProject);
      setConversationId(id);
      setDrawer(false);
    },
    [choice.id, access],
  );

  /** A new chat someone ASKED for — the + in the top bar, the + on a project
   *  row. The same blank chat as `startBlank`, and then the box takes the
   *  focus, because pressing that button is someone saying they are about to
   *  write something.
   *
   *  The other callers of `startBlank` deliberately do not come through here.
   *  Landing in a blank chat because the project you opened had none, or
   *  because changing provider could not be done in the chat you were in, is
   *  the app arriving somewhere — not a person reaching for the keyboard.
   *
   *  A counter rather than a flag: two new chats in a row are two requests,
   *  and a boolean's second `true` is not a change for an effect to see. The
   *  number itself means nothing. */
  const [focusBox, setFocusBox] = useState(0);
  const newChat = useCallback(
    (forProject: string) => {
      startBlank(forProject);
      setFocusBox((n) => n + 1);
    },
    [startBlank],
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

      const sessionAccess = accessFor(session.agent, access);
      meta.current[id] = { projectId: forProject, modelId: model.id, access: sessionAccess };
      setChoice(model);
      setEffort(kept);
      setAccess(sessionAccess);
      remember(EFFORT_KEY, kept);
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
    const model = modelFromId(c.modelId ?? meta.current[c.id]?.modelId ?? null) ?? MODELS[0];
    const conversationAccess = accessFor(model.agent, (c.permission as AccessLevel) ?? "read");
    meta.current[c.id] = {
      projectId: c.projectId,
      modelId: model.id,
      access: conversationAccess,
    };
    // Seed the stored transcript unless this page already HOLDS the chat: one
    // that has been running in the background holds more than what was last
    // written to storage, and must not be rewound to it.
    //
    // "Already in `chats`" was the wrong test for that. A running chat's live
    // events fold into a page that holds nothing of it, so its working dot
    // moves in the sidebar (lib/catchUp), and what that leaves is the newest
    // few events with a HOLE under them. Read as "already loaded", the seed was
    // skipped — and the catch-up below starts from the STORED mark for a chat
    // this page does not hold, so it filled in only what came after it. The
    // conversation opened without its beginning, and the debounced save then
    // named it after what was left. Reloading with a chat still working was the
    // whole recipe.
    //
    // Replacing that preview loses nothing: `holds` is false for it, so the
    // catch-up re-asks from the stored mark and fetches those same events back.
    // Its session id is the exception — that came from the live process, and is
    // fresher than the one written down.
    setChats((prev) =>
      catchUp.current.holds(keyFor(c.id))
        ? prev
        : {
            ...prev,
            [c.id]: {
              ...emptyChat(),
              messages: c.messages,
              sessionId: prev[c.id]?.sessionId ?? c.sessionId,
            },
          },
    );

    // Fill in anything this device has not seen. On the device that held the
    // conversation that is the tail of an interrupted answer; on a device that
    // has never seen it, `seq` is absent and the whole thing is replayed.
    //
    // ...and when that replay is the WHOLE conversation, say so while it runs.
    // The chat list comes from the server and the messages do not, so a chat
    // held on another device opens with nothing in it — and a conversation with
    // no messages draws the page you START one from. Picking yesterday's work
    // out of the sidebar on a phone therefore looked exactly like a chat that
    // had been thrown away, for as long as the replay took.
    const blank = opensBlank(c, chatsRef.current[c.id]);
    if (blank) setReading((prev) => ({ ...prev, [c.id]: true }));
    catchUpChat(c.id, c.seq)
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
    if (c.modelId) setChoice(model);
    setAccess(conversationAccess);
    setDrawer(false);
  }, [catchUpChat]);

  /** This project's chats, in the order the sidebar lists them, which is the
   *  order a swipe walks. Ids only: the gesture is about which row comes next,
   *  and rebuilding this on every message would re-bind the listeners. */
  const siblings = useMemo(
    () => (projectId ? (grouped.get(projectId) ?? []).map((c) => c.id) : []),
    [grouped, projectId],
  );

  // Swipe the transcript sideways to move along them — left for the next chat
  // down the list, right for the one above, wrapping round at the ends. Held
  // back while the drawer is open, because there the same drag shuts it, and
  // while the editor is up, where there is no transcript under the finger.
  //
  // Read straight off this render rather than through refs: the hook keeps the
  // callback in one of its own and refreshes it every time, so what is closed
  // over here is always the chat currently on screen.
  useChatSwipe(pane, {
    enabled: mode === "chat" && !drawer && siblings.length > 1,
    onGo: (dir) => {
      const next = neighbour(siblings, conversationId, dir);
      const found = next && conversations.find((c) => c.id === next);
      if (found) openConversation(found);
    },
  });

  // The half that opens a chat a banner asked for lives further down, with the
  // panel closers it needs — see `showConversation`.

  // A banner the SERVICE WORKER raised. It cannot reach into the
  // page, so tapping one only brings the window forward and posts the chat it
  // came from; this is the half that opens it.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "open-chat" && typeof data.conversationId === "string") {
        onOpenChat.current(data.conversationId);
        // The worker writes the same tap down as well, for a page that is not
        // running to find later. This one WAS running, so take the copy out of
        // the way — otherwise coming back to the app in a few minutes' time
        // opens the chat all over again.
        void push.takeTapped();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // ...and the same tap arriving the other way. A message only reaches a page
  // that is running, which on a phone it usually is not — the app is suspended
  // behind whatever you were doing, and iOS will not let the worker raise it.
  // So the chat is also written down, and this picks it up: on the way in, and
  // every time the app comes back to the front, which is where a tap that
  // raised nothing at all finally lands.
  useEffect(() => {
    const pickUp = () => {
      if (document.hidden) return;
      void push.takeTapped().then((id) => {
        if (id) onOpenChat.current(id);
      });
    };
    pickUp();
    window.addEventListener("focus", pickUp);
    window.addEventListener("pageshow", pickUp);
    document.addEventListener("visibilitychange", pickUp);
    return () => {
      window.removeEventListener("focus", pickUp);
      window.removeEventListener("pageshow", pickUp);
      document.removeEventListener("visibilitychange", pickUp);
    };
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
    // A link names ONE chat and is the only reason this page is open; the
    // remembered one is where you happened to be last. The difference decides
    // what is on screen underneath — see below.
    const linked = opened.current.chat ?? null;
    const wanted = linked ?? last;
    if (!wanted) {
      restored.current = true;
      return;
    }
    // A link, or a remembered position, naming a chat this browser has deleted.
    // Both are just an id written down somewhere: the link outlives the chat,
    // and another tab can leave the remembered one behind after this one has
    // deleted it. Neither is a reason to go looking for it.
    if (isDeleted(wanted)) {
      restored.current = true;
      opened.current = {};
      return;
    }
    // Not here YET is not the same as gone: the server's list folds in a moment
    // after the cached one, so this waits rather than giving up.
    const found = conversations.find((c) => c.id === wanted);
    if (!found) return;
    restored.current = true;
    opened.current = {};
    // A tapped banner with nothing of ours open lands here, through the address
    // the worker built — so it gets the same treatment as a tap on a page that
    // was already running: the chat in front, not underneath the files view it
    // was left in. A reload restores what you left, view and all.
    if (linked) onOpenChat.current(wanted);
    else openConversation(found);
  }, [conversations, conversationId, openConversation]);

  /** Remember whether a side column is open. Split out because two of them do
   *  the same thing, and a flag that drifts from what is on screen is a panel
   *  that comes back closed. */
  const rememberFlag = (key: string, next: boolean) => remember(key, next ? "1" : "0");

  /** Put the project column away, or bring it back. Every way in and out goes
   *  through here so the stored flag cannot drift from what is on screen. */
  const showNav = useCallback((next: boolean) => {
    setNavShut(!next);
    rememberFlag(NAV_KEY, !next);
  }, []);

  /** Give the chat the whole body without changing browser fullscreen. */
  const toggleChatWidth = useCallback(() => {
    // A drawer over the transcript defeats the point of widening it. Its
    // previous open/closed preference is not changed; this only puts it away
    // for the focused view.
    setDrawer(false);
    setChatWide((was) => !was);
  }, []);

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
      rememberFlag(FILES_KEY, false);
    }
    rememberFlag(GIT_KEY, next);
  }, []);

  /** The same, for the files column. */
  const showFiles = useCallback((next: boolean) => {
    setFilesOpen(next);
    if (next) {
      setFilesMounted(true);
      setGitOpen(false);
      rememberFlag(GIT_KEY, false);
    }
    rememberFlag(FILES_KEY, next);
  }, []);

  /** The agent column. Unlike the two above it takes no width from a panel and
   *  closes none of them: it is narrow, it is about the chat rather than the
   *  code, and a chat that starts an agent while you are reading a diff should
   *  not throw the diff away. */
  const showRail = useCallback((next: boolean) => {
    setRailShut(!next);
    rememberFlag(RAIL_KEY, !next);
  }, []);

  /** Put the git column away where leaving it up would be in the way — and
   *  only there. Below the drawer breakpoint it is a sheet ON the chat, so
   *  switching project or opening a conversation has to close it or the thing
   *  you asked for lands underneath it. On a desktop it is a column BESIDE the
   *  chat which repoints itself at whatever project is now showing, so closing
   *  it would only leave a column to open again — and, worse, remember the
   *  closing as a preference nobody expressed. */
  const dismissGit = useCallback(() => {
    if (!desktopGit) showGit(false);
  }, [desktopGit, showGit]);

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

  /** Switching project puts the whole right-hand column away: the git panel,
   *  the files panel, and any file open in either window.
   *
   *  All three are about the project you just left — its branch, the files its
   *  chat touched, one of its files. Left up, they sit beside the new project's
   *  chat looking like they belong to it, and a diff read as the wrong repo's
   *  is worse than no diff at all.
   *
   *  Keyed on the project rather than hung off the sidebar's click, so every
   *  way in is covered: picking a conversation out of another project's folder
   *  switches project too. The FIRST project of a visit is not a switch, which
   *  is what the ref is for — a panel reopened from storage on arrival stays
   *  open.
   *
   *  The desktop git column is the exception — see `dismissGit`: it is a column
   *  of the workspace rather than something over the chat, and it reads the new
   *  project's repos the moment the folders under it change. */
  const closeFile = useCloseFile();
  const wasProject = useRef<string | null>(null);
  useEffect(() => {
    const before = wasProject.current;
    wasProject.current = projectId;
    if (!before || before === projectId) return;
    dismissGit();
    showFiles(false);
    closeFile();
  }, [projectId, dismissGit, showFiles, closeFile]);

  /** Open a conversation AND put it in front of you, whatever was over it.
   *
   *  What a tapped banner means, and it is more than `openConversation`: that
   *  one changes which chat the chat view is showing, and on a phone the chat
   *  view is routinely not what is on screen. The files view covers it whole,
   *  and the git and files sheets are full-screen there and are REMEMBERED
   *  between visits, so the odds of one being up are good. Opening the chat
   *  underneath any of them looks exactly like a tap that did nothing — on the
   *  one notification whose whole job was to take you somewhere. */
  const showConversation = useCallback(
    (c: Conversation) => {
      openConversation(c);
      pickMode("chat");
      dismissGit();
      showFiles(false);
      closeFile();
    },
    [openConversation, pickMode, dismissGit, showFiles, closeFile],
  );

  // Tapping a notification brings the window forward — this is what then puts
  // the chat it came from on screen, so the banner lands you on the thing it
  // was about rather than wherever you left off.
  onOpenChat.current = (id) => {
    const found = notifying.current.list.find((c) => c.id === id);
    if (found) showConversation(found);
    else awaited.current = id;
  };

  // ...and this is that tap arriving before the list it needs. See `awaited`.
  useEffect(() => {
    const id = awaited.current;
    if (!id) return;
    const found = conversations.find((c) => c.id === id);
    if (!found) return;
    awaited.current = null;
    showConversation(found);
  }, [conversations, showConversation]);

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

  /** The chats deleted a moment ago, and the way back to each of them.
   *
   *  Deleting used to ask first, in a dialog in the middle of the screen. The
   *  × that opens it is in the sidebar, so the pointer crossed the window to
   *  answer a question it answered "yes" to every time — which is not a
   *  question, it is a second click. The delete now starts on the first click
   *  and the second one is only asked for when the first was a mistake.
   *
   *  Where that second click goes is the point: the row stays put and its ×
   *  becomes a ring emptying over two seconds, so taking a delete back is
   *  pressing the same pixel again rather than crossing the window to a bar in
   *  the corner. Nothing else on screen moves, and nothing behind it is
   *  blocked — the agents keep streaming, and the delete only reaches the
   *  server once the ring has run out. Several rows can be counting at once,
   *  each on its own clock; see `PendingDeletes`. */
  const pendingDelete = useRef<PendingDeletes>(new Map());
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(NONE_DELETING);
  const pendingRemoval = useRef<PendingRemovals>(new Map());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NONE_LEAVING);

  /** Take one row off the countdown — its clock and its ring both — and say
   *  whether there was one to take off. Both ways out of a countdown end here,
   *  going through and going back, so neither can act on a chat the other has
   *  already dealt with. */
  const stopCountdown = useCallback((id: string) => {
    const timer = pendingDelete.current.get(id);
    if (timer === undefined) return false;
    pendingDelete.current.delete(id);
    clearTimeout(timer);
    setDeleting((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next.size ? next : NONE_DELETING;
    });
    return true;
  }, []);

  /** Remove the row only after CSS has had time to collapse its height. This is
   *  deliberately separate from `commitDelete`: by then the chat is already
   *  deleted everywhere that matters, and this is just the last visual frame. */
  const finishLeaving = useCallback((id: string) => {
    const timer = pendingRemoval.current.get(id);
    if (timer !== undefined) {
      pendingRemoval.current.delete(id);
      clearTimeout(timer);
    }
    if (!leavingRef.current.delete(id)) return;
    setLeaving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next.size ? next : NONE_LEAVING;
    });
    setConversations((prev) => {
      if (!prev.some((c) => c.id === id)) return prev;
      const list = prev.filter((c) => c.id !== id);
      saveConversations(list);
      return list;
    });
  }, []);

  /** Let one pending delete through. THIS is where the chat actually goes. */
  const commitDelete = useCallback(
    (id: string) => {
      // Only ever once per chat: the timer can fire on a row the tab-closing
      // flush has already committed, and everything below this line is a
      // message to the server about a chat that is no longer there.
      if (!stopCountdown(id)) return;

      // Deleting the transcript with the agent still working on it would leave
      // a process nobody can reach, so it goes too.
      endSession(id);
      // Written down before anything is sent anywhere. From this moment the
      // chat is deleted as far as this browser is concerned, whatever the
      // server does with the message — and that survives the reload, which is
      // what stops a cached row and a stale index entry from handing the chat
      // back tomorrow.
      markDeleted(id, keyFor(id));
      // The record on the server goes as well — the point of deleting a chat is
      // that it is gone, not that it is hidden on this device. Through
      // `removeIndexEntry`, which supersedes any unsent save for this chat and
      // keeps trying: a removal sent once and forgotten is a delete that can
      // quietly not happen.
      //
      // The local record stays in the list for one last visual beat. The ref
      // is set before the server can answer, so that answer cannot unmount the
      // row before its height has had a chance to animate to zero.
      leavingRef.current.add(id);
      setLeaving((prev) => new Set(prev).add(id));
      // Drop the transcript and remember the tombstone now, not after the
      // animation. The row is only lingering for layout; the chat is already
      // gone as far as saves and a reload are concerned.
      forgetLocally(id);
      removeIndexEntry(id, keyFor(id));
      // The room goes with the chat. Everyone in it is ended and the record
      // dropped; leaving it would hold a room, and every process in it, for the
      // life of the server on behalf of a conversation that no longer exists.
      bridge.invoke("chat_forget_room", { key: keyFor(id) }).catch(() => {});

      // Motion-reduced users get the settled result immediately. Everyone else
      // sees the row fold itself out, carrying the chats below it rather than
      // making them jump to their new positions.
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        finishLeaving(id);
      } else {
        pendingRemoval.current.set(
          id,
          setTimeout(() => finishLeaving(id), DELETE_COLLAPSE_MS),
        );
      }
    },
    [stopCountdown, endSession, forgetLocally, finishLeaving],
  );

  /** Let a pending delete go without doing it. Nothing to put back: the row
   *  never left, and neither did the transcript, the session, or the agent
   *  still mid-answer if it was working when the × was pressed. */
  const cancelDelete = useCallback(
    (id: string) => {
      stopCountdown(id);
    },
    [stopCountdown],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      // Pressed again on the row already counting down: that is the way back.
      // The ring the second press lands on is the same × that started it, so
      // this is the whole of Undo.
      if (pendingDelete.current.has(id)) {
        cancelDelete(id);
        return;
      }
      // A settled delete is already collapsing its row. It no longer has an
      // Undo action, and a late click cannot start a second countdown for it.
      if (leavingRef.current.has(id)) return;
      if (!conversations.some((c) => c.id === id)) return;

      // Nothing happens here but the ring, and it is this row's ring alone.
      // Clearing several chats is several presses in a row, and each one keeps
      // the seconds it was promised: a press on the row below is not an opinion
      // about the one above it. Everything the chat is made of — the row
      // included — is left alone until its own timer runs out; see
      // `commitDelete`.
      pendingDelete.current.set(
        id,
        setTimeout(() => commitDelete(id), UNDO_MS),
      );
      setDeleting((prev) => new Set(prev).add(id));
    },
    [cancelDelete, commitDelete, conversations],
  );

  // Closing the tab inside those seconds must not quietly forget the delete.
  // Nothing has been sent yet at that point — the transcript, the index entry
  // and the room are all still there — so a delete left half done is a delete
  // that never happened, and the chat is back in the sidebar on the next
  // visit. Held in a ref so the listener is installed once and still calls the
  // current one.
  // Every row counting down, not just the last one pressed — over the copy,
  // since committing one takes it out of the map being walked.
  const commitRef = useRef(commitDelete);
  commitRef.current = commitDelete;
  useEffect(() => {
    const flush = () => {
      for (const id of [...pendingDelete.current.keys()]) commitRef.current(id);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  // A page can leave while a committed row is mid-collapse. The tombstone was
  // already saved, so there is nothing to finish after unmounting; clearing
  // the short timers just prevents a stale state update on a closed page.
  useEffect(
    () => () => {
      for (const timer of pendingRemoval.current.values()) clearTimeout(timer);
      pendingRemoval.current.clear();
    },
    [],
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
          bridge.invoke("chat_send", { key, text, recordUser: false }).catch(() => undefined);
        }
        bridge.invoke("chat_forget", { key }).catch(() => undefined);
        // Held again, from nothing: `transcript::forget` drops the server's
        // counter to zero, and a page still holding the old high number would
        // discard every event after this as one it had already seen.
        catchUp.current.own(key);
        patch(id, (s) => ({ ...emptyChat(), sessionId: s.sessionId }));
        // The saved copy has to be emptied here rather than left to the sync
        // effect, which skips any chat with no messages — that guard is what
        // stops a brand-new chat being saved, and it also meant a cleared one
        // kept its old messages on disk and got them all back on reload.
        setConversations((prev) => {
          const list = prev.map((c) =>
            c.id === id
              ? { ...c, messages: [], seq: 0, conversationPins: [], updatedAt: Date.now() }
              : c,
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
      // Card 85 — who this one is for, read off the message itself and resolved
      // BEFORE anything is sent, so the bubble and the wire agree.
      //
      // Read AFTER the file list is appended, which is safe and deliberate: the
      // tag is at the START, so appending to the end cannot disturb it, and the
      // files stay attached to the message the seat actually receives.
      const addressed = readMention(text, mySeats);

      // A name that is nobody. Refused rather than quietly answered by the host:
      // the message was plainly meant for someone, and answering it here is the
      // one outcome where nobody ever finds out it went to the wrong place.
      if (addressed.kind === "unknown") {
        patch(id, (s) => ({
          ...s,
          notices: [
            ...s.notices,
            `Nobody here is called "${addressed.tag}". In this chat: ${
              mySeats.map((x) => `@${x.name}`).join(", ") || "nobody yet"
            }, or @all.`,
          ],
        }));
        return;
      }

      // Card 86 — `@all` puts THIS message to every seat in turn.
      //
      // Not the same as the "Ask the room" button, which puts your LAST message
      // to everyone: that button has no words of its own, so inventing a
      // question would put words in your mouth. This one has words — the ones
      // after the tag.
      if (addressed.kind === "all") {
        if (mySeats.length === 0) {
          patch(id, (s) => ({
            ...s,
            notices: [...s.notices, "Nobody else is in this chat yet, so @all has nobody to ask."],
          }));
          return;
        }
        patch(id, (s) => addUserTurn(s, text));
        try {
          await bridge.invoke("chat_round", {
            key: keyFor(id),
            order: mySeats.map((x) => x.id),
            text: addressed.text,
            cwd: project.primary_path ?? "",
            extraDirs: project.paths ?? [],
            access,
            effort,
          });
        } catch (err) {
          patch(id, (s) => ({ ...s, notices: [...s.notices, String((err as Error).message ?? err)] }));
        }
        return;
      }

      const seat =
        addressed.kind === "seat" ? mySeats.find((s) => s.id === addressed.seatId) ?? null : null;
      // What the agent is actually sent: the tag is a decision about routing,
      // not part of the question, so a seat is asked what you asked rather than
      // being told its own name first.
      text = addressed.text;
      const turnId = userTurnId();
      patch(id, (s) =>
        addUserTurn(
          s,
          text,
          attachments.map((a) => ({ path: a.path, name: a.name, isImage: !!a.isImage })),
          undefined,
          seat ? { id: seat.id, name: seat.name } : undefined,
          turnId,
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
          await bridge.invoke("chat_send", { key: keyFor(id), text, images, to: seat.id, turnId });
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
              turnId,
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
          await bridge.invoke("chat_send", { key: keyFor(id), text, images, turnId });
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

      // Speaking into a chat whose record this page does not hold. A brand-new
      // one has no record to hold, so it is simply ours from here. Anything
      // else — a chat opened while the replay failed, a session picked out of
      // history — is read first, or this turn's events would fold onto a
      // conversation with a hole where its past belongs.
      if (!catchUp.current.holds(keyFor(id))) {
        if (resume) await catchUpChat(id, conversations.find((c) => c.id === id)?.seq).catch(() => {});
        else catchUp.current.own(keyFor(id));
      }

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
          turnId,
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
            await bridge.invoke("chat_send", { key: keyFor(id), text, images, turnId });
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
    [
      project,
      choice,
      access,
      effort,
      lite,
      conversationId,
      chats,
      conversations,
      patch,
      catchUpChat,
    ],
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
      const turnId = userTurnId();
      // Show it in the transcript. It IS a turn — the agent answers it — and a
      // setting that changed with no trace is a setting you cannot trust.
      patch(conversationId, (st) => addUserTurn(st, command, [], undefined, undefined, turnId));
      bridge
        .invoke("chat_send", { key: keyFor(conversationId), text: command, turnId })
        .catch(() => {});
      return true;
    },
    [conversationId, patch],
  );

  const changeModel = useCallback(
    (c: ModelChoice) => {
      const previous = choice;
      const changingProvider = c.agent !== previous.agent;
      const nextAccess = accessFor(c.agent, access);
      setChoice(c);
      remember(CHOICE_KEY, c.id);
      if (nextAccess !== access) {
        setAccess(nextAccess);
        remember(ACCESS_KEY, nextAccess);
      }
      // The two providers do not offer the same effort levels, so carry the
      // choice across only when it exists over there.
      const kept = effortFor(c.agent, effort);
      if (kept !== effort) {
        setEffort(kept);
        remember(EFFORT_KEY, kept);
      }
      if (conversationId && meta.current[conversationId] && !changingProvider) {
        meta.current[conversationId].modelId = c.id;
      }

      // An untouched chat simply starts with the new choice.
      if (chat.messages.length === 0) return;

      // Changing PROVIDER cannot be done in place at any price: a Claude
      // session id means nothing to Codex, and the two are different programs.
      if (changingProvider) {
        if (project) startBlank(project.id, { model: c, access: nextAccess });
        return;
      }

      // Same provider, mid-conversation. Its adapter may have a native setting
      // command that keeps everything said so far. `Default` has no name to
      // pass, so that one still needs a fresh chat.
      const liveCommand = liveSettingCommand(c.agent, "model", c.flag);
      if (liveCommand && tellSession(liveCommand)) return;

      // Nothing running: the next message respawns the agent, and it will carry
      // the new --model with --resume, so the conversation survives anyway.
      if (!runningRef.current.has(conversationId ?? "")) return;

      if (project) startBlank(project.id, { model: c, access: nextAccess });
    },
    [chat.messages.length, project, startBlank, effort, access, choice, conversationId, tellSession],
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
      const first = providerFor(agent).models[0];
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
      // Through `remember`, and not `localStorage.setItem`. A full store used
      // to throw HERE — before the two lines below, which are the ones that
      // actually change anything — so the level moved on screen, never reached
      // the agent, and was back to the old word after a reload. See
      // `lib/remember`.
      remember(EFFORT_KEY, e);
      const liveCommand = liveSettingCommand(choice.agent, "effort", e);
      if (liveCommand && tellSession(liveCommand)) return;
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
    return providerAccessLabel(agent, level);
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

  /** Asked for outright: end this chat's agent and keep the conversation.
   *
   *  An agent reads its MCP servers, its plugins and the tool list they add up
   *  to ONCE, when the process spawns. Add a server or enable a plugin while a
   *  chat is open and that chat never sees it — the only way in is a new
   *  process. Until this button the only way to get one was to leave the chat
   *  alone for fifteen minutes and let the idle sweeper do it.
   *
   *  Which is all this is: the sweeper's ending, on purpose and now. Nothing is
   *  thrown away, because nothing here throws anything away — the transcript is
   *  already on disk and the send path starts a chat it has no process for with
   *  `resume`. A turn in flight IS lost, so the notice says the process ended
   *  rather than leaving a chat that went quiet for no visible reason.
   *
   *  `chat_restart`, not `chat_stop`, and the difference is not cosmetic:
   *  stopping drops the standing permissions the person granted this piece of
   *  work, and ends the host of a room WITHOUT its seats — leaving them running
   *  against nobody, holding half a gigabyte each until the server goes. The
   *  fallback is for the gap this repo's two-speed deploy opens: `web/dist` is
   *  read off disk, so this page can reach a browser before the binary that
   *  knows the command does. Stopping is worse on both counts and still better
   *  than a button that does nothing. */
  const restartAgent = useCallback(() => {
    const id = conversationId;
    if (!id) return;
    bridge.invoke("chat_restart", { key: keyFor(id) }).catch(() => endSession(id));
    setRunning((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    patch(id, (s) => ({
      ...s,
      notices: [
        ...s.notices,
        "Agent stopped. The conversation is kept — say anything to start a fresh one, " +
          "with whatever MCP servers and plugins it can see now.",
      ].slice(-8),
    }));
  }, [conversationId, endSession, patch]);

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
  // Card 66 — who is in this chat. Card 82 — and that is the whole question.
  //
  // There is no stored mode any more. A chat is a group when somebody else is
  // sitting in it, so the seat list is both the roster and the answer to "is
  // this a group" — one fact, in one place, which is what stops the two
  // disagreeing after a reload or a restart.
  const [seats, setSeats] = useState<Record<string, Seat[]>>({});
  const mySeats = (conversationId && seats[conversationId]) || [];
  const room = mySeats.length > 0;
  // Card 84 — the number at the top. Null in an ordinary chat, which is what
  // keeps this off every chat in the app.
  const seatCount = roomCount(mySeats.length);
  // Card 85 — there is no longer any "who the next message is for" STATE. It
  // was a mode: pick a seat and every message went there until you remembered
  // to change it back, and a removed seat left a target the backend no longer
  // knew. The tag is read off each message instead, so there is nothing to
  // leave switched on and nothing to go stale.

  /** Ask the backend who is in this room.
   *
   *  Card 82 deleted the other half of this. It used to reconcile the browser's
   *  stored mode against the backend's, because each could be ahead of the other
   *  and both happened in practice. With the mode gone there is nothing to
   *  reconcile: the seat list is the only answer, and it comes from here. */
  const refreshSeats = useCallback(async (id: string) => {
    try {
      const view = (await bridge.invoke("chat_room", { key: keyFor(id) })) as RoomView;
      setSeats((prev) => ({ ...prev, [id]: view.seats }));
    } catch {
      // A backend that cannot answer leaves the list alone rather than
      // emptying it — an empty rail would read as "everyone left".
    }
  }, []);

  // Who is in the chat now on screen.
  //
  // The seat list is the BACKEND's — nothing about a room is stored in this
  // browser (card 82), so opening a chat means asking. Without this, a chat that
  // already had seats in it would open looking like an ordinary one until
  // something else happened to ask.
  useEffect(() => {
    if (!conversationId) return;
    void refreshSeats(conversationId);
  }, [conversationId, refreshSeats]);

  const addSeat = useCallback(
    async (want: { label: string; agent: "claude" | "codex"; kind?: "on_demand"; provider?: string; context?: "room_only" }) => {
      if (!conversationId) return;
      const id = conversationId;
      try {
        // Card 82 — nothing to open first. This call IS what makes the chat a
        // room, and the backend creates the room around the seat.
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

  /** The chat on screen says it is working, and nobody is working on it.
   *
   *  Which means the backend stopped mid-answer: a restart kills every agent it
   *  owns where it stands, so no full stop was ever written and the turn is
   *  still open in the record. Everything said survives, and so does the
   *  agent's own memory of it — see lib/carryOn.
   *
   *  "Nobody" is the word that has to be read carefully: a room's work is done
   *  by processes that are not the room's own — see `someoneWorking`. */
  const stalled = wasCutOff({
    busy: chat.busy,
    live:
      !!conversationId &&
      someoneWorking({ id: conversationId, running, round: !!myRound?.running }),
    known: liveKnown,
  });

  // ...and it has stayed that way for a moment. A HANDOVER is not a stop: when
  // a seat finishes, the backend starts the host to tell it what was said
  // (`round::ask_host`), and starting an agent takes seconds — seconds in which
  // nothing at all is running on this chat. Drawn the instant that gap opened,
  // the notice accused the backend of stopping every time an agent finished.
  //
  // Only a room waits. A chat with no seats has no handover to sit through, and
  // a turn the backend really did cut off is on screen the moment it is known.
  const [settledFor, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!stalled || !conversationId) {
      setSettled(null);
      return;
    }
    const wait = setTimeout(() => setSettled(conversationId), room ? HANDOVER_MS : 0);
    return () => clearTimeout(wait);
  }, [stalled, conversationId, room]);
  const cutOff = stalled && settledFor === conversationId;

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

  // The host has been told what the other agents in its room said, and is
  // answering it now. The BACKEND asked it — this is only the news, which is
  // why nothing here sends anything: every open tab hears this, and a tab that
  // acted on it would ask the host the same thing again.
  //
  // The turn goes on screen because a host that suddenly speaks with nothing
  // above it reads as an agent talking to itself. It is drawn as one line
  // rather than as its words — the brief quotes the answers already sitting
  // above it — see lib/relay.
  useEffect(
    () =>
      bridge.on<{ key: string; text: string }>("chat-followup", (payload) => {
        const id = payload && convOf(payload.key);
        if (!id || !payload.text) return;
        // Started by the backend if it had to be, so this browser may never
        // have heard the process come up. Without this the live mark stays off
        // for a chat that is plainly working.
        setRunning((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        patch(id, (st) => addUserTurn(st, payload.text));
      }),
    [patch],
  );

  const changeAccess = useCallback(
    (p: AccessLevel) => {
      setAccess(p);
      // `remember`, for the same reason `changeEffort` uses it: everything that
      // matters happens BELOW this line, and a store at its quota used to throw
      // here and take the rest of the function with it.
      remember(ACCESS_KEY, p);
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

  /** Save a selected passage against this chat. A response can be visible a
   * beat before the normal transcript save creates its sidebar row, so this
   * also knows how to create that first local record instead of making an early
   * Pin click disappear. */
  const pinConversation = useCallback(
    (pin: ConversationPin) => {
      const id = conversationId;
      if (!id) return;
      const duplicate = conversationPins.find(
        (held) => held.turnId === pin.turnId && held.text === pin.text,
      );
      setActivePinId(duplicate?.id ?? pin.id);
      setConversations((prev) => {
        const existing = prev.find((conversation) => conversation.id === id);
        if (existing) {
          const before = existing.conversationPins ?? [];
          const pins = appendConversationPin(before, pin);
          if (pins.length === before.length) return prev;
          const list = prev.map((conversation) =>
            conversation.id === id
              ? { ...conversation, conversationPins: pins, updatedAt: Date.now() }
              : conversation,
          );
          saveConversations(list);
          return list;
        }

        const info = meta.current[id];
        const projectIdForPin = info?.projectId ?? project?.id;
        if (!projectIdForPin) return prev;
        const now = Date.now();
        const created: Conversation = {
          id,
          projectId: projectIdForPin,
          title: chatName(undefined, chat.messages),
          sessionId: chat.sessionId,
          // A new array is intentional: the ordinary transcript save still
          // has to see a fresh record and publish its index entry after this
          // early pin created the browser copy.
          messages: [...chat.messages],
          modelId: info?.modelId ?? choice.id,
          permission: info?.access ?? access,
          createdAt: now,
          updatedAt: now,
          conversationPins: [pin],
        };
        const list = [created, ...prev];
        saveConversations(list);
        return list;
      });
    },
    [conversationId, project?.id, chat.messages, chat.sessionId, choice.id, access, conversationPins],
  );

  /** The sidebar labels are switches: take the reader to the full turn that
   * gave the passage its context, without opening another panel over it. */
  const pickConversationPin = useCallback((pin: ConversationPin) => {
    setActivePinId(pin.id);
    // In the phone drawer the returned-to turn is otherwise hidden directly
    // behind the label just pressed. On a wide screen this is already false,
    // so the same line is a no-op there.
    setDrawer(false);
    setPinJump((before) => ({
      id: pin.id,
      turnId: pin.turnId,
      nonce: (before?.nonce ?? 0) + 1,
    }));
  }, []);

  const removeConversationPin = useCallback(
    (pinId: string) => {
      const id = conversationId;
      if (!id) return;
      setActivePinId((active) => (active === pinId ? null : active));
      setPinJump((jump) => (jump?.id === pinId ? null : jump));
      setConversations((prev) => {
        const existing = prev.find((conversation) => conversation.id === id);
        if (!existing?.conversationPins?.some((pin) => pin.id === pinId)) return prev;
        const list = prev.map((conversation) =>
          conversation.id === id
            ? {
                ...conversation,
                conversationPins: conversation.conversationPins?.filter((pin) => pin.id !== pinId),
                updatedAt: Date.now(),
              }
            : conversation,
        );
        saveConversations(list);
        return list;
      });
    },
    [conversationId],
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
    <div
      className={`app ${drawer ? "drawer-open" : ""} ${navShut ? "nav-shut" : ""} ${chatExpanded ? "chat-wide" : ""}`}
      ref={shell}
    >
      {conn !== "open" && (
        <div className="conn-strip">
          {conn === "connecting" ? "Connecting to OctiqFlow…" : "Reconnecting…"}
        </div>
      )}

      <header className="topbar">
        <div className="topbar-leading">
          {/* The project name is also the way back to the project list. The
              same control opens the drawer below desktop and restores the
              project column above it. */}
          <button
            className="topbar-title"
            type="button"
            aria-label="Projects and chats"
            aria-expanded={chatExpanded ? false : hasDrawer ? drawer : !navShut}
            onClick={() => {
              if (chatExpanded) return;
              if (hasDrawer) setDrawer((v) => !v);
              else showNav(true);
            }}
            disabled={chatExpanded || (!hasDrawer && !navShut)}
          >
            <span className="topbar-name">{project?.name ?? "OctiqFlow"}</span>
            <span className="topbar-caret" aria-hidden="true">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </button>
        </div>

        {/* A dedicated middle slot keeps the view switch centred instead of
            letting the changing number of actions on the right push it. */}
        <div className="topbar-center">{wide && viewSwitch}</div>

        <div className="topbar-actions">
          {/* A read-only room count. Membership is still managed only from the
              composer, beside the conversation it changes. */}
          {seatCount && (
            <span className="topbar-room" title={seatCount.label} aria-label={seatCount.label}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="9" cy="8" r="3.2" />
                <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
                <path d="M16 5.6a3.2 3.2 0 0 1 0 4.8M18.4 19a5.6 5.6 0 0 0-2.4-4.6" />
              </svg>
              <RollingNumber value={seatCount.total} />
            </span>
          )}

          <RailButton
            count={chat.agents.length}
            open={!railShut}
            onToggle={() => showRail(railShut)}
          />

          <FilesButton
            count={sessionFiles.length}
            open={filesOpen}
            onToggle={() => showFiles(!filesOpen)}
          />

          {/* The way in and out of the changes column at every width, and the
              only way back once its ✕ has put it away. What it opens differs by
              layout — the workspace's third column on a desktop, a sheet over
              the chat on a phone — but which button does it never does. */}
          <GitButton project={project} open={gitOpen} onToggle={() => showGit(!gitOpen)} />

          {/* Full-width chat remains available in the intermediate drawer
              layout, where the columns it sweeps away are the ones with no room
              to spare. A desktop puts each of them away by its own control. */}
          {wide && hasDrawer && mode === "chat" && (
            <FullscreenButton expanded={chatExpanded} onToggle={toggleChatWidth} />
          )}

          <button
            className="icon-btn"
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setAppSettings(true)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          {project && (
            <button
              className="icon-btn new-chat"
              type="button"
              aria-label={`New chat in ${project.name}`}
              title="New chat"
              onClick={() => newChat(project.id)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}

          {/* Rendered once: the meter polls a rate-limited endpoint, so on a
              smaller screen this same instance moves into the drawer. */}
          {wide && <Usage />}
        </div>
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
          onShowBoard={() => setBoardOpen(true)}
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
          deleting={deleting}
          leaving={leaving}
          deleteMs={UNDO_MS}
          expanded={expanded}
          onToggle={toggleFolder}
          onPickProject={pickProject}
          onPickConversation={openConversation}
          onNewChat={newChat}
          onDelete={deleteConversation}
          onSettings={setSettingsFor}
          onNewProject={() => setSettingsFor("new")}
          pins={conversationPins}
          activePinId={activePinId}
          onPickPin={pickConversationPin}
          onRemovePin={removeConversationPin}
          onHide={hasDrawer ? undefined : () => showNav(false)}
          head={wide ? undefined : viewSwitch}
          foot={wide ? undefined : <Usage />}
        />

        <main className="main" hidden={mode !== "chat"} ref={pane}>
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
                    {providerFor(resumed[conversationId].agent).name}
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
                {/* Which cards are still waiting on work they started. Read
                    four levels down, past a grouping pass that rebuilds its
                    rows — see components/Background. */}
                <BackgroundProvider value={runningCalls}>
                  <div className="chat-main">
                    <MessageList
                      messages={chat.messages}
                      // Not `chat.busy`: a turn nothing is working on any more
                      // is over, whatever the record says. The strip above the
                      // prompt box is what says so.
                      busy={chat.busy && !cutOff}
                      stoppedAt={chat.stoppedAt}
                      compactingSince={chat.compactingSince}
                      conversationId={conversationId ?? undefined}
                      // What the host's replies are signed with. `choice` is
                      // this conversation's own provider, not a stale global:
                      // opening a chat sets it from the stored model, resuming
                      // sets it from the session, and changing provider cannot
                      // happen in place — it opens a new chat.
                      hostName={providerFor(choice.agent).name}
                      // How the `/config` panel changes a setting: the very
                      // line you would have typed, sent the way you would have
                      // sent it — so the CLI's own answer lands under it and
                      // the transcript still reads as a conversation.
                      //
                      // `send`, not `tellSession`: a chat whose agent was
                      // reaped for being idle has no process to write to, and
                      // `tellSession` would quietly do nothing. `send` picks
                      // the session back up first, which is what a tap on a
                      // setting has every right to expect.
                      onSetting={send}
                      agentByTool={agentByTool}
                      onOpenAgent={setFocusedAgent}
                      onPin={pinConversation}
                      jumpToPin={pinJump ?? undefined}
                    />
                    {focused && (
                      <AgentFocus
                        run={focused}
                        messages={chat.messages}
                        onBack={() => setFocusedAgent(null)}
                      />
                    )}
                  </div>
                </BackgroundProvider>
              </PathCwdProvider>
            </div>
          )}

          {chat.failure && conversationId && (
            <div className={`failure ${chat.failure.outOfCredit ? "is-quota" : ""}`} role="alert">
              {/* Read, and now done with. Speaking again clears it too, but the
                  failure people actually sit with is a quota one — where the
                  answer is to WAIT, and asking again just puts the same banner
                  back. Without this the only way past it was to leave the
                  chat. */}
              <button
                className="failure-close"
                type="button"
                aria-label="Dismiss"
                onClick={() => patch(conversationId, (s) => ({ ...s, failure: undefined }))}
              >
                ×
              </button>
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

          {conversationId && chat.notices.length > 0 && (
            <div className="notices">
              <button
                className="notices-dismiss"
                type="button"
                onClick={() => patch(conversationId, (s) => ({ ...s, notices: [] }))}
              >
                Dismiss all
              </button>
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

          {/* A whole batch as ONE card. Every question is open at once, so the
              person can compare related decisions before using the one Submit
              that sends the complete set together. */}
          {(() => {
            const pending = conversationId ? questions[conversationId] ?? [] : [];
            if (pending.length === 0) return null;
            return (
              <UserQuestion
                // Keyed on the FIRST question, not the whole list. Keying on
                // the list meant a question arriving mid-batch changed the key,
                // remounting the card and throwing away the answers already
                // given. The first id is stable until
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
                remember(TERM_KEY, "0");
              }}
            />
          )}

          {/* Only ever after a restart or a crash: the chat is holding a turn
              open that nothing is answering. */}
          {cutOff && <CarryOn onCarryOn={() => void send(CARRY_ON)} />}

          <Composer
            session={conversationId ?? undefined}
            focusOn={focusBox}
            todos={todos}
            choice={choice}
            onChoice={changeModel}
            started={chat.messages.length > 0}
            access={access}
            onAccess={changeAccess}
            onSend={send}
            onStop={stop}
            busy={chat.busy && !cutOff}
            disabled={!project}
            installed={installed}
            commands={providerCommands(choice.agent, (projectId && commands[projectId]?.[choice.agent]) || [])}
            contextTokens={chat.contextTokens}
            contextWindow={chat.contextWindow}
            activity={chat.activity}
            turnStartedAt={chat.turnStartedAt}
            turnTokens={turnOutput(chat)}
            turnApprox={turnOutputApprox(chat)}
            thinking={isThinking(chat)}
            thought={thinkingNow(chat)}
            background={chat.background}
            effort={effort}
            onEffort={changeEffort}
            lite={lite}
            onLite={changeLite}
            /* Only when there is a process to end. With nothing running the
               next message already spawns a fresh agent, so the button would
               promise something that had happened anyway. */
            onRestart={
              conversationId && running.has(conversationId) ? restartAgent : undefined
            }
            room={room}
            seats={mySeats}
            round={myRound}
            onAsk={askRoom}
            onStopRound={stopRound}
            onNewTopic={newTopic}
            topicDrawn={!!(conversationId && topicDrawn[conversationId])}
            onAddSeat={addSeat}
            onRemoveSeat={removeSeat}
            cwd={project?.primary_path ?? ""}
            terminalOpen={termOpen}
            onTerminal={
              project
                ? () =>
                    setTermOpen((open) => {
                      remember(TERM_KEY, open ? "0" : "1");
                      return !open;
                    })
                : undefined
            }
          />

          {(chat.lastDurationMs !== undefined || chat.model) && (
            <div className="statusline">
              {chat.model && <span>{chat.model}</span>}
              {chat.lastDurationMs !== undefined && (
                <span>
                  <RollingText>{`${(chat.lastDurationMs / 1000).toFixed(1)}s`}</RollingText>
                </span>
              )}
              {chat.lastCostUsd !== undefined && (
                <span>
                  <RollingText>{`$${chat.lastCostUsd.toFixed(3)}`}</RollingText>
                </span>
              )}
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

        {/* The agent column: the agents this chat started, as a card that
            looks like it is floating but keeps its own space — the chat ends
            where the column begins, so nothing is ever underneath it.

            A sibling of the views rather than something inside the chat,
            which is where it started and what made it look wrong. In there it
            took its width from the TRANSCRIPT alone: the messages re-centred
            in what was left while the prompt box below them, outside that row,
            stayed centred on the whole window. Two columns, half a panel
            apart, in a layout whose whole shape is one centred column. Out
            here it takes width from the view, so the transcript and the prompt
            box move together and stay lined up — which is what the git and
            files panels beside it have always done. */}
        {mode === "chat" && !railShut && chat.agents.length > 0 && (
          <aside className="side">
            <AgentRail
              agents={chat.agents}
              onOpen={setFocusedAgent}
              onClose={() => showRail(false)}
            />
          </aside>
        )}

        {/* The third desktop column, kept at the far right for both Chat and
            Files: a sibling of the views rather than something laid over them,
            so whichever view is showing gives up width while this is open and
            takes it straight back when it closes. On a phone the stylesheet
            turns the same element into a sheet that slides in from the right. */}
        {gitMounted && (
          <GitPanel
            project={project}
            open={gitOpen}
            persistent={desktopGit}
            onClose={() => showGit(false)}
          />
        )}

        {filesMounted && (
          <SessionFilesPanel
            pins={sessionFiles}
            open={filesOpen}
            busy={chat.busy && !cutOff}
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

      {boardOpen && board && (
        <WorkBoard
          board={board}
          projectName={(id) => workspaces.find((w) => w.id === id)?.name}
          onOpen={(id) => {
            const found = conversations.find((c) => c.id === id);
            if (found) openConversation(found);
            setBoardOpen(false);
          }}
          onClose={() => setBoardOpen(false)}
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
