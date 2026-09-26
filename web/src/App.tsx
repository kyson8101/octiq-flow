// OctiqFlow v2 — the chat client.
//
// Web-first by design: this is the same app whether it runs in a browser on a
// phone or in the desktop window, because it only ever talks to the backend
// over the WebSocket (lib/bridge.ts). The machine running OctiqFlow owns the
// agents; this is a view onto them.
//
// A chat is one durable task. Its project is execution context rather than the
// primary navigation hierarchy, and the agent's session id stays beside it so
// continuing the task resumes the SAME session rather than starting a stranger.
//
// A live chat is one agent process on the server (agent_chat.rs), keyed by
// `chat:<conversationId>`. Its events arrive as `chat-event` and fold into a
// conversation in lib/chat.ts.
//
// Chats run in PARALLEL. Switching to another one does not stop the one you
// leave — its answer arrives, folds into its own transcript, and is saved,
// whether or not it is the chat on screen.
import { useSandboxes } from "./lib/sandbox";
import { SandboxStatus } from "./components/SandboxStatus";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { bridge, type ConnectionState } from "./lib/bridge";
import { CatchUp, type Frame } from "./lib/catchUp";
import { saveChatCheckpoint, forgetChatCheckpoint } from "./lib/chatCache";
import { loadChat, loadEarlierChat } from "./lib/loadChat";
import { ChatHistory, type ChatPage } from "./lib/chatHistory";
import {
  addUserTurn,
  emptyChat,
  isThinking,
  reduceChat,
  thinkingNow,
  turnOutput,
  turnOutputApprox,
  type ChatState,
  type Message,
} from "./lib/chat";
import {
  byTask,
  chatName,
  loadConversations,
  rewriteConversation,
  sameIndex,
  saveConversations,
  shortTitle,
  type Conversation,
} from "./lib/store";
import {
  cancelIndexRemoval,
  indexBackfill,
  markChatRead,
  removeIndexEntry,
  saveIndexEntry,
  saveIndexEntries,
  setChatDone,
  type DeletedIndexEntry,
  type IndexEntry,
} from "./lib/chatIndex";
import { isChatDone } from "./lib/chatFilter";
import { isUnread } from "./lib/unread";
import { recall, remember } from "./lib/remember";
import { forgetChatPlace } from "./lib/chatPlace";
import {
  dismissFailure,
  failureDismissed,
  forgetDismissedFailure,
} from "./lib/failureDismiss";
import {
  deletedIds,
  forgetDeletion,
  isDeleted,
  listDeletions,
  markDeleted,
} from "./lib/deletions";
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
import { ProjectsPage } from "./components/ProjectsPage";
import { BackgroundProvider } from "./components/Background";
import { ChatNotices } from "./components/ChatNotices";
import { backgroundCalls } from "./lib/background";
import { MOBILE, useMedia, WIDE, WORKFLOW_SPLIT } from "./lib/media";
import { useDrawerSwipe } from "./lib/swipe";
import { useDockWidth, type Sizes } from "./lib/dockWidth";
import { MessageList } from "./components/MessageList";
import { Composer, type Attachment, type ReclaimedMessage } from "./components/Composer";
import {
  accessFor,
  accessLabel as providerAccessLabel,
  effortFor,
  liveSettingCommand,
  MODELS,
  modelFromId,
  modelFromReported,
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
import { ConnectionStatus } from "./components/ConnectionStatus";
import { SessionSearch } from "./components/SessionSearch";
import { isUnder, readSession, replaySession, type HistorySession } from "./lib/history";
import { latestResponse as latestAgentResponse, readChatPreview } from "./lib/chatPreview";
import { Sidebar, type Project } from "./components/Sidebar";
import { ChatSearchPage } from "./components/ChatSearchPage";
import { WorkspaceSlotsContext, type WorkspaceSlots } from "./components/WorkspaceHeader";
import type { ChatSearchHit } from "./lib/chatSearch";
import { loadAgents, type AgentInstall } from "./components/AgentsPage";
import { ShelvedProjects } from "./components/ShelvedProjects";
import { DeletedChats } from "./components/DeletedChats";
import { FeedbackInbox } from "./components/FeedbackInbox";
import { ProjectSettings } from "./components/ProjectSettings";
import { ProjectAvatar } from "./components/ProjectAvatar";
import { Settings, type SettingsSection } from "./components/Settings";
import { LeadPicker } from "./components/AgentsSettings";
import { AgentsDashboard } from "./components/AgentsDashboard";
import { pendingPlan, type LeadRecord } from "./lib/agentsDashboard";
import {
  agentIdentity, leadSettings, loadHead, loadHome, loadLeads, loadTeam,
  recallAgentsMode, rememberAgentsMode, taskBrief, type TeamAgent,
} from "./lib/agentsMode";
import { autoExecution, headCoordination, type ExecutionOverrides } from "./lib/agentExecution";
import { personaFor, senderName } from "./lib/agentPersona";
import type { LaunchPlan } from "./lib/taskEnvironment";
import { AgentRosterContext, ChatPersonaContext } from "./lib/agentRoster";

/** Outside agents mode nothing is drawn as a registered agent. */
const NO_ROSTER: readonly TeamAgent[] = [];
import { savedThemeId } from "./lib/themeStore";
import { Usage } from "./components/Usage";
import { GitButton, GitPanel } from "./components/GitPanel";
import { OrchestrationPanel } from "./components/OrchestrationPanel";
import { EMPTY_ORCHESTRATION, isWorkerChat, mainChatId, workerChatParents, type OrchestrationRun } from "./lib/orchestration";
import { chatSnapshot, isActiveRun } from "./lib/chatWorkflow";
import { ChatWorkflowBar } from "./components/ChatWorkflowBar";
import { useOrchestrationFeed } from "./lib/useOrchestrationSnapshot";
import { ImagePreviewPanel, PreviewButton } from "./components/ImagePreviewPanel";
import { useImagePreviews, previewSlots } from "./lib/imagePreview";
import { FilesButton, SessionFilesPanel, useSessionPins } from "./components/SessionFiles";
import { FullscreenButton } from "./components/FullscreenButton";
import { InstalledReload } from "./components/InstalledReload";
import { ChatDeleteButton } from "./components/ChatDeleteButton";
import { CopyChatIdButton } from "./components/CopyChatIdButton";
import { TopbarActionLayout } from "./components/TopbarActionsMenu";
import { ChatTaskBar } from "./components/ChatTaskBar";
import { useCloseFile } from "./components/OpenFile";
import { PathCwdProvider } from "./components/ProsePath";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { ChatRequests } from "./components/ChatRequests";
import { WorkerChatNotice } from "./components/WorkerChatNotice";
import { useChatRequests } from "./lib/useChatRequests";
import {
  provesLiveTurn,
  type ChatQueueState,
} from "./lib/recovery";
import { MessageQueueActions, reconcileQueueSnapshot, reclaimedMessage } from "./lib/messageQueue";
import { useInterruptedChats } from "./lib/useInterruptedChats";
import { readChatRoute, replaceChatRoute, type ChatRoute } from "./lib/chatRoute";
import { projectSlug } from "./lib/projectSlug";
import { ensureGeneralProject } from "./lib/generalProject";
import type { WorkLocationBranches } from "./components/WorkLocation";
import { modelHandoff } from "./lib/modelHandoff";
import { filterVisibleChatNotices, shouldShowChatStatus } from "./lib/chatStatus";
import {
  branchesByProject,
  projectGitPaths,
  projectPrimaryPaths,
  PROJECT_GIT_CHANGED_EVENT,
} from "./lib/projectGit";
import type { WorkspaceGitStatus } from "./lib/workspaceContext";
import { FocusModeButton, useFocusMode } from "./components/FocusMode";
import {
  PullRequestsDashboard,
  type PrDashboardChat,
} from "./components/PullRequestsDashboard";
import type { PrAgentLaunch, PrPreparedAgentChat } from "./lib/pullRequests";
import "./components/FocusMode.css";

type Workspace = Project & {
  paths?: string[];
  shelved?: boolean;
  description?: string;
  /** The project's saved commands, straight from the store. Read through
   *  `parseCommands` where they are drawn — see the terminal drawer. */
  actions?: unknown;
};

type BranchList = {
  is_repo: boolean;
  current: string;
  branches: string[];
  is_worktree: boolean;
};

type PreparedWorkspace = {
  cwd: string;
  branch: string;
  is_repo: boolean;
  is_worktree: boolean;
};

const NO_BRANCHES: WorkLocationBranches = {
  isRepo: false,
  current: "",
  branches: [],
  isWorktree: false,
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
 *  entry and the agent's own process are both still there, untouched.
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
const CMDS_KEY = "octiq.v2.commands";
const EFFORT_KEY = "octiq.v2.effort";
/** Whether new chats start clean. Kept here rather than per project: it is a
 *  way of working, not a property of the code you are working on. */
const LITE_KEY = "octiq.v2.lite";
const LEAD_KEY = "octiq.agentsLead";
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
function readLocation(): ChatRoute { return readChatRoute(location.hash); }

function writeLocation(project: string | null, chat: string | null): void {
  replaceChatRoute(location, history, { project: project ?? undefined, chat: chat ?? undefined });
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
 *  the sidebar is a column; below that the project list is a separate screen. */
const NAV_KEY = "octiq.v2.navShut";
/** How wide that column was dragged. */
const NAV_W_KEY = "octiq.v2.navWidth";
/** The column's range. The floor is where a project name and its chats still
 *  read as an outline rather than as a stack of ellipses; the ceiling is the
 *  point past which a list of names is only whitespace. `dockWidth` squeezes
 *  both ends further when the window cannot afford them. */
const NAV_SIZES: Sizes = { initial: 260, min: 200, max: 460 };
/** The Run column beside an orchestrated chat, dragged by its right edge. The
 *  ceiling is generous because a plan under review reads best wide; the CSS
 *  still keeps the chat beside it from being squeezed out. */
const RUN_W_KEY = "octiq.v2.runWidth";
const RUN_SIZES: Sizes = { initial: 440, min: 320, max: 960 };
/** How long a chat NOBODY IS LOOKING AT may sit unrendered.
 *
 *  Long enough that eight agents streaming at once cost a handful of renders a
 *  second between them rather than hundreds; short enough that a live dot, a
 *  notification or an unread mark is never something you catch being late.
 *  The chat on screen does not go through this — see `writeChats`. */
const QUIETLY_MS = 250;
const FILES_KEY = "octiq.v2.filesOpen";
/** The agent column, put away. Stored the other way round from the two above:
 *  the rail shows itself the moment a chat starts an agent, so what is worth
 *  remembering is the decision to CLOSE it. A missing key is open. */
const RAIL_KEY = "octiq.v2.railShut";
/** How long the panel's slide-out takes. Kept in step with the transition in
 *  styles.css; it only decides when the closed panel leaves the DOM. */
const GIT_SLIDE_MS = 220;
export default function App() {
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectBranches, setProjectBranches] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState<string | null>(null);
  const [shelved, setShelved] = useState<Workspace[]>([]);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [deletedChats, setDeletedChats] = useState<DeletedIndexEntry[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  /** Which agent CLIs this machine has. Asked once on arrival: it decides what
   *  the model picker may offer, so it is not only the Agents page's business. */
  const [agents, setAgents] = useState<AgentInstall[]>([]);
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
   *  `running` means "not asked", not "nothing is". The interruption detector
   *  waits for this before letting a stale busy record behave as idle. */
  const [liveKnown, setLiveKnown] = useState(false);
  const [projectsScreen, setProjectsScreen] = useState(false);
  /** A first-class main-area view. The chat stays mounted behind it so opening
   *  the review desk cannot reset scroll, drafts, requests, or live streams. */
  const [prDashboardOpen, setPrDashboardOpen] = useState(false);
  /** The Projects page, the same kind of main-area view: null when closed,
   *  otherwise the project whose tasks it lists, or null for the list. */
  const [projectsPage, setProjectsPage] = useState<{ projectId: string | null } | null>(null);
  /** Search chats, the third main-area view. */
  const [searchPage, setSearchPage] = useState(false);
  /** The top bar's slots a page renders its title and actions into
   *  (components/WorkspaceHeader). State, not refs, so a page mounted in the
   *  same commit as the bar re-renders into it before anything is painted. */
  const [headingSlot, setHeadingSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [contextSlot, setContextSlot] = useState<HTMLElement | null>(null);
  // The stored list, minus everything this browser has deleted. The two are
  // written at different moments — a save already on its way when the × was
  // clicked lands after it — so the copy on disk can still carry a chat whose
  // delete is settled. See lib/deletions.
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations().filter((c) => !isDeleted(c.id)),
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  /** The host-side execution location for the next new chat. These choices
   *  are applied before `chat_start`, so the agent never has to ask how its
   *  branch or worktree should be prepared. */
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<WorkLocationBranches>(NO_BRANCHES);
  const [newWorktree, setNewWorktree] = useState(false);
  const sandboxes = useSandboxes();
  const [sandboxChoice, setSandboxChoice] = useState<boolean | null>(null);
  const useSandbox = sandboxChoice ?? sandboxes.snapshot?.defaultEnabled ?? false;
  const [indexReady, setIndexReady] = useState(false);
  const [unavailableChat, setUnavailableChat] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  /** Which agent the rail has opened, by `task_id`, or null for the whole
   *  conversation. View state, not chat state: it is about what this person is
   *  reading, and it must not survive into another conversation. */
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  /** Wide enough to keep the primary navigation in the top bar. Below this it moves
   *  into the projects screen; actions and readouts use wider thresholds. */
  const wide = useMedia(WIDE);
  const roomToSplit = useMedia(WORKFLOW_SPLIT);
  /** A temporary focus view for the tablet layout. On a desktop each column
   *  already has its own control on the bar — the project name, the Git
   *  button — so one more that sweeps both away at once adds nothing. */
  const [chatWide, setChatWide] = useState(false);
  const chatExpanded = chatWide && wide;
  /** The project column, put away, on the screens where it is a column.
   *  Remembered: someone who works with the chat full width wants it that way
   *  the next time too. */
  const [navShut, setNavShut] = useState(() => localStorage.getItem(NAV_KEY) === "1");
  /** The project list is a separate screen below 860px and a column above it.
   *  Top-bar action/readout capacity has its own, wider breakpoints: a desktop
   *  column layout does not imply that every control fits in one header row. */
  const isMobile = useMedia(MOBILE);
  const { focusMode, enterFocus, exitFocus } = useFocusMode(!(isMobile && projectsScreen));
  /** What the top bar offers a page. A phone's bar has no room for a page's
   *  buttons or a run's line, and focus mode hides the bar, so those render
   *  in the page instead. */
  const workspaceSlots = useMemo<WorkspaceSlots>(() => ({
    heading: headingSlot,
    actions: isMobile ? null : actionsSlot,
    context: isMobile || focusMode ? null : contextSlot,
  }), [headingSlot, actionsSlot, contextSlot, isMobile, focusMode]);
  /** The top bar's way back to a put-away sidebar, focused when it is put away. */
  const navButton = useRef<HTMLButtonElement | null>(null);
  /** The width of that column, dragged by its right edge and remembered. Only
   *  read on desktop, where the sidebar is a column; the mobile list
   *  is the width of the screen. */
  const nav = useDockWidth(NAV_W_KEY, NAV_SIZES, "left");
  const runDock = useDockWidth(RUN_W_KEY, RUN_SIZES, "left");
  /* Published on the root rather than on the shell, because the layout is not
   * the only thing that needs it: a right-hand panel works out its own maximum
   * from what the project column is taking, and `dockWidth` reads it from
   * here. Set imperatively so it is one property on one element, wherever in
   * the tree it is read from.
   *
   * BEFORE the paint, not after: a column that was left put away is held off
   * screen by a margin of its own width, and a first frame drawn at the
   * stylesheet's 260px would then TRANSITION to a remembered 400 — the chat
   * sliding sideways on load, for a column nobody can see. */
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--nav-w", `${nav.width}px`);
  }, [nav.width]);
  /** The chat pane used to focus the active chat input. */
  const pane = useRef<HTMLElement | null>(null);
  const showingProjects = isMobile && projectsScreen;
  const projectSwipeRef = useDrawerSwipe({
    // The edge remains the way back to navigation in focus mode too. Opening
    // the projects screen makes focus mode unavailable, so the same gesture
    // cleanly leaves focus and reveals the sidebar.
    enabled: isMobile,
    open: showingProjects,
    onChange: (open) => {
      if (open) setChatWide(false);
      setProjectsScreen(open);
    },
  });
  // There must always be a visible way back. A narrow layout already gives the
  // chat the whole body.
  useEffect(() => {
    if (!wide || !isMobile) setChatWide((was) => (was ? false : was));
  }, [wide, isMobile]);
  // Switching conversations closes the focus panel. Without this the next
  // conversation opens showing "conversation" as a back arrow over a blank
  // panel until something is clicked.
  useEffect(() => {
    setFocusedAgent(null);
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const orchestrationState = useOrchestrationFeed();
  const orchestration = orchestrationState.snapshot ?? EMPTY_ORCHESTRATION;
  const chatParents = useMemo(() => workerChatParents(orchestration), [orchestration]);
  const workerChat = isWorkerChat(conversationId, chatParents);
  /** Which chats the person opened the run surface for with Run, before the
   *  chat has a run of its own. View state only, held in memory: there is no
   *  execution mode. A regular agent decides for itself how to work, and a run
   *  only exists once somebody explicitly starts one — the person from this
   *  surface, or an agent the person asked to delegate. */
  const [runOpened, setRunOpened] = useState<Record<string, boolean>>({});
  const [workflowViews, setWorkflowViews] = useState<Record<string, "chat" | "run">>({});
  const workflowKey = conversationId ?? "new";
  const currentWorkflow = useMemo(() => chatSnapshot(orchestration, conversationId ? keyFor(conversationId) : null), [orchestration, conversationId]);
  const orchestrated = currentWorkflow.runs.some(isActiveRun) || !!runOpened[workflowKey];
  const workflowView = workflowViews[workflowKey] ?? "chat";
  // Wide enough, and this chat has work to show: the conversation and its
  // tasks sit side by side instead of taking turns behind a tab. Focus mode is
  // a single reading column by definition, so it never splits.
  // The tail of this is exactly what decides whether the run surface renders
  // at all, and has to stay that way: a split with nothing in the second
  // column is a border down the middle of the transcript.
  const showWorkflowView = (view: "chat" | "run") => {
    setWorkflowViews((before) => ({ ...before, [workflowKey]: view }));
    // Going back to the chat before any run was started puts the surface away
    // again, rather than leaving Tasks/Chat tabs over a chat with no tasks.
    if (view === "chat" && runWorkflow.runs.length === 0) setRunOpened((before) => ({ ...before, [workflowKey]: false }));
  };
  const [pendingGateDecision, setPendingGateDecision] = useState<{ id: string; text: string } | null>(null);
  const coordinatorId = mainChatId(conversationId, chatParents);
  // The task list belongs to the main chat, and stays up while one of its
  // workers is open: tapping a task swaps the conversation, not the list, and
  // the task you are in is the one lit up in it.
  const runChatKey = workerChat ? (coordinatorId ? keyFor(coordinatorId) : null) : conversationId ? keyFor(conversationId) : null;
  const runWorkflow = useMemo(() => workerChat ? chatSnapshot(orchestration, runChatKey) : currentWorkflow,
    [workerChat, orchestration, runChatKey, currentWorkflow]);
  const workflowVisible = orchestrated || runWorkflow.runs.length > 0;
  const workflowSplit = roomToSplit && !focusMode && workflowVisible;
  const [displayedRuns, setDisplayedRuns] = useState<Record<string, string | null>>({});
  const displayedRunKey = runChatKey ?? "new";
  const onSelectedRunChange = useCallback((runId: string | null) => {
    setDisplayedRuns((before) => before[displayedRunKey] === runId ? before : { ...before, [displayedRunKey]: runId });
  }, [displayedRunKey]);
  const displayedRunId = displayedRuns[displayedRunKey];
  const displayedRun = displayedRunId === null ? null
    : runWorkflow.runs.find((run) => run.id === displayedRunId)
      ?? runWorkflow.runs.find((run) => run.archivedAt == null) ?? runWorkflow.runs[0];
  const coordinatorConversation = conversations.find((chat) => chat.id === coordinatorId);
  // The coordinator the ledger names for this worker's own run. The chat tree
  // walks to the top-most head, which for a delegated run is not the chat
  // that coordinates it.
  const workerCoordinatorKey = useMemo(() => {
    if (!workerChat || !conversationId) return null;
    const key = keyFor(conversationId);
    const runId = orchestration.attempts.find((attempt) => attempt.workerChatKey === key)?.runId;
    return orchestration.runs.find((run) => run.id === runId)?.coordinatorChatKey ?? null;
  }, [workerChat, conversationId, orchestration]);
  const workerRequestIds = useMemo(() => conversationId && !workerChat
    ? [...chatParents.keys()].filter((id) => mainChatId(id, chatParents) === conversationId)
    : [], [conversationId, workerChat, chatParents]);
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
    // The same question `isMobile` answers, asked one render earlier: the
    // media hook has not run yet, and a column that appears a frame late reads
    // as the page still loading.
    return typeof window !== "undefined" && !window.matchMedia(MOBILE).matches;
  });
  /** Kept mounted while the panel slides away, so closing it on a phone is the
   *  reverse of opening rather than the panel blinking out. Unmounting on
   *  `gitOpen` alone would cut the animation off at its first frame. */
  const [gitMounted, setGitMounted] = useState(gitOpen);
  /** Column, not overlay: above the drawer breakpoint the panel is the third
   *  column of the workspace and takes its width from the chat rather than
   *  covering it. About its SHAPE, not about whether it can be put away — it
   *  can, in either shape, from the same top-bar button. */
  const desktopGit = !isMobile;
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
  const { asks, setAsks, safetyBlocks, setSafetyBlocks, questions, setQuestions } =
    useChatRequests(conn, (...args) => announceOnce(...args));
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
  // Agents mode (lib/agentsMode): the primary entry opens the CTO conversation,
  // which plans work and hands approved tasks to registered agents. Off,
  // nothing below changes anything.
  const [agentsMode, setAgentsMode] = useState<boolean>(recallAgentsMode);
  const [leadRecordsState, setLeadRecordsState] = useState<"loading" | "ready" | "error">(
    () => agentsMode ? "loading" : "ready",
  );
  const changeAgentsMode = useCallback((on: boolean) => {
    setLeadRecordsState(on ? "loading" : "ready");
    setAgentsMode(on);
    rememberAgentsMode(on);
  }, []);
  const [team, setTeam] = useState<TeamAgent[]>([]);
  const [leadId, setLeadId] = useState<string | null>(() => recall(LEAD_KEY));
  // The lead the person talks to across projects (Settings, Agents), every
  // registered agent (to name the lead of a conversation from any project),
  // and which chats were handed to whom.
  const [head, setHead] = useState<TeamAgent | null>(null);
  const [roster, setRoster] = useState<TeamAgent[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  // The empty page is a new conversation with the head, not a project task.
  const [headDraft, setHeadDraft] = useState(false);
  /** The configured coordination home (Settings, Agents), or null for the
   *  project named General. */
  const [homeId, setHomeId] = useState<string | null>(null);
  /** Agents mode: the location controls are hidden until Advanced is opened,
   *  and only what the person changes there overrides the automatic plan. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrides, setOverrides] = useState<ExecutionOverrides>({});
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("projects");
  const [agentsDashboard, setAgentsDashboard] = useState(false);
  /** A main-area page is open in place of the chat. Settings and the Agents
   *  dashboard are pages like Projects and Search: the sidebar stays, and the
   *  page's title sits in the one top bar. */
  const mainPage = prDashboardOpen || projectsPage !== null || searchPage || appSettings
    || (agentsDashboard && agentsMode);

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
  // A user chat outlives any one provider session. Selecting another model
  // ends the native process, then the next send starts the chosen provider
  // with a provider-neutral handoff of the visible conversation.
  const pendingModelHandoffs = useRef(new Set<string>());
  const modelSwitches = useRef(new Map<string, Promise<void>>());
  // A copy of `running` that callbacks can read without being rebuilt whenever
  // it changes.
  const runningRef = useRef(running);
  runningRef.current = running;
  // The same, for the loaded chats. `openConversation` has to know whether the
  // one being opened already has words in it — and it must NOT be rebuilt every
  // time any chat says anything, because the sidebar and the notification
  // handler both hold on to it.
  //
  // This ref is the AUTHORITATIVE copy, and `chats` above is a render of it.
  // Every write goes here first, synchronously, and only then asks for a
  // render — which is what lets a delta for a chat NOBODY IS LOOKING AT stop
  // costing a render of the whole app. Eight agents answering at once is
  // hundreds of deltas a second, each of which used to run App's render and,
  // through it, rebuild the entire element tree of the transcript on screen.
  // See `writeChats`.
  const chatsRef = useRef<Record<string, ChatState>>(chats);
  // Which conversation is on screen, readable from a callback. Deltas for it
  // are the ones that must not wait.
  const visibleRef = useRef(conversationId);
  visibleRef.current = conversationId;
  const soon = useRef<number | null>(null);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Show what the ref now holds. */
  const flushChats = useCallback(() => {
    if (soon.current !== null) {
      cancelAnimationFrame(soon.current);
      soon.current = null;
    }
    if (later.current !== null) {
      clearTimeout(later.current);
      later.current = null;
    }
    setChats(chatsRef.current);
  }, []);

  /** Take the new set of loaded chats, and decide how soon it has to be seen.
   *
   *  `urgent` is the chat on screen: its words go up on the next frame, so
   *  nothing about reading a live answer changes. Everything else — the seven
   *  other agents working behind this one — is coalesced into one render every
   *  QUIETLY_MS. Nothing reads a background chat faster than that: the live
   *  dots, the desktop notifications and the debounced save are all things a
   *  quarter of a second late is indistinguishable from on time. */
  const writeChats = useCallback(
    (next: Record<string, ChatState>, urgent: boolean) => {
      if (next === chatsRef.current) return;
      chatsRef.current = next;
      // The timer is armed either way, as the backstop. A hidden tab is served
      // no animation frames at all, so an urgent write on its own would leave
      // the chat on screen frozen in the ref — and with it the debounced save,
      // which is what makes a laptop closed mid-answer come back with the
      // answer. Whichever fires first clears the other.
      if (later.current === null) {
        later.current = setTimeout(() => {
          later.current = null;
          flushChats();
        }, QUIETLY_MS);
      }
      if (urgent && soon.current === null) {
        soon.current = requestAnimationFrame(() => {
          soon.current = null;
          flushChats();
        });
      }
    },
    [flushChats],
  );

  // Opening a chat shows what it holds NOW. A conversation that was in the
  // background a moment ago can have a quarter of a second of answer still
  // sitting in the ref, and a transcript that fills in a beat after the page it
  // is on reads as a stutter rather than as a chat.
  useEffect(() => {
    flushChats();
  }, [conversationId, flushChats]);

  // Nothing left holding a frame or a timer when the page goes.
  useEffect(
    () => () => {
      if (soon.current !== null) cancelAnimationFrame(soon.current);
      if (later.current !== null) clearTimeout(later.current);
    },
    [],
  );
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
   *  and the screen if it is the one you are looking at. */
  const forgetLocally = useCallback(
    (id: string) => {
    gone.current.add(id);
    chatReads.current.delete(id);
    chatHistory.current.forget(id);
    cachedStates.current.delete(id);
    void forgetChatCheckpoint(id);
    catchUp.current.forget(keyFor(id));
    // Urgent whichever chat this is: a row being deleted has to leave the
    // screen when it is deleted, not a quarter of a second afterwards.
    if (id in chatsRef.current) {
      const next = { ...chatsRef.current };
      delete next[id];
      writeChats(next, true);
    }
    delete meta.current[id];
    pendingModelHandoffs.current.delete(id);
    modelSwitches.current.delete(id);
    // Where it was left goes with it. The cap in lib/chatPlace would drop it
    // eventually anyway; this is so a deleted chat is not still taking up one
    // of the places a live chat could have.
    forgetChatPlace(id);
    // And the banner it was told to stop showing, for the same reason.
    forgetDismissedFailure(id);
    setConversationId((open) => (open === id ? null : open));
    // The chat you were last in is remembered by id, and a deleted one left
    // there is a restore that waits for a row that is never coming.
    try {
      if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
    } catch {
      /* storage blocked: nothing was remembered to forget */
    }
    },
    [writeChats],
  );

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
  const chatReads = useRef(new Map<string, { promise: Promise<void> }>());
  const cachedStates = useRef(new Map<string, ChatState>());
  const chatHistory = useRef(new ChatHistory());
  const loadPreview = useCallback((c: Conversation, cancelled: () => boolean) =>
    readChatPreview(
      () => bridge.invoke<ChatPage>("chat_page", { key: keyFor(c.id), before: null }),
      c.messages,
      cancelled,
    ), []);
  const [earlierReads, setEarlierReads] = useState<Record<string, { loading: boolean; error?: string }>>({});

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
    agentFor: (_chatKey: string): string | undefined => undefined,
  });
  notifying.current = {
    on: notifyOn,
    push: pushOn,
    reading: conversationId,
    list: conversations,
    projects: workspaces,
    shelved,
    // Agents mode: a banner says which agent it is about. An ordinary chat
    // has no persona and its banner is unchanged.
    agentFor: (chatKey: string) =>
      agentsMode ? personaFor(chatKey, leads, roster)?.name : undefined,
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
    const { on, push: viaPush, reading, list, projects, shelved: away, agentFor } = notifying.current;
    // The server has this covered, and its banner arrives whether or not this
    // page is still here. Raising one too would only double it.
    if (viaPush) return;
    const focus = focusNow(reading);
    if (!owed({ enabled: on, permission: permissionNow() }, focus, id)) return;
    const chat = list.find((c) => c.id === id);
    const notice = noticeFor({
      kind,
      conversationId: id,
      projectName: [...projects, ...away].find((w) => w.id === chat?.projectId)?.name ?? "",
      chatTitle: chat?.title ?? "",
      detail,
      agentName: agentFor(keyFor(id)),
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

  useEffect(() => bridge.onState(setConn), []);
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
          return null;
        });
      })
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(loadWorkspaces, [loadWorkspaces]);

  /** Keep one Git watcher for the whole project list and annotate each chat's
   *  project with the branch checked out at its primary path. The watcher is
   *  server-owned, so a reconnect installs it again. */
  useEffect(() => {
    if (conn !== "open") return;
    const projects = [...workspaces, ...shelved];
    const watchedPaths = projectGitPaths(projects);
    const primaryPaths = projectPrimaryPaths(projects);
    let live = true;

    const read = () => {
      if (primaryPaths.length === 0) {
        setProjectBranches({});
        return;
      }
      bridge
        .invoke<WorkspaceGitStatus[]>("git_status_summary", { paths: primaryPaths })
        .then((statuses) => {
          if (live) setProjectBranches(branchesByProject(projects, statuses ?? []));
        })
        .catch(() => {
          if (live) setProjectBranches({});
        });
    };
    const refresh = () => { read(); };

    // Replaces the server's previous watcher with the complete project set.
    // A project can contain additional repositories, so watch every folder even
    // though the sidebar label itself comes only from the primary path.
    bridge.invoke("git_watch_paths", { paths: watchedPaths }).catch(() => {});
    read();
    window.addEventListener("focus", refresh);
    const offWatch = bridge.on("git-status-changed", () => {
      window.dispatchEvent(new CustomEvent(PROJECT_GIT_CHANGED_EVENT));
      read();
    });

    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      offWatch();
    };
  }, [conn, workspaces, shelved]);

  /** Return the ordinary persisted workspace used when a task has no reliable
   * project clue. It is created lazily, on the first such send, so existing
   * profiles are not mutated merely by opening the app. An earlier General
   * that was shelved is brought back because it is now the explicit fallback
   * destination for new tasks. */
  const ensureGeneralWorkspace = useCallback(async (): Promise<Workspace> => {
    // A configured home wins; General is the fallback when there is none, or
    // when the one configured has since been removed.
    const configured = homeId ? workspaces.find((workspace) => workspace.id === homeId) : undefined;
    if (configured) return configured;
    const away = homeId ? shelved.find((workspace) => workspace.id === homeId) : undefined;
    if (away) {
      await bridge.invoke("set_workspace_shelved", { id: away.id, shelved: false });
      const restored = { ...away, shelved: false };
      setWorkspaces((current) => [...current.filter((workspace) => workspace.id !== away.id), restored]);
      setShelved((current) => current.filter((workspace) => workspace.id !== away.id));
      return restored;
    }
    const result = await ensureGeneralProject(
      workspaces,
      shelved,
      (command, args) => bridge.invoke(command, args),
    );
    setWorkspaces(result.active);
    setShelved(result.shelved);
    return result.project;
  }, [workspaces, shelved, homeId]);

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
    // Trash is a second view of the same server-side index. Read both views as
    // one refresh so a row found in Trash can never be folded back in from an
    // active-list reply that raced the delete.
    Promise.all([
      bridge.invoke<IndexEntry[]>("chat_index_list"),
      bridge.invoke<DeletedIndexEntry[]>("chat_index_deleted"),
    ])
      .then(([answer, deleted]) => {
        setIndexReady(true);
        const buriedOnServer = deleted ?? [];
        setDeletedChats(buriedOnServer);
        const serverDeleted = new Set(buriedOnServer.map((chat) => chat.id));
        // Unlike an empty active list, an explicit Trash row is authoritative.
        // This matters when the last remaining chat was deleted on another
        // device: the active answer is empty, but it is not "no news".
        for (const c of conversationsRef.current) {
          if (serverDeleted.has(c.id) && !leavingRef.current.has(c.id)) {
            forgetLocally(c.id);
          }
        }
        if (serverDeleted.size > 0) {
          setConversations((local) => {
            const list = local.filter(
              (chat) => !serverDeleted.has(chat.id) || leavingRef.current.has(chat.id),
            );
            if (list.length === local.length) return local;
            saveConversations(list);
            return list;
          });
        }
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
        const superseded = new Set<string>();
        for (const d of buried) {
          const row = answer.find((candidate) => candidate.id === d.id);
          if (!row) continue;
          // A restore increments the server-owned generation. It outranks a
          // tombstone left in another browser and cancels any retry that browser
          // still had queued for the older delete.
          if ((row.generation ?? 0) > (d.generation ?? 0)) {
            superseded.add(d.id);
            forgetDeletion(d.id);
            cancelIndexRemoval(d.id);
            gone.current.delete(d.id);
          } else {
            removeIndexEntry(d.id, d.key, d.generation ?? 0, d.meta);
          }
        }
        const gravestones = new Set(
          buried.filter((d) => !superseded.has(d.id)).map((d) => d.id),
        );
        // Chats from before the server index existed can still live only in
        // the browser that made them. Once this page has seen a non-empty list
        // from the active profile, offer every such unsynced row to the server
        // so a second device can discover it too. Never offer a deletion — a
        // stale browser cache must not be able to resurrect one.
        const excluded = new Set([
          ...serverDeleted,
          ...gravestones,
          ...leavingRef.current,
          ...gone.current,
        ]);
        saveIndexEntries(indexBackfill(conversationsRef.current, answer, excluded));
        const remote = answer.filter(
          (row) => !serverDeleted.has(row.id) && !gravestones.has(row.id),
        );
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
        // A row explicitly present in the active list is not gone anymore. A
        // local tombstone was filtered above; this clears only server-side
        // restores observed by a browser that did not initiate the delete.
        for (const row of remote) gone.current.delete(row.id);
        for (const c of conversationsRef.current) {
          // A local delete has already committed, but its sidebar row gets a
          // brief collapse before React unmounts it. Do not let the index
          // answer cut that visual transition short.
          if (
            c.synced &&
            !known.has(c.id) &&
            !serverDeleted.has(c.id) &&
            !leavingRef.current.has(c.id)
          ) {
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
              cwd: r.cwd ?? cached?.cwd,
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
    setLiveKnown(false);
    if (conn !== "open") return;
    let current = true;
    bridge
      .invoke<string[]>("chat_list")
      .then((keys) => {
        if (!current) return;
        const ids = (keys ?? []).map(convOf).filter((id): id is string => !!id);
        setRunning(new Set(ids));
        setLiveKnown(true);
      })
      .catch(() => {});
    return () => { current = false; };
  }, [conn]);

  /** Apply a change to ONE conversation's chat, whether or not it is the one on
   *  screen. Every update goes through here, which is what makes a background
   *  chat keep working while you read another. */
  const patch = useCallback(
    (id: string, fn: (s: ChatState) => ChatState) => {
      const held = chatsRef.current;
      const before = held[id] ?? EMPTY;
      const after = fn(before);
      // A reducer that decided nothing had changed is not a render. Several of
      // these hand `s` straight back — a replay landing on a chat already
      // spoken in, a status for a chat this page has let go of.
      if (after === before) return;
      // Urgent only for the chat being read. The rest is the whole point of
      // `writeChats`: a background answer still folds in immediately, it is
      // only the RENDER of it that waits for the others to catch up.
      writeChats({ ...held, [id]: after }, id === visibleRef.current);
    },
    [writeChats],
  );

  /** Words taken back out of the queue, waiting to go back in the box.
   *
   *  The ✕ on a queued bubble is the only thing that puts anything here — Stop
   *  keeps the queue and runs the front of it. Those words were TYPED, and the
   *  bubble going used to take them with it: a paragraph gone to one click,
   *  with nowhere left to read it back from.
   *
   *  Filled from the backend's own `octiq_user_turn_cancelled`, one per message
   *  it actually let go of — never from what this page thinks is queued, which
   *  would hand back a message the agent had already been given.
   *
   *  Kept per CHAT rather than for the screen: an event can arrive for a
   *  conversation that is not the one on screen, and those words belong in ITS
   *  box, not in whatever is open now. */
  const [reclaimed, setReclaimed] = useState<Record<string, ReclaimedMessage[]>>({});

  /** The turns already handed back, so no message can go in the box twice.
   *
   *  The ✕ hears of its own cancellation from two directions — the answer to
   *  the call it made, and the backend's announcement of the same thing to
   *  every tab — and which arrives first is not this page's to decide. The turn
   *  id is what makes them one event. Bounded because it only ever grows on a
   *  cancellation, and a tab left open for a week should not remember every
   *  one. */
  const reclaimedIds = useRef<string[]>([]);

  /** Hold one cancelled message's words for the box. */
  const reclaim = useCallback((id: string, turnId: string, message: Message | undefined) => {
    if (!message || reclaimedIds.current.includes(turnId)) return;
    const words = reclaimedMessage(message);
    reclaimedIds.current = [...reclaimedIds.current.slice(-199), turnId];
    setReclaimed((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), words] }));
  }, []);

  /** The box has taken them; this chat has nothing waiting to go back in. */
  const tookBack = useCallback((id: string) => {
    setReclaimed((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
    (id: string, storedSeq?: number, earlier = false): Promise<void> => {
      const existing = chatReads.current.get(id);
      if (existing) return existing.promise;
      const key = keyFor(id);
      const read = { promise: Promise.resolve() };
      chatReads.current.set(id, read);
      const cancelled = () => chatReads.current.get(id) !== read || gone.current.has(id);
      read.promise = (earlier ? loadEarlierChat : loadChat)({
        id, key, storedSeq, catchUp: catchUp.current, history: chatHistory.current,
        requestPage: (before) => bridge.invoke<ChatPage>("chat_page", { key, before }),
        getState: () => chatsRef.current[id] ?? EMPTY,
        publish: (state) => patch(id, () => state),
        request: (after) => bridge.invoke<Frame[]>("chat_since", { key, after }),
        cancelled,
      }).catch((err: unknown) => {
        if (!cancelled()) catchUp.current.abandon(key);
        throw err;
      }).finally(() => {
        if (chatReads.current.get(id) === read) chatReads.current.delete(id);
      });
      return read.promise;
    },
    [patch],
  );

  const loadEarlier = useCallback(async () => {
    const id = visibleRef.current;
    if (!id || !chatHistory.current.hasEarlier(id)) return;
    setEarlierReads((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      // A reconnect may already be filling the newest tail. Let it commit
      // before beginning a backwards page against the same window.
      await chatReads.current.get(id)?.promise;
      if (!gone.current.has(id)) await catchUpChat(id, undefined, true);
      setEarlierReads((prev) => ({ ...prev, [id]: { loading: false } }));
    } catch (error) {
      setEarlierReads((prev) => ({ ...prev, [id]: { loading: false, error: String(error) } }));
    }
  }, [catchUpChat]);

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
    const visible = visibleRef.current;
    const ids = new Set(runningRef.current);
    if (visible) ids.add(visible);
    for (const id of ids) {
      if (id !== visible && !catchUp.current.holds(keyFor(id))) continue;
      const storedSeq = conversationsRef.current.find((c) => c.id === id)?.seq;
      catchUpChat(id, storedSeq).catch(() => {});
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
        // A saved question resumes from the backend, not through `send`, so no
        // browser gets the usual optimistic running mark. `turn.started` (or
        // Claude's `message_start`) is direct proof that the worker exists.
        // Record it before folding the event that sets `busy`, so the process
        // roster and transcript state cannot briefly disagree.
        if (provesLiveTurn(payload.event)) {
          setRunning((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        }
        // What is safe to fold RIGHT NOW. Nothing, while a catch-up for this
        // chat is in the air — that catch-up is about to rebuild it, and would
        // wipe anything folded on top in the meantime.
        const frames = catchUp.current.live(payload.key, payload.seq, payload.event);
        chatHistory.current.append(id, frames);
        for (const frame of frames) {
          // Read BEFORE the fold, which is the thing that removes the bubble
          // the words are in. Here rather than in the reducer on purpose: the
          // reducer also walks a REPLAY, and the cancellations in a transcript
          // from last week are history, not something to hand anyone back.
          const e = frame.event as { type?: unknown; uuid?: unknown } | null;
          if (e && e.type === "octiq_user_turn_cancelled" && typeof e.uuid === "string") {
            reclaim(id, e.uuid, chatsRef.current[id]?.messages.find((m) => m.turnId === e.uuid));
          }
          patch(id, (s) => reduceChat(s, frame.event));
        }
      }),
    [patch, reclaim],
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
          // This is an internal harness recovery record. It remains in the
          // server diagnostic journal, but a person cannot act on it, so it
          // must not become an amber "Dismiss all" warning in their chat.
          if (!shouldShowChatStatus(payload.kind, payload.text)) return;
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
  /** Codex has no command catalog in its exec stream. Remember which projects
   * this page has already asked its app-server about, while still refreshing
   * once after a browser reload even when localStorage can draw an old list. */
  const codexSkillsLoaded = useRef(new Set<string>());
  const codexSkillsPending = useRef(new Set<string>());
  const [codexSkillsStatus, setCodexSkillsStatus] = useState<Record<string, string>>({});

  // Claude's command list comes from the session's startup announcement and is
  // cached per provider from then on. Codex has no corresponding exec event;
  // `loadCodexSkills` below fills its side lazily from the app-server instead.
  // Read startup lists from every loaded chat, not only the visible one — a
  // chat working in the background is just as good a source.
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
      for (const [id, state] of Object.entries(chatsRef.current)) {
        if (undoable.has(id) || gone.current.has(id) || chatReads.current.has(id)) continue;
        if (!catchUp.current.holds(keyFor(id)) || chatHistory.current.hasEarlier(id) || cachedStates.current.get(id) === state) continue;
        cachedStates.current.set(id, state);
        void saveChatCheckpoint({ id, state, seq: catchUp.current.mark(keyFor(id)), updatedAt: Date.now() });
      }
      setConversations((prev) => {
        let list = prev;
        let touched = false;
        const changedIds = new Set<string>();
        for (const [id, s] of Object.entries(chats)) {
          if (undoable.has(id) || gone.current.has(id) || chatReads.current.has(id) || chatHistory.current.hasEarlier(id)) continue;
          const info = meta.current[id];
          if (!info || s.messages.length === 0) continue;
          const before = list.find((c) => c.id === id);
          if (before && before.messages === s.messages) continue;
          // Everything the row already knew is CARRIED, and only what this
          // save actually recomputes is laid over it. Listing the carried
          // fields by hand is how `synced` went missing once — see
          // `rewriteConversation`.
          const next: Conversation = rewriteConversation(before, {
            ...(before ?? ({} as Conversation)),
            id,
            projectId: info.projectId,
            // The name it already has, and only otherwise one from the
            // messages — see `chatName`. Re-deriving it every save renamed a
            // chat after a partial view of itself.
            title: chatName(before?.title, s.messages, before?.customTitle),
            latestResponse: latestAgentResponse(s.messages)?.text ?? before?.latestResponse,
            customTitle: before?.customTitle,
            sessionId: s.sessionId ?? before?.sessionId,
            cwd: s.cwd ?? before?.cwd,
            messages: s.messages,
            modelId: info.modelId,
            permission: info.access,
            // Set once, on the first save. It records when the task began;
            // updatedAt below carries the meaningful activity used by byTask.
            createdAt: before?.createdAt ?? Date.now(),
            // Streaming deltas update the transcript and latest-response
            // preview, but must not churn the list. User sends and completed
            // turns touch this timestamp at their own boundaries.
            updatedAt: before?.updatedAt ?? Date.now(),
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
            latestResponse: c.latestResponse,
            customTitle: c.customTitle,
            sessionId: c.sessionId ?? null,
            cwd: c.cwd ?? null,
            modelId: c.modelId ?? null,
            access: c.permission ?? null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            pinned: c.pinned ?? false,
            generation: c.generation,
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
    if (restored.current && !awaited.current) {
      writeLocation(ws ? projectSlug(ws.name) : projectId, unavailableChat ?? conversationId);
    }
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
  }, [projectId, conversationId, workspaces, unavailableChat]);

  const project = useMemo(
    () => workspaces.find((w) => w.id === projectId) ?? null,
    [workspaces, projectId],
  );
  const loadCodexSkills = useCallback((force = false) => {
    if (choice.agent !== "codex" || !projectId || !project?.primary_path) return;
    const key = `${projectId}:codex`;
    if (codexSkillsPending.current.has(key) || (!force && codexSkillsLoaded.current.has(key))) return;
    codexSkillsLoaded.current.add(key);
    codexSkillsPending.current.add(key);
    setCodexSkillsStatus((previous) => ({ ...previous, [key]: "loading" }));

    bridge
      .invoke<unknown>("codex_skills", { cwd: project.primary_path })
      .then((value) => {
        const skills = Array.isArray(value)
          ? value.filter((skill): skill is string => typeof skill === "string")
          : [];
        setCommands((previous) => {
          const next = {
            ...previous,
            [projectId]: { ...previous[projectId], codex: skills },
          };
          remember(CMDS_KEY, JSON.stringify(next));
          return next;
        });
      })
      .then(() => {
        setCodexSkillsStatus((previous) => ({ ...previous, [key]: "" }));
      })
      .catch(() => {
        setCodexSkillsStatus((previous) => ({ ...previous, [key]: "Could not load skills. Try again." }));
        // A reconnect or a newly installed Codex should get another chance the
        // next time the slash menu is opened.
        codexSkillsLoaded.current.delete(key);
      })
      .finally(() => codexSkillsPending.current.delete(key));
  }, [choice.agent, project, projectId]);
  const taskList = useMemo(() => byTask(conversations), [conversations]);
  const searchChats = useCallback(
    (query: string) => bridge.invoke<ChatSearchHit[]>("chat_search", { query, limit: 50 }),
    [],
  );

  /** The chat on screen. Everything else is still running behind it. */
  const chat = (conversationId && chats[conversationId]) || EMPTY;

  // Agents mode: the agents this project can hand a task to, and which one a
  // new task goes to. Re-read when Settings closes, where they are edited.
  const teamProjectId = project?.id ?? null;
  useEffect(() => {
    if (!agentsMode || conn !== "open" || appSettings) return;
    let alive = true;
    loadTeam(teamProjectId)
      .then((agents) => { if (alive) setTeam(agents); })
      .catch(() => { if (alive) setTeam([]); });
    return () => { alive = false; };
  }, [agentsMode, teamProjectId, appSettings, conn]);
  useEffect(() => {
    if (!agentsMode) { setLeadRecordsState("ready"); return; }
    if (conn !== "open" || appSettings) return;
    let alive = true;
    setLeadRecordsState("loading");
    Promise.all([loadHead(), loadTeam(null, true), loadLeads(), loadHome().catch(() => null)])
      .then(([configured, everyone, handed, home]) => {
        if (!alive) return;
        setHead(configured);
        setRoster(everyone);
        setLeads(handed);
        setHomeId(home);
        setLeadRecordsState("ready");
      })
      .catch(() => { if (alive) setLeadRecordsState("error"); });
    return () => { alive = false; };
  }, [agentsMode, appSettings, conn]);
  const coordinatorChatKeys = useMemo<ReadonlySet<string> | null>(
    () => leadRecordsState === "loading" ? null : new Set(leads.map((record) => record.chatKey)),
    [leadRecordsState, leads],
  );
  const projectContextUnavailable = (!orchestrationState.snapshot && !!orchestrationState.error)
    || leadRecordsState === "error";
  const headDraftOn = agentsMode && headDraft && !conversationId && !workerChat;
  const lead = agentsMode
    ? headDraftOn ? head : team.find((agent) => agent.id === leadId) ?? team[0] ?? null
    : null;
  // Only a chat that does not exist yet is a new task. An existing one keeps
  // the model it was recorded with, empty-while-loading or not.
  const newTask = agentsMode && !conversationId && !workerChat;
  useEffect(() => {
    if (!newTask || !lead) return;
    const settings = leadSettings(lead);
    if (!settings) return;
    setChoice(settings.choice);
    setEffort(settings.effort);
    setAccess(settings.access);
  }, [newTask, lead]);
  // Agents mode: who the composer says this conversation is with. A
  // conversation handed to a lead keeps that lead — and the model it was
  // recorded with — for as long as it exists.
  const chatLead = useMemo(
    () => (conversationId ? leads.find((record) => record.chatKey === keyFor(conversationId)) ?? null : null),
    [leads, conversationId],
  );
  const composerIdentity = useMemo(() => {
    if (!agentsMode || workerChat) return null;
    if (conversationId) {
      if (!chatLead) return null;
      return agentIdentity(roster.find((agent) => agent.id === chatLead.leadId), chatLead.leadName, choice);
    }
    return lead ? agentIdentity(lead, lead.name, choice) : null;
  }, [agentsMode, workerChat, conversationId, chatLead, roster, lead, choice]);
  // Agents mode: where a new task runs, chosen automatically (lib/agentExecution).
  // The head coordinates from home; a project lead gets a new worktree. Only
  // what the person changes under Advanced overrides it.
  // The head picked from the lead chips with no code project in front of it
  // is the same coordination conversation "Talk to" opens.
  const headAtHome = newTask && headCoordination({
    headDraft: headDraftOn, leadId: lead?.id, headId: head?.id, project: project ?? null, homeId,
  });
  const executionPlan = useMemo(
    () => newTask
      ? autoExecution({
        toHead: headAtHome,
        project: project ?? null,
        homeId,
        repo: branches,
        sandboxDefault: sandboxes.snapshot?.defaultEnabled ?? false,
        overrides,
      })
      : null,
    [newTask, headAtHome, project, homeId, branches, sandboxes.snapshot?.defaultEnabled, overrides],
  );
  // The registered agent a chat belongs to — its lead, or the assignee of the
  // task a worker chat runs. It is the voice of every reply in that chat.
  const workerAssignees = useMemo(() => {
    const byChat = new Map<string, { id: string; name: string }>();
    const tasks = new Map(orchestration.tasks.map((task) => [task.id, task]));
    for (const attempt of orchestration.attempts) {
      const assignee = tasks.get(attempt.taskId)?.assignee;
      if (assignee) byChat.set(attempt.workerChatKey, assignee);
    }
    return byChat;
  }, [orchestration]);
  const personaForChat = useCallback(
    (chatKey: string) => (agentsMode ? personaFor(chatKey, leads, roster, workerAssignees) : null),
    [agentsMode, leads, roster, workerAssignees],
  );
  const persona = useMemo(
    () => agentsMode && conversationId
      ? personaFor(keyFor(conversationId), leads, roster, workerAssignees)
      : agentsMode && composerIdentity
        ? { id: composerIdentity.id, name: composerIdentity.name, avatar: composerIdentity.avatar }
        : null,
    [agentsMode, conversationId, leads, roster, workerAssignees, composerIdentity],
  );
  // Task details combine the chat's recorded launch plan, the newest worker
  // attempt, sandbox state and registered persona with live host verification.
  // Keep this at the App boundary: isolated task-panel renders cannot prove
  // that the real conversation has all of those sources wired together.
  const panelContext = useMemo(() => {
    if (!conversationId) return undefined;
    const key = keyFor(conversationId);
    const attempt = orchestration.attempts
      .filter((candidate) => candidate.workerChatKey === key)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const task = attempt ? orchestration.tasks.find((candidate) => candidate.id === attempt.taskId) : undefined;
    const held = conversations.find((conversation) => conversation.id === conversationId);
    const sandbox = Object.values(sandboxes.snapshot?.environments ?? {})
      .find((environment) => environment.chatKey === key) ?? null;
    const names = new Map([...workspaces, ...shelved].map((workspace) => [workspace.id, workspace.name]));
    return {
      launch: held?.launch ?? null,
      worker: task ? { task, attempt } : null,
      sandbox,
      projectName: (id: string) => names.get(id),
      persona,
      runsOn: persona ? `${providerFor(choice.agent).name} ${choice.model}` : undefined,
    };
  }, [conversationId, orchestration, conversations, sandboxes.snapshot, workspaces, shelved, persona, choice]);
  const pickLead = useCallback((agent: TeamAgent) => {
    setLeadId(agent.id);
    remember(LEAD_KEY, agent.id);
  }, []);
  const openAgentsSettings = useCallback(() => {
    setAgentsDashboard(false);
    setPrDashboardOpen(false);
    setProjectsPage(null);
    setSearchPage(false);
    setSettingsSection("agents");
    setAppSettings(true);
  }, []);
  // A lead's plan waiting for the person, shown above its composer.
  const plan = useMemo(
    () => (workerChat ? null : pendingPlan(orchestration, conversationId ? keyFor(conversationId) : null)),
    [orchestration, conversationId, workerChat],
  );
  const openRecord = useMemo(
    () => conversations.find((conversation) => conversation.id === conversationId),
    [conversations, conversationId],
  );
  // The chat on screen counts as read, and stays that way for as long as it
  // is the one on screen — this covers both opening it (its own `updatedAt`
  // is already older than `now`) and it picking up NEW activity while being
  // watched (an agent finishing a turn, a second device's send landing).
  //
  // The second half matters most: without it, a chat you watched finish would
  // flash unread the moment you switched away, because `readAt` was only ever
  // set once, at open. That is exactly backwards for an indicator whose whole
  // point is "activity you did NOT see" — so it re-marks on every activity
  // change while open rather than once. Scalar dependencies, not `openRecord`
  // itself, so this reacts to only ITS OWN chat's activity, not every other
  // row's.
  useEffect(() => {
    if (!openRecord || !isUnread(openRecord, null)) return;
    const id = openRecord.id;
    const at = Date.now();
    markChatRead(id, at);
    setConversations((prev) => {
      const list = prev.map((conv) => (conv.id === id ? { ...conv, readAt: at } : conv));
      saveConversations(list);
      return list;
    });
  }, [openRecord?.id, openRecord?.updatedAt, openRecord?.readAt]);
  /** A worktree chat belongs to its parent project but runs from its own cwd.
   *  Every local surface follows that exact directory: agent, Git panel,
   *  terminal, file pins and path rendering. */
  const effectiveCwd = chat.cwd ?? openRecord?.cwd ?? project?.primary_path ?? "";
  const sessionProject = useMemo<Workspace | null>(() => {
    if (!project) return null;
    return {
      ...project,
      // Terminals are keyed by project id. A worktree chat needs its own set;
      // reusing the parent's ids would reattach shells already running in the
      // primary checkout.
      id: conversationId ? `${project.id}:${conversationId}` : project.id,
      primary_path: effectiveCwd || project.primary_path,
    };
  }, [project, conversationId, effectiveCwd]);

  useEffect(() => {
    if (!project || !effectiveCwd) {
      setBranches(NO_BRANCHES);
      setBranch("");
      setNewWorktree(false);
      return;
    }

    let current = true;
    setBranches((previous) => ({ ...previous, loading: true, error: undefined }));
    bridge
      .invoke<BranchList>("git_local_branches", { path: effectiveCwd })
      .then((answer) => {
        if (!current) return;
        const next: WorkLocationBranches = {
          isRepo: !!answer?.is_repo,
          current: answer?.current ?? "",
          branches: answer?.branches ?? [],
          isWorktree: !!answer?.is_worktree,
        };
        setBranches(next);
        setBranch(next.current || next.branches[0] || "");
        if (!next.isRepo) setNewWorktree(false);
      })
      .catch((error) => {
        if (!current) return;
        setBranches({
          ...NO_BRANCHES,
          error: String((error as Error).message ?? error),
        });
        setBranch("");
        setNewWorktree(false);
      });
    return () => { current = false; };
  }, [project, effectiveCwd]);

  const chooseProject = useCallback((id: string | null) => {
    if (conversationId) return;
    // Choosing a project makes this a task in it, not the conversation with
    // the head, which belongs to no one project.
    setHeadDraft(false);
    setProjectId(id);
    setBranch("");
    setBranches(id ? { ...NO_BRANCHES, loading: true } : NO_BRANCHES);
    setNewWorktree(false);
    setOverrides({});
    setNewChatError(null);
  }, [conversationId]);
  // A page can hot-reload while an old internal record is already in state.
  // Filter at render time as well as at arrival so it disappears immediately,
  // while the rest of the notices keep their original order and dismiss action.
  const visibleNotices = useMemo(
    () => filterVisibleChatNotices(chat.notices),
    [chat.notices],
  );
  const sendingTurns = useRef(new Set<string>());
  const queueActions = useRef(new MessageQueueActions());
  const syncQueue = useCallback(async (id: string) => {
    const before = chatsRef.current[id];
    if (!before) return;
    const sending = new Set(sendingTurns.current);
    const snapshot = await bridge.invoke<ChatQueueState>("chat_queue_state", { key: keyFor(id) });
    // Exclude sends in flight at either end of the read, even if their RPC
    // finished before an older snapshot reached this client.
    const safe = { ...before, messages: before.messages.filter((m) => !m.turnId
      || (!sending.has(m.turnId) && !sendingTurns.current.has(m.turnId))) };
    patch(id, (state) => reconcileQueueSnapshot(state, safe, snapshot, (m) => !!m.turnId && queueActions.current.isPending(id, m.turnId)));
  }, [patch]);
  useEffect(() => {
    if (!conversationId || conn !== "open" || !liveKnown) return;
    const id = conversationId;
    let checking = false;
    const check = async () => {
      const state = chatsRef.current[id];
      if (checking || !state?.messages.some((m) => m.role === "user" && m.turnId
        && !m.echo && !m.takenUp && m.delivery !== "unknown" && m.delivery !== "failed")) return;
      checking = true;
      try { await syncQueue(id); } catch { /* Keep uncertain delivery visible. */ }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 2000);
    return () => clearInterval(timer);
  }, [conversationId, conn, liveKnown, syncQueue]);
  /** The failure worth showing. A chat's state is replayed from its transcript
   *  on every reload, so clearing `failure` is only ever true until the next
   *  one — the ✕ has to be REMEMBERED. See `lib/failureDismiss`; a failure
   *  that reads differently is a different failure and still gets its banner. */
  const failure =
    chat.failure && !chat.failure.inline && conversationId && !failureDismissed(conversationId, chat.failure)
      ? chat.failure
      : undefined;
  const autoResume = chat.autoResume;
  const previews = useImagePreviews(conversationId ? keyFor(conversationId) : "", chat.busy);
  const previewVisible = previews.open;
  /** The files this chat says are worth opening — see lib/pins. Read once up
   *  here rather than twice below: the button needs the count and the panel
   *  needs the list, and walking the transcript for each of them would do the
   *  same work twice. */
  const sessionFiles = useSessionPins(
    chat.messages,
    effectiveCwd,
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
    // The old process can report its model while it is being replaced. The
    // explicit picker choice owns this short handoff window.
    if (conversationId && pendingModelHandoffs.current.has(conversationId)) return;
    const match = modelFromReported(choice.agent, chat.model);
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
      if (before && !s.busy) {
        announce("done", id, lastSaid(s.messages));
        const held = conversationsRef.current.find((conversation) => conversation.id === id);
        if (!held) continue;
        const finishedAt = Date.now();
        const response = latestAgentResponse(s.messages)?.text ?? held.latestResponse;
        const completed = { ...held, latestResponse: response, updatedAt: finishedAt };
        setConversations((current) => {
          const existing = current.find((conversation) => conversation.id === id);
          if (!existing) return current;
          const next = current.map((conversation) => conversation.id === id
            ? { ...conversation, latestResponse: response, updatedAt: finishedAt }
            : conversation);
          saveConversations(next);
          return next;
        });
        saveIndexEntry({
          id: completed.id,
          projectId: completed.projectId,
          title: completed.title,
          latestResponse: completed.latestResponse,
          customTitle: completed.customTitle,
          sessionId: completed.sessionId ?? null,
          cwd: completed.cwd ?? null,
          modelId: completed.modelId ?? null,
          access: completed.permission ?? null,
          createdAt: completed.createdAt,
          updatedAt: completed.updatedAt,
          pinned: completed.pinned ?? false,
          generation: completed.generation,
        });
      }
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

  /** A new task starts in General. The location strip can bind it to a project
   *  before the first send; prompt text is never inspected for routing.
   *  The old chat stays intact as a durable record.
   *
   *  A counter rather than a flag: two new chats in a row are two requests,
   *  and a boolean's second `true` is not a change for an effect to see. The
   *  number itself means nothing. */
  const [focusBox, setFocusBox] = useState(0);
  const newChat = useCallback(() => {
    setUnavailableChat(null);
    setNewChatError(null);
    setHeadDraft(false);
    awaited.current = null;
    setProjectId(null);
    setConversationId(null);
    setBranch("");
    setBranches(NO_BRANCHES);
    setNewWorktree(false);
    setSandboxChoice(null);
    setOverrides({});
    setAdvancedOpen(false);
    setRunOpened((before) => ({ ...before, new: false }));
    setWorkflowViews((before) => ({ ...before, new: "chat" }));
    remember(LAST_KEY, "");
    setProjectsScreen(false);
    setPrDashboardOpen(false);
    setProjectsPage(null);
    setSearchPage(false);
    setAppSettings(false);
    setAgentsDashboard(false);
    setFocusBox((n) => n + 1);
  }, []);

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
        (session.model ? modelFromReported(session.agent, session.model) : undefined) ??
        MODELS.find((m) => m.agent === session.agent && !m.flag) ??
        MODELS[0];
      const kept = effortFor(session.agent, (session.effort as Effort) ?? effort);

      // The blank chat already on screen is the one to use — it is what the
      // person was looking at when they searched. A conversation that has been
      // spoken in gets a new row instead, so nothing is written over.
      const blank =
        conversationId && (chatsRef.current[conversationId]?.messages.length ?? 0) === 0;
      const id = blank ? conversationId! : crypto.randomUUID();

      const sessionAccess = accessFor(session.agent, access);
      meta.current[id] = { projectId: forProject, modelId: model.id, access: sessionAccess };
      setChoice(model);
      setEffort(kept);
      setAccess(sessionAccess);
      remember(EFFORT_KEY, kept);
      setResumed((prev) => ({ ...prev, [id]: session }));
      patch(id, (s) => ({ ...s, sessionId: session.sessionId, cwd: session.cwd }));

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
      setProjectsScreen(false);
    },
    // `chats` is read through its ref, for one length, at the moment this runs.
    [workspaces, projectId, conversationId, access, effort, patch],
  );

  const openConversation = useCallback((c: Conversation) => {
    setUnavailableChat(null);
    setNewChatError(null);
    awaited.current = null;
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
    if (!catchUp.current.holds(keyFor(c.id)) && !chatReads.current.has(c.id)) {
      const held = chatsRef.current;
      // Urgent: this is the chat being opened, so it is about to be the one on
      // screen — `visibleRef` just has not caught up with the click yet.
      writeChats(
        {
          ...held,
          [c.id]: {
            ...emptyChat(),
            messages: c.messages,
            sessionId: held[c.id]?.sessionId ?? c.sessionId,
            cwd: held[c.id]?.cwd ?? c.cwd,
          },
        },
        true,
      );
    }

    // Fill in anything this device has not seen. On the device that held the
    // conversation that is the tail of an interrupted answer; on a device that
    // has never seen it, `seq` is absent and the whole thing is replayed.
    //
    // Cached words stay readable while the latest events are fetched.
    setReading((prev) => ({ ...prev, [c.id]: true }));
    catchUpChat(c.id, c.seq)
      .catch(() => {})
      .finally(() => {
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
    setProjectsScreen(false);
    setPrDashboardOpen(false);
    setProjectsPage(null);
    setSearchPage(false);
    setAppSettings(false);
    setAgentsDashboard(false);
  }, [catchUpChat, writeChats]);

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
      if (linked) setUnavailableChat(wanted);
      restored.current = true;
      opened.current = {};
      return;
    }
    // Not here YET is not the same as gone: the server's list folds in a moment
    // after the cached one, so this waits rather than giving up.
    const found = conversations.find((c) => c.id === wanted);
    if (!found) {
      if (indexReady) {
        restored.current = true;
        opened.current = {};
        if (linked) setUnavailableChat(wanted);
      }
      return;
    }
    restored.current = true;
    opened.current = {};
    // A tapped banner with nothing of ours open lands here, through the address
    // the worker built — so it gets the same treatment as a tap on a page that
    // was already running: the chat in front, not underneath the files view it
    // was left in. A reload restores what you left, view and all.
    if (linked) onOpenChat.current(wanted);
    else openConversation(found);
  }, [conversations, conversationId, openConversation, indexReady]);

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
    setProjectsScreen(false);
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
      dismissGit();
      showFiles(false);
      closeFile();
    },
    [openConversation, dismissGit, showFiles, closeFile],
  );

  // Tapping a notification brings the window forward — this is what then puts
  // the chat it came from on screen, so the banner lands you on the thing it
  // was about rather than wherever you left off.
  onOpenChat.current = (id) => {
    const found = notifying.current.list.find((c) => c.id === id);
    if (found) showConversation(found);
    else if (indexReady) { awaited.current = null; setUnavailableChat(id); }
    else awaited.current = id;
  };

  // ...and this is that tap arriving before the list it needs. See `awaited`.
  useEffect(() => {
    const id = awaited.current;
    if (!id) return;
    const found = conversations.find((c) => c.id === id);
    if (!found) {
      if (indexReady) { awaited.current = null; setUnavailableChat(id); }
      return;
    }
    awaited.current = null;
    showConversation(found);
  }, [conversations, showConversation, indexReady]);

  // Browser history and pasted hashes navigate the single workspace directly.
  useEffect(() => {
    const navigate = () => {
      const route = readLocation();
      if (route.chat) onOpenChat.current(route.chat);
      else if (route.project) {
        const project = notifying.current.projects.find(p => p.id === route.project || projectSlug(p.name) === projectSlug(route.project!));
        if (project) {
          setUnavailableChat(null);
          setProjectId(project.id);
          setConversationId(null);
        }
      }
    };
    window.addEventListener("popstate", navigate);
    window.addEventListener("hashchange", navigate);
    return () => {
      window.removeEventListener("popstate", navigate);
      window.removeEventListener("hashchange", navigate);
    };
  }, []);

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
      const held = conversationsRef.current.find((chat) => chat.id === id);
      const deletedAt = Date.now();
      const generation = held?.generation ?? 0;
      const trashEntry: IndexEntry | undefined = held
        ? {
            id: held.id,
            projectId: held.projectId,
            title: held.title,
            customTitle: held.customTitle,
            sessionId: held.sessionId ?? null,
            cwd: held.cwd ?? null,
            modelId: held.modelId ?? null,
            access: held.permission ?? null,
            createdAt: held.createdAt,
            updatedAt: held.updatedAt,
            pinned: held.pinned ?? false,
            generation,
          }
        : undefined;
      markDeleted(id, keyFor(id), deletedAt, generation, trashEntry);
      // The record on the server is marked too — the point of deleting a chat
      // is that it leaves every device, not only this browser. Through
      // `removeIndexEntry`, which supersedes any unsent save for this chat and
      // keeps trying: a removal sent once and forgotten is a delete that can
      // quietly not happen.
      //
      // The local record stays in the list for one last visual beat. The ref
      // is set before the server can answer, so that answer cannot unmount the
      // row before its height has had a chance to animate to zero.
      leavingRef.current.add(id);
      setLeaving((prev) => new Set(prev).add(id));
      // Drop this browser's transcript copy and remember the tombstone now,
      // not after the animation. The server transcript stays in Trash for its
      // restore window; the row is only lingering here for layout.
      forgetLocally(id);
      removeIndexEntry(id, keyFor(id), generation, trashEntry);
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
      if (isWorkerChat(id, chatParents)) return;
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
    [cancelDelete, commitDelete, conversations, chatParents],
  );

  /** Pin a chat to the top of its project, or take the pin off again.
   *
   *  Both copies of the row change: the browser's, so the list moves now, and
   *  the server's, so every other device shows the same order. Saved straight
   *  away rather than through the debounced save — that one only fires when
   *  the messages change, and a pin changes none. */
  const togglePin = useCallback((id: string) => {
    const held = conversationsRef.current.find((c) => c.id === id);
    if (!held) return;
    const pinned = !held.pinned;
    saveIndexEntry({
      id: held.id,
      projectId: held.projectId,
      title: held.title,
      latestResponse: held.latestResponse,
      customTitle: held.customTitle,
      sessionId: held.sessionId ?? null,
      cwd: held.cwd ?? null,
      modelId: held.modelId ?? null,
      access: held.permission ?? null,
      createdAt: held.createdAt,
      updatedAt: held.updatedAt,
      pinned,
      generation: held.generation,
    });
    setConversations((prev) => {
      const list = prev.map((c) => (c.id === id ? { ...c, pinned } : c));
      saveConversations(list);
      return list;
    });
  }, []);

  /** Tick a chat off, or take the tick back.
   *
   *  Not saved through `saveIndexEntry` like a pin, and that is the point: the
   *  tick is server-owned, and `chat_index::upsert` deliberately ignores what
   *  a save carries for it. A save assembled a second ago — a rename, a
   *  streaming transcript write — would otherwise answer a question it was
   *  built before anyone asked.
   *
   *  Stamped with this moment so `isChatDone` can retire it against the
   *  chat's own `updatedAt`: the next message moves that past this stamp and
   *  the chat comes back on its own. */
  const toggleDone = useCallback((id: string) => {
    const held = conversationsRef.current.find((c) => c.id === id);
    if (!held) return;
    const doneAt = isChatDone(held) ? null : Date.now();
    setChatDone(id, doneAt);
    setConversations((prev) => {
      const list = prev.map((c) => (c.id === id ? { ...c, doneAt } : c));
      saveConversations(list);
      return list;
    });
  }, []);

  /** Give a chat a title chosen by the user. Like pinning, this is metadata,
   *  so save it immediately rather than waiting for another message to make
   *  the transcript-save effect run. */
  const renameConversation = useCallback((id: string, value: string) => {
    const held = conversationsRef.current.find((c) => c.id === id);
    if (!held || !value.trim()) return;
    const title = shortTitle(value);
    if (held.title === title && held.customTitle) return;
    const renamed = { ...held, title, customTitle: true };
    saveIndexEntry({
      id: renamed.id,
      projectId: renamed.projectId,
      title: renamed.title,
      latestResponse: renamed.latestResponse,
      customTitle: true,
      sessionId: renamed.sessionId ?? null,
      cwd: renamed.cwd ?? null,
      modelId: renamed.modelId ?? null,
      access: renamed.permission ?? null,
      createdAt: renamed.createdAt,
      updatedAt: renamed.updatedAt,
      pinned: renamed.pinned ?? false,
      generation: renamed.generation,
    });
    setConversations((prev) => {
      // Preserve any transcript fields that landed in the same render batch.
      const list = prev.map((c) => (c.id === id ? { ...c, title, customTitle: true } : c));
      saveConversations(list);
      return list;
    });
  }, []);

  /** Clear the server-side deletion marker and rebuild only the sidebar row.
   *  The transcript stays on the server throughout and is replayed normally
   *  when the restored chat is opened. */
  const restoreDeletedChat = useCallback(async (deleted: DeletedIndexEntry) => {
    cancelIndexRemoval(deleted.id);
    const restored = await bridge.invoke<IndexEntry | null>("chat_index_restore", {
      id: deleted.id,
    });
    if (!restored) throw new Error("This chat has passed its 24-hour restore window.");

    forgetDeletion(deleted.id);
    gone.current.delete(deleted.id);
    setDeletedChats((prev) => prev.filter((chat) => chat.id !== deleted.id));
    setConversations((prev) => {
      const cached = prev.find((chat) => chat.id === restored.id);
      const conversation: Conversation = {
        ...restored,
        sessionId: restored.sessionId ?? undefined,
        cwd: restored.cwd ?? cached?.cwd,
        modelId: restored.modelId ?? undefined,
        permission: restored.access ?? cached?.permission,
        messages: cached?.messages ?? [],
        seq: cached?.seq,
        synced: true,
      };
      const list = [conversation, ...prev.filter((chat) => chat.id !== restored.id)];
      saveConversations(list);
      return list;
    });
  }, []);

  // Closing the tab inside those seconds must not quietly forget the delete.
  // Nothing has been sent yet at that point — the transcript and index entry
  // are both still there — so a delete left half done is a delete
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
    async (
      text: string,
      attachments: Attachment[] = [],
    ) => {
      if (workerChat) return;
      // The conversation with the head belongs to no one project: it lives in
      // General, whichever project is on screen, and its lead routes each task.
      const toHead = agentsMode && headDraft && !conversationId && text.trim() !== "/clear";
      if (toHead && !head) {
        setNewChatError("No lead is set up to talk to across projects. Choose one in Settings, Agents.");
        return;
      }
      // Agents mode: the automatic plan decides where a new task runs. It is
      // captured here, at the send, so what runs is exactly what was planned.
      const plan = !conversationId && agentsMode ? executionPlan : null;
      let targetProject = toHead || plan?.target === "home" ? null : project;
      if (!targetProject) {
        // General is a visible, deliberate default. The prompt is content for
        // the agent, never a hidden routing surface: `@octiqflow` stays in the
        // message exactly as typed.
        try {
          targetProject = await ensureGeneralWorkspace();
        } catch (error) {
          setNewChatError(
            `Could not open General: ${String((error as Error).message ?? error)}`,
          );
          return;
        }
        if (!targetProject) return;
        setProjectId(targetProject.id);
        setNewChatError(null);
      }
      // Images go to the agent as pictures; anything else is named in the text
      // so the agent opens it with its own Read tool, which is better than
      // pushing a whole file into the prompt sight unseen.
      const images = attachments.filter((a) => a.isImage).map((a) => a.path);
      const files = attachments.filter((a) => !a.isImage).map((a) => a.path);
      if (files.length) {
        text = `${text}\n\nFiles to look at:\n${files.map((f) => `- ${f}`).join("\n")}`.trim();
      }
      const id = conversationId ?? crypto.randomUUID();
      // Agents mode: the first message of a new task goes to its lead with the
      // brief behind it. What the person typed still names the chat.
      const taskLead = toHead ? head : agentsMode && !conversationId && text.trim() !== "/clear" ? lead : null;
      // The head's coordination conversation is cross-project however it was
      // opened: through "Talk to", or picked as the lead at home. Its brief
      // then spans every project, and its tasks name their destinations.
      const crossProject = toHead || (!!plan?.crossProject && !!head && taskLead?.id === head.id);
      const typed = text;
      if (taskLead) {
        try {
          text = await taskBrief(keyFor(id), targetProject.id, taskLead.id, text, crossProject);
        } catch (error) {
          setNewChatError(
            `Could not hand the task to ${taskLead.name}: ${String((error as Error).message ?? error)}`,
          );
          return;
        }
        // Known at once, so the composer never flashes the model pickers
        // between the send and the next read of the record.
        const record: LeadRecord = {
          chatKey: keyFor(id), leadId: taskLead.id, leadName: taskLead.name,
          projectId: targetProject.id, crossProject: crossProject || undefined, createdAt: Date.now(),
        };
        setLeads((current) => [...current.filter((item) => item.chatKey !== record.chatKey), record]);
      }
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
        chatReads.current.delete(id);
        chatHistory.current.forget(id);
        cachedStates.current.delete(id);
        void forgetChatCheckpoint(id);
        catchUp.current.own(key);
        patch(id, (s) => ({ ...emptyChat(), sessionId: s.sessionId }));
        // The saved copy has to be emptied here rather than left to the sync
        // effect, which skips any chat with no messages — that guard is what
        // stops a brand-new chat being saved, and it also meant a cleared one
        // kept its old messages on disk and got them all back on reload.
        setConversations((prev) => {
          const list = prev.map((c) =>
            c.id === id
              ? { ...c, messages: [], seq: 0, updatedAt: Date.now() }
              : c,
          );
          saveConversations(list);
          return list;
        });
        return;
      }
      // A model choice is immediate in the UI, but a provider process may
      // still be finishing its shutdown. Do not let a fast Send fall through
      // to that old process.
      const switchTask = modelSwitches.current.get(id);
      if (switchTask) {
        try {
          await switchTask;
        } catch {
          return;
        }
      }
      const switchingModel = pendingModelHandoffs.current.has(id);
      const handoff = switchingModel
        ? modelHandoff(chatsRef.current[id]?.messages ?? [])
        : undefined;
      meta.current[id] = {
        projectId: targetProject.id,
        modelId: choice.id,
        access,
      };
      // The same files the agent is given, kept on the bubble so the message
      // shows what was sent with it. The object URLs are dropped: they are this
      // page's copy of the bytes, and a stored one points at nothing.
      const turnId = userTurnId();
      patch(id, (s) =>
        addUserTurn(
          s,
          text,
          attachments.map((a) => ({ path: a.path, name: a.name, isImage: !!a.isImage })),
          undefined,
          turnId,
        ),
      );
      sendingTurns.current.add(turnId);
      const fail = (err: unknown) =>
        patch(id, (s) => ({
          ...s,
          busy: runningRef.current.has(id) ? s.busy : false,
          messages: s.messages.map((m) => m.turnId === turnId && !m.echo && !m.takenUp
            ? { ...m, delivery: "unknown", queueError: String((err as Error).message ?? err) } : m),
        }));
      try {
        const held = conversationsRef.current.find((c) => c.id === id);
        const recordedCwd = held?.cwd ?? chatsRef.current[id]?.cwd;
        let launchCwd = recordedCwd ?? targetProject.primary_path ?? "";
        let preparationError: unknown;

        // A selected project is prepared by OctiqFlow before the provider sees
        // the first turn. Branch switching and worktree creation are therefore
        // host setup, not a question delegated to the agent.
        // A failed preparation has no recorded cwd, so retrying the message
        // comes through here again instead of silently starting in the parent
        // checkout. Once preparation succeeds its exact cwd makes this a
        // one-time operation, including when provider startup later fails.
        const prepareGit = !recordedCwd && !!project && project.id === targetProject.id && (
          plan ? plan.prepare && plan.target === "project" : projectSlug(project.name) !== "general"
        );
        const prepBranch = plan ? plan.branch : branch;
        const prepWorktree = plan ? plan.newWorktree : newWorktree;
        const sandboxPlanned = plan ? plan.useSandbox : (sandboxChoice ?? sandboxes.snapshot?.defaultEnabled ?? false);
        // What was planned, recorded once on the chat so its details can tell
        // the plan apart from what git later confirms (lib/taskEnvironment).
        const launch: LaunchPlan | undefined = held ? undefined : {
          projectId: targetProject.id,
          projectName: targetProject.name,
          path: targetProject.primary_path ?? "",
          baseBranch: prepareGit ? prepBranch || (project?.id === targetProject.id ? branches.current : "") : "",
          newWorktree: prepareGit && prepWorktree,
          useSandbox: sandboxPlanned,
          prepare: prepareGit,
          chosenBy: plan ? plan.chosenBy : "person",
          reason: plan?.reason ?? "",
          decidedAt: Date.now(),
        };
        if (prepareGit && project) {
          try {
            const prepared = await bridge.invoke<PreparedWorkspace>(
              "git_prepare_chat_workspace",
              {
                path: project.primary_path ?? "",
                branch: prepBranch,
                newWorktree: prepWorktree,
                prompt: typed,
                chatId: id,
              },
            );
            launchCwd = prepared.cwd;
            setBranch(prepared.branch);
            setBranches((previous) => ({
              isRepo: prepared.is_repo,
              current: prepared.branch,
              branches: prepared.branch && !previous.branches.includes(prepared.branch)
                ? [prepared.branch, ...previous.branches]
                : previous.branches,
              isWorktree: prepared.is_worktree,
            }));
            patch(id, (state) => ({ ...state, cwd: launchCwd }));
          } catch (error) {
            preparationError = error;
          }
        }

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
        const startedAt = Date.now();
        const activity: Conversation = rewriteConversation(held, {
          ...(held ?? ({} as Conversation)),
          id,
          projectId: targetProject.id,
          // A chat is named after the FIRST thing asked in it, so an existing one
          // keeps the name it already has.
          title: held?.title ?? shortTitle(typed),
          latestResponse: held?.latestResponse,
          customTitle: held?.customTitle,
          sessionId: chatsRef.current[id]?.sessionId ?? held?.sessionId,
          cwd: preparationError ? held?.cwd : launchCwd,
          messages: chatsRef.current[id]?.messages ?? held?.messages ?? [],
          modelId: choice.id,
          permission: access,
          createdAt: held?.createdAt ?? startedAt,
          updatedAt: startedAt,
          pinned: held?.pinned ?? false,
          generation: held?.generation,
          launch: held?.launch ?? launch,
        });
        // A user send is meaningful activity and moves the row immediately.
        // The later streaming transcript saves preserve this timestamp until
        // the agent finishes the turn and touches it once more.
        setConversations((current) => {
          const next = [activity, ...current.filter((conversation) => conversation.id !== id)];
          saveConversations(next);
          return next;
        });
        saveIndexEntry({
          id: activity.id,
          projectId: activity.projectId,
          title: activity.title,
          latestResponse: activity.latestResponse,
          customTitle: activity.customTitle,
          sessionId: activity.sessionId ?? null,
          cwd: activity.cwd ?? null,
          modelId: activity.modelId ?? null,
          access: activity.permission ?? null,
          createdAt: activity.createdAt,
          updatedAt: activity.updatedAt,
          pinned: activity.pinned ?? false,
          generation: activity.generation,
          launch: activity.launch,
        });

        if (preparationError) {
          fail(preparationError);
          return;
        }

        // Already running: this is the next turn of a conversation in flight.
        if (!switchingModel && runningRef.current.has(id)) {
          try {
            await bridge.invoke("chat_send", { key: keyFor(id), text, images, turnId });
            return;
          } catch (err) {
            if (!String((err as Error).message ?? err).includes("no such chat")) {
              fail(err);
              return;
            }
            // The preceding process exited during send. Resume below; if its
            // reaper already replaced it, the collision path sends to that one.
          }
        }

        // No process yet — a new chat, or one being picked back up. The session
        // id comes from the chat's own state if it has run this visit, and from
        // the stored conversation otherwise.
        const resume = switchingModel
          ? null
          : chatsRef.current[id]?.sessionId ??
            conversationsRef.current.find((c) => c.id === id)?.sessionId ??
            null;

        // Speaking into a chat whose record this page does not hold. A brand-new
        // one has no record to hold, so it is simply ours from here. Anything
        // else — a chat opened while the replay failed, a session picked out of
        // history — is read first, or this turn's events would fold onto a
        // conversation with a hole where its past belongs.
        if (!catchUp.current.holds(keyFor(id))) {
          if (resume)
            await catchUpChat(id, conversationsRef.current.find((c) => c.id === id)?.seq).catch(
              () => {},
            );
          else catchUp.current.own(keyFor(id));
        }

        setRunning((prev) => new Set(prev).add(id));
        try {
          await bridge.invoke("chat_start", {
            key: keyFor(id),
            cwd: launchCwd,
            useSandbox: held ? false : plan ? plan.useSandbox : (sandboxChoice ?? sandboxes.snapshot?.defaultEnabled ?? null),
            // A project can group several folders, and the chat starts in only
            // one of them. The rest are named here so the agent can reach the
            // whole project, the same way a terminal in it can.
            extraDirs: targetProject.paths ?? [],
            env: targetProject.env ?? {},
            agent: choice.agent,
            model: choice.flag || null,
            access,
            effort,
            lite,
            images,
            prompt: text,
            handoff: handoff ?? null,
            turnId,
            // Continuing an earlier conversation: the agent picks its own
            // context back up instead of being handed a transcript to read.
            resume,
          });
          if (switchingModel) pendingModelHandoffs.current.delete(id);
        } catch (err) {
          // The process is already up — this browser simply did not know about
          // it (another tab, or a session that outlived a crash). Talk to it
          // rather than reporting a collision as a failure.
          if (!switchingModel && String((err as Error).message ?? err).includes("already running")) {
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
      } finally {
        sendingTurns.current.delete(turnId);
        void syncQueue(id).catch(() => {});
      }
    },
    // NOT `chats` and NOT `conversations` — both are read through their refs
    // above, for one value each, at the moment this runs. Listing them meant a
    // new `send` on every delta of every chat, which `MessageList` takes as
    // `onSetting` and which alone was enough to make memoising it do nothing.
    [
      project,
      ensureGeneralWorkspace,
      branch,
      newWorktree,
      sandboxChoice,
      sandboxes.snapshot?.defaultEnabled,
      choice,
      access,
      effort,
      lite,
      conversationId,
      patch,
      catchUpChat,
      syncQueue,
      agentsMode,
      lead,
      head,
      headDraft,
      workerChat,
      executionPlan,
      branches,
    ],
  );

  /** Prepare a PR study/review/publication task without borrowing any of the
   * active chat's setters. The request carries its project and exact cwd; the
   * selected provider settings are captured by this callback at click time.
   *
   * Saving and starting are separate on purpose. Ticket work claims its
   * server-side action between these two phases, so a competing browser can
   * never start a second agent. Every caller still gets the same invariant:
   * the server-side chat index is durable before a process may launch. */
  const preparePullRequestChat = useCallback(async (request: PrAgentLaunch): Promise<PrPreparedAgentChat> => {
    const targetProject = workspaces.find((item) => item.id === request.projectId);
    if (!targetProject) throw new Error("The selected project is no longer available.");
    if (!request.cwd) throw new Error("The selected repository has no working directory.");

    const id = crypto.randomUUID();
    const preparedAt = Date.now();
    const launchAccess: AccessLevel = request.access ?? access;
    const preparedState = { ...emptyChat(), cwd: request.cwd };
    const activity: Conversation = {
      id,
      projectId: targetProject.id,
      title: request.title,
      customTitle: true,
      cwd: request.cwd,
      messages: [],
      modelId: choice.id,
      permission: launchAccess,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    };

    await bridge.invoke("chat_index_save", {
      meta: {
        ...activity,
        messages: undefined,
        sessionId: null,
        access: launchAccess,
        pinned: false,
        generation: 0,
      },
    });

    meta.current[id] = { projectId: targetProject.id, modelId: choice.id, access: launchAccess };
    catchUp.current.own(keyFor(id));
    patch(id, () => preparedState);
    const next = [activity, ...conversationsRef.current.filter((item) => item.id !== id)];
    conversationsRef.current = next;
    setConversations(next);
    saveConversations(next);
    let started = false;
    return {
      chatId: id,
      start: async () => {
        if (started) throw new Error("This PR agent chat has already been started.");
        started = true;
        const turnId = userTurnId();
        const startedAt = Date.now();
        const chatState = addUserTurn(chatsRef.current[id] ?? preparedState, request.prompt, [], startedAt, turnId);
        patch(id, () => chatState);
        const startedConversations = conversationsRef.current.map((conversation) => conversation.id === id
          ? { ...conversation, messages: chatState.messages, updatedAt: startedAt }
          : conversation);
        conversationsRef.current = startedConversations;
        setConversations(startedConversations);
        saveConversations(startedConversations);
        sendingTurns.current.add(turnId);
        setRunning((before) => new Set(before).add(id));

        try {
          await bridge.invoke("chat_start", {
            key: keyFor(id),
            cwd: request.cwd,
            extraDirs: targetProject.paths ?? [],
            env: targetProject.env ?? {},
            agent: choice.agent,
            model: choice.flag || null,
            access: launchAccess,
            effort,
            lite,
            images: [],
            prompt: request.prompt,
            handoff: null,
            turnId,
            resume: null,
          });
        } catch (error) {
          const why = String((error as Error)?.message ?? error);
          patch(id, (state) => ({
            ...state,
            busy: false,
            messages: state.messages.map((message) => message.turnId === turnId
              ? { ...message, delivery: "unknown", queueError: why }
              : message),
            notices: [...state.notices, `Could not start this PR agent: ${why}`].slice(-8),
          }));
          setRunning((before) => {
            const after = new Set(before);
            after.delete(id);
            return after;
          });
          throw error;
        } finally {
          sendingTurns.current.delete(turnId);
        }
      },
    };
  }, [workspaces, choice, access, effort, lite, patch]);

  // Use the ordinary send/resume path after switching to the coordinator;
  // a gate answer must also reach an idle main chat and appear in its history.
  useEffect(() => {
    if (!pendingGateDecision || pendingGateDecision.id !== conversationId || workerChat) return;
    setPendingGateDecision(null);
    void send(pendingGateDecision.text);
  }, [pendingGateDecision, conversationId, workerChat, send]);

  /** Stop the running turn. The session survives, ready for the next one. */
  const stop = useCallback(() => {
    if (!conversationId || !runningRef.current.has(conversationId)) return;
    patch(conversationId, (s) => ({ ...s, stopping: true }));
    bridge.invoke("chat_interrupt", { key: keyFor(conversationId) }).catch(() => {});
  }, [conversationId, patch]);

  const actOnQueue = useCallback((turnId: string, action: "start" | "cancel") => {
    if (!conversationId || conn !== "open") return;
    const id = conversationId;
    void queueActions.current.run({
      chatId: id, turnId, action,
      read: () => chatsRef.current[id] ?? EMPTY,
      patch: (update) => patch(id, update),
      invoke: (command) => bridge.invoke(command, { key: keyFor(id), turnId }),
      refresh: async () => {
        await catchUpChat(id);
        await syncQueue(id);
      },
      reclaim: (message) => reclaim(id, turnId, message),
    });
  }, [conversationId, conn, patch, catchUpChat, syncQueue, reclaim]);
  const cancelQueued = useCallback((turnId: string) => actOnQueue(turnId, "cancel"), [actOnQueue]);
  const startQueued = useCallback((turnId: string) => actOnQueue(turnId, "start"), [actOnQueue]);

  const restoreUnsent = useCallback((turnId: string) => {
    if (!conversationId) return;
    const state = chatsRef.current[conversationId];
    if (!state?.messages.some((m) => m.turnId === turnId && (m.queueLost || m.delivery === "unknown") && !m.echo && !m.takenUp)) return;
    const message = state.messages.find((m) => m.turnId === turnId);
    if (message) setReclaimed((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] ?? []), reclaimedMessage(message)] }));
  }, [conversationId]);

  const dismissUnsent = useCallback((turnId: string) => {
    if (!conversationId) return;
    const id = conversationId;
    const state = chatsRef.current[id];
    if (!state?.messages.some((m) => m.turnId === turnId && m.queueLost && !m.echo && !m.takenUp)) return;
    bridge
      .invoke("chat_dismiss_unsent", { key: keyFor(id), turnId })
      .then((dismissed) => {
        if (dismissed === false) return;
        // The backend announcement removes this in every open client. Apply
        // the same fold locally after its durable write so the click does not
        // depend on the broadcast winning a race with the command reply.
        patch(id, (s) => ({
          ...s,
          messages: s.messages.filter((m) => m.turnId !== turnId),
        }));
      })
      .catch((err) =>
        patch(id, (s) => ({ ...s, notices: [...s.notices, String((err as Error).message ?? err)] })),
      );
  }, [conversationId, patch]);

  /** Tell a running Claude session to change effort, using the same slash
   *  command you would type yourself (`/effort high`).
   *
   *  Both are reported in the session's own `slash_commands` list, so this is
   *  the agent's supported way to change them — and it keeps the conversation:
   *  the alternative is killing the process, which is a heavy price for
   *  changing effort halfway through a thought. Returns whether it was sent. */
  const tellSession = useCallback(
    (command: string): boolean => {
      if (!conversationId || !runningRef.current.has(conversationId)) return false;
      const turnId = userTurnId();
      // Show it in the transcript. It IS a turn — the agent answers it — and a
      // setting that changed with no trace is a setting you cannot trust.
      patch(conversationId, (st) => addUserTurn(st, command, [], undefined, turnId));
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
      if (c.id === previous.id) return;
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
      if (conversationId && meta.current[conversationId]) {
        meta.current[conversationId].modelId = c.id;
      }

      // An untouched chat simply starts with the new choice.
      if (!conversationId || chat.messages.length === 0) return;

      const id = conversationId;
      const oldSessionId = chatsRef.current[id]?.sessionId ??
        conversationsRef.current.find((conversation) => conversation.id === id)?.sessionId;
      pendingModelHandoffs.current.add(id);

      const setStoredTarget = (model: ModelChoice, sessionId?: string) => {
        setConversations((current) => {
          const list = current.map((conversation) => conversation.id === id
            ? { ...conversation, modelId: model.id, sessionId }
            : conversation);
          saveConversations(list);
          return list;
        });
      };
      const clearNativeSession = () => {
        const target = modelFromId(meta.current[id]?.modelId ?? null) ?? c;
        patch(id, (state) => ({
          ...state,
          sessionId: undefined,
          model: target.flag || undefined,
          modelAsked: false,
          commands: undefined,
          contextTokens: undefined,
          contextWindow: undefined,
        }));
      };

      // Persist the application-level choice immediately. The provider's old
      // session id must never be resumed by a different model after a reload.
      setStoredTarget(c);
      clearNativeSession();

      // Repeated choices while the same stop is in flight only change the
      // target model. One provider process needs one stop.
      if (modelSwitches.current.has(id)) return;
      const stop = (runningRef.current.has(id)
        ? bridge.invoke("chat_retarget", { key: keyFor(id) })
        : Promise.resolve())
        .then(() => {
          setRunning((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          // Ignore any final init/status line the old process emitted while it
          // was closing. The explicit picker choice remains authoritative.
          clearNativeSession();
        })
        .catch((error) => {
          pendingModelHandoffs.current.delete(id);
          setChoice(previous);
          remember(CHOICE_KEY, previous.id);
          setAccess(access);
          remember(ACCESS_KEY, access);
          setEffort(effort);
          remember(EFFORT_KEY, effort);
          if (meta.current[id]) meta.current[id].modelId = previous.id;
          setStoredTarget(previous, oldSessionId);
          patch(id, (state) => ({
            ...state,
            sessionId: oldSessionId,
            model: previous.flag || state.model,
            notices: [...state.notices, `Could not switch models: ${String((error as Error)?.message ?? error)}`].slice(-8),
          }));
          throw error;
        })
        .finally(() => modelSwitches.current.delete(id));
      modelSwitches.current.set(id, stop);
    },
    [chat.messages.length, effort, access, choice, conversationId, patch],
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
   *  work. The fallback is for the gap this repo's two-speed deploy opens:
   *  `web/dist` is
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
   *  (see agent_chat.rs). Codex app-server applies the new policy to its next
   *  native turn on the same process.
   *
   *  Not every change can be made in place — the agent refuses to turn its own
   *  permissions off part-way, and says so — so `restartForAccess` is still
   *  there for the ones that cannot. Nothing running is the easy case: the next
   *  message starts an agent on the new level anyway. */
  const interruptedIds = useInterruptedChats({
    chats, running, known: liveKnown && conn === "open",
  });

  // A missing worker is an implementation detail, not a state the person has
  // to repair. Treat the composer as idle; its normal send path starts a new
  // process with this conversation's saved session id.
  const cutOff = !!conversationId && interruptedIds.has(conversationId);

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

  const ensureCoordinator = async (objective: string): Promise<string> => {
    if (!project) throw new Error("Choose a project before starting a run.");
    if (workerChat) throw new Error("Start runs from the main chat.");
    if (choice.agent === "pi") throw new Error("Choose Codex or Claude as the main agent.");
    const id = conversationId ?? crypto.randomUUID();
    const switching = modelSwitches.current.get(id);
    if (switching) await switching;
    if (chatsRef.current[id]?.busy) throw new Error("Wait for the main agent's turn to finish before starting a run.");
    const held = conversationsRef.current.find((item) => item.id === id);
    const now = Date.now();
    const activity: Conversation = {
      ...(held ?? {}), id, projectId: project.id, title: held?.title ?? shortTitle(objective),
      cwd: held?.cwd ?? chatsRef.current[id]?.cwd ?? project.primary_path,
      sessionId: pendingModelHandoffs.current.has(id) ? undefined : chatsRef.current[id]?.sessionId ?? held?.sessionId,
      messages: chatsRef.current[id]?.messages ?? held?.messages ?? [], modelId: choice.id, permission: access,
      createdAt: held?.createdAt ?? now, updatedAt: now,
    };
    // Await the durable index: the host must be able to recover this chat even
    // if provider startup fails or the browser disconnects immediately.
    await bridge.invoke("chat_index_save", { meta: {
      ...activity, messages: undefined, sessionId: activity.sessionId ?? null,
      access, pinned: activity.pinned ?? false, generation: activity.generation ?? 0,
    } });
    meta.current[id] = { projectId: project.id, modelId: choice.id, access };
    const next = [activity, ...conversationsRef.current.filter((item) => item.id !== id)];
    conversationsRef.current = next;
    setConversations(next); saveConversations(next);
    if (!held) catchUp.current.own(keyFor(id));
    patch(id, (state) => ({ ...state, cwd: activity.cwd }));
    setRunOpened((before) => ({ ...before, [id]: true }));
    setWorkflowViews((before) => ({ ...before, [id]: "run" }));
    setConversationId(id);
    return keyFor(id);
  };

  const startWorkflowMaster = async (run: OrchestrationRun): Promise<void> => {
    const id = run.coordinatorChatKey.replace(/^chat:/, "");
    const switching = modelSwitches.current.get(id);
    if (switching) await switching;
    const switchingProvider = pendingModelHandoffs.current.has(id);
    const handoff = switchingProvider ? modelHandoff(chatsRef.current[id]?.messages ?? []) ?? "[]" : undefined;
    await bridge.invoke("orchestration_master_start", {
      actorChatKey: run.coordinatorChatKey, runId: run.id,
      agent: choice.agent, model: choice.flag || null, access, effort, lite, handoff: handoff ?? null,
    });
    if (switchingProvider) pendingModelHandoffs.current.delete(id);
    setRunning((previous) => new Set(previous).add(id));
  };

  const openWorkflowChat = (chatKey: string, message?: string) => {
    const id = chatKey.replace(/^chat:/, "");
    const conversation = conversationsRef.current.find((item) => item.id === id);
    if (!conversation) throw new Error("This chat is not available yet. Wait for the chat list to sync and try again.");
    if (message) {
      if (isWorkerChat(id, chatParents)) throw new Error("Send this decision in the main chat.");
      setPendingGateDecision({ id, text: message });
    }
    setWorkflowViews((before) => ({ ...before, [id]: "chat" }));
    openConversation(conversation);
  };

  // Agents mode's creation action always prepares a new cross-project CTO
  // conversation. Existing conversations remain ordinary sidebar navigation;
  // conflating the two made "New conversation" silently reopen the last one.
  const startHeadConversation = async () => {
    // Re-read the configured head: it may have changed on another device.
    const configured = await loadHead().catch(() => head);
    setHead(configured);
    if (!configured) {
      openAgentsSettings();
      return;
    }
    newChat();
    setHeadDraft(true);
  };

  const prDashboardChats = useMemo<PrDashboardChat[]>(
    () => conversations
      .filter((conversation) => !isWorkerChat(conversation.id, chatParents))
      .map(({ id, title, projectId: chatProjectId, cwd }) => ({
        id,
        title,
        projectId: chatProjectId,
        cwd,
        busy: chats[id]?.busy ?? running.has(id),
      })),
    [conversations, chatParents, chats, running],
  );

  const openPullRequestChat = useCallback((id: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === id);
    if (!conversation) return;
    openConversation(conversation);
  }, [openConversation]);

  if (conn === "unauthorized") return <Connect />;


  /** Opens one main-area page in place of the chat, closing any other. */
  const showPage = (page: "search" | "projects" | "settings" | "agents" | "pulls") => {
    setProjectsScreen(false);
    setPrDashboardOpen(page === "pulls");
    setProjectsPage(page === "projects" ? { projectId: null } : null);
    setSearchPage(page === "search");
    setAppSettings(page === "settings");
    setAgentsDashboard(page === "agents");
  };

  // The bar keeps only the live workspace instruments visible. Everything
  // else has one stable home in the overflow at every width.
  const topbarDirectActions = !mainPage ? (
    <>
      {conversationId && <PreviewButton count={previewSlots(previews.images).length} open={previews.open} onClick={() => previews.setOpen(!previews.open)} />}
      {sessionProject && <GitButton project={sessionProject} open={gitOpen && !previewVisible} onToggle={() => { previews.setOpen(false); showGit(previewVisible || !gitOpen); }} />}
      {project && !unavailableChat && <FocusModeButton onClick={enterFocus} />}
    </>
  ) : null;

  const topbarOverflowActions = (
    <>
      {!agentsMode && <button
        className="icon-btn new-chat"
        type="button"
        aria-label="Start new task"
        title="Start new task"
        onClick={newChat}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="topbar-action-label">New task</span>
      </button>}

      {!mainPage && <>
        {conversationId && <ChatTaskBar
          action
          chatId={conversationId}
          connected={conn === "open"}
          context={panelContext}
          busy={chat.busy && !cutOff}
          waiting={
            (questions[conversationId]?.length ?? 0) +
              (asks[conversationId]?.length ?? 0) +
              (safetyBlocks[conversationId]?.length ?? 0) >
            0
          }
        />}
        <RailButton count={chat.agents.length} open={!railShut && !previewVisible}
          onToggle={() => { previews.setOpen(false); showRail(previewVisible || railShut); }} />
        <FilesButton count={sessionFiles.length} open={filesOpen && !previewVisible}
          onToggle={() => { previews.setOpen(false); showFiles(previewVisible || !filesOpen); }} />
        {wide && isMobile && <FullscreenButton expanded={chatExpanded} onToggle={toggleChatWidth} />}
        {!agentsMode && !workerChat && <button className={`orch-toggle${workflowView === "run" && workflowVisible ? " is-on" : ""}`} type="button"
          title={runWorkflow.runs.length ? "Open this chat's runs" : "Start a supervised run"}
          aria-label={runWorkflow.runs.length ? "Open this chat's runs" : "Start a supervised run"} onClick={() => {
          setRunOpened((before) => ({ ...before, [workflowKey]: true }));
          showWorkflowView("run");
        }}><span className="topbar-action-label">Run</span></button>}
      </>}
      {/* Only drawn for a home-screen app, which has no browser chrome. */}
      <InstalledReload />
      {!mainPage && conversationId && <CopyChatIdButton chatId={conversationId} />}
      {!mainPage && conversationId && !workerChat && <>
        <span className="topbar-actions-separator" role="separator" />
        <ChatDeleteButton deleting={deleting.has(conversationId)} disabled={leaving.has(conversationId)}
          deleteMs={UNDO_MS} onDelete={() => deleteConversation(conversationId)} />
      </>}
    </>
  );

  const pendingApprovals = [conversationId, ...workerRequestIds].reduce((count, id) =>
    count + (id ? (asks[id]?.length ?? 0) + (safetyBlocks[id]?.length ?? 0) + (questions[id]?.length ?? 0) : 0), 0);

  return (
    <WorkspaceSlotsContext.Provider value={workspaceSlots}>
    <AgentRosterContext.Provider value={agentsMode ? roster : NO_ROSTER}>
    <ChatPersonaContext.Provider value={personaForChat}>
    <div
      ref={projectSwipeRef}
      className={`app ${showingProjects ? "projects-screen" : ""} ${navShut ? "nav-shut" : ""} ${chatExpanded ? "chat-wide" : ""} ${focusMode ? "focus-mode" : ""}`}
    >
      {focusMode && <FocusModeButton active onClick={exitFocus} />}
      {/* Two columns: the chat list runs the full height of the window on the
          left, and the top bar belongs to the workspace on the right. On a
          phone `.shell-main` dissolves (display: contents) and the list is a
          screen of its own again — see `.app.projects-screen`. */}
      <Sidebar
        projects={workspaces}
        shelved={shelved}
        deletedCount={deletedChats.length}
        onShowDeleted={() => setTrashOpen(true)}
        conversations={taskList}
        chatParents={chatParents}
        orchestration={orchestration}
        ledgerSnapshot={orchestrationState.snapshot}
        ledgerUnavailable={projectContextUnavailable}
        coordinatorChatKeys={coordinatorChatKeys}
        getPreviewMessages={(id) => catchUp.current.holds(keyFor(id)) ? chats[id]?.messages : undefined}
        loadPreview={loadPreview}
        currentConversation={conversationId}
        running={running}
        busy={busySet}
        deleting={deleting}
        leaving={leaving}
        deleteMs={UNDO_MS}
        onPickConversation={(conversation) => {
          openConversation(conversation);
        }}
        onNewChat={agentsMode ? () => void startHeadConversation() : newChat}
        newLabel={agentsMode ? "New conversation" : "New task"}
        allowEmptyCreate={!agentsMode}
        onDelete={deleteConversation}
        onPin={togglePin}
        onToggleDone={toggleDone}
        onRename={renameConversation}
        onArchiveWorker={async (attemptId, archived) => {
          const attempt = orchestration.attempts.find((item) => item.id === attemptId);
          const run = orchestration.runs.find((item) => item.id === attempt?.runId);
          if (!run) throw new Error("This worker's run is unavailable. Reconnect and try again.");
          await bridge.invoke("orchestration_worker_archive", {
            actorChatKey: run.coordinatorChatKey, attemptId, archived,
          });
        }}
        branches={projectBranches}
        onResize={isMobile ? undefined : nav.startDrag}
        onCollapse={isMobile ? undefined : () => {
          showNav(false);
          // The button that was pressed is leaving; keep keyboard focus on
          // the one that brings it back.
          requestAnimationFrame(() => navButton.current?.focus());
        }}
        onSearch={() => showPage("search")}
        onSettings={() => showPage("settings")}
        onAgents={agentsMode ? () => showPage("agents") : undefined}
        onProjects={() => showPage("projects")}
        onPullRequests={() => showPage("pulls")}
        activeView={searchPage ? "search" : projectsPage ? "projects" : agentsDashboard && agentsMode ? "agents"
          : prDashboardOpen ? "pulls" : appSettings ? "settings" : null}
      />
      <div className="shell-main">
      {/* The workspace's ONE top bar. The app's name and logo belong to the
          sidebar's head; this bar names the page — a page's title and way
          back come from the page itself (WorkspaceHeader), a chat's from its
          project and run — and carries the actions for what is on screen. */}
      <header className="topbar">
        <div className="topbar-leading">
          {showingProjects ? (
            // A phone's chat list: the sidebar's head is hidden there, so the
            // app's mark is drawn here instead of twice.
            <button className="topbar-title topbar-brand" type="button" aria-label="Show Chats menu"
              aria-controls="chats-navigation" title="Show Chats menu" onClick={() => {
                const scroller = document.querySelector<HTMLElement>(".task-chat-scroll");
                scroller?.scrollTo({ top: 0, behavior: "auto" });
                requestAnimationFrame(() => document.querySelector<HTMLElement>(".sidebar-new-chat")?.focus({ preventScroll: true }));
              }}>
              <img className="topbar-logo" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" aria-hidden="true" />
              <span className="topbar-identity">
                <span className="topbar-name">Chats</span>
                <span className="topbar-version">OctiqFlow v{__APP_VERSION__}</span>
              </span>
            </button>
          ) : (isMobile || navShut) && (
            // The way back to the chat list when it is not on screen: the
            // list's own screen on a phone, the put-away column on a desktop.
            // The column's mark rides on this button while it is away, so the
            // app is named once whichever way the sidebar is.
            <button
              ref={navButton}
              className={`topbar-nav${isMobile ? "" : " is-brand"}`}
              type="button"
              aria-label={isMobile ? "Show chats" : "Show sidebar"}
              title={isMobile ? "Show chats" : `Show sidebar · OctiqFlow v${__APP_VERSION__}`}
              aria-expanded={false}
              disabled={!isMobile && chatExpanded}
              onClick={() => {
                if (isMobile) {
                  setChatWide(false);
                  setProjectsScreen(true);
                } else {
                  showNav(true);
                  requestAnimationFrame(() => document.querySelector<HTMLElement>(".sidebar-collapse")?.focus());
                }
              }}
            >
              {!isMobile && <img className="topbar-nav-logo" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" aria-hidden="true" />}
              <svg className="topbar-nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M13 10l2 2-2 2" />
              </svg>
            </button>
          )}
          {/* A page's heading renders into this (components/WorkspaceHeader). */}
          <div className="topbar-page" ref={setHeadingSlot} hidden={!mainPage || showingProjects} />
          {!showingProjects && !mainPage && (
            <span className="topbar-chat" title={project?.primary_path}>
              {project && <ProjectAvatar project={project} size="small" className="topbar-project-avatar" />}
              <span className="topbar-name">{project?.name ?? (conversationId ? "Chat" : agentsMode ? (head?.name ?? "CTO") : "New chat")}</span>
            </span>
          )}
          {/* A chat's run line — its title and the Tasks/Chat views — renders
              into this on wider screens (components/ChatWorkflowBar). */}
          <div className="topbar-context" ref={setContextSlot} hidden={mainPage || showingProjects} />
          <ConnectionStatus state={conn} />
        </div>

        <div className="topbar-actions">
          {!isMobile && <div className="topbar-page-actions" ref={setActionsSlot} hidden={!mainPage} />}
          {showingProjects ? (
            <button className="projects-return" type="button"
              aria-label="Return to chat"
              title="Return to chat"
              onClick={() => setProjectsScreen(false)}>
              <span>Return to chat</span>
              <svg className="projects-return-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
            </button>
          ) : <TopbarActionLayout directActions={topbarDirectActions} overflowActions={topbarOverflowActions} />}
          {/* Plan usage, at every width: one small number that opens the full
              breakdown. Mounted once, outside the actions menu, because it
              polls a rate-limited endpoint and a second copy would double it. */}
          {!showingProjects && <Usage />}
        </div>
      </header>

      {/* `id` so the file panel can render INTO this row from where its state
          lives, which is above the whole app — see components/OpenFile. It has
          to be a sibling of the views to take width from them, and nothing that
          opens a file is anywhere near them in the tree. */}
      <div className="body" id="dock">

        <main className="main" hidden={showingProjects} ref={pane}>
          {prDashboardOpen && <PullRequestsDashboard
            projects={workspaces}
            initialProjectId={projectId}
            chats={prDashboardChats}
            agent={{
              provider: providerFor(choice.agent).name,
              model: choice.model,
              access: providerAccessLabel(choice.agent, access),
            }}
            connected={conn === "open"}
            onClose={() => setPrDashboardOpen(false)}
            onPrepareChat={preparePullRequestChat}
            onOpenChat={openPullRequestChat}
          />}
          {projectsPage && <ProjectsPage
            projects={workspaces}
            shelved={shelved}
            conversations={conversations}
            selectedProjectId={projectsPage.projectId}
            busy={busySet}
            chatParents={chatParents}
            ledgerSnapshot={orchestrationState.snapshot}
            coordinatorChatKeys={coordinatorChatKeys}
            allowNewTask={!agentsMode}
            onSelectProject={(id) => setProjectsPage({ projectId: id })}
            onOpenChat={openConversation}
            onNewTask={(id) => {
              newChat();
              setProjectId(id);
            }}
            onNewProject={() => setSettingsFor("new")}
            onProjectSettings={setSettingsFor}
            onShowShelved={() => setShelfOpen(true)}
            onRestoreProject={async (id) => {
              await bridge.invoke("set_workspace_shelved", { id, shelved: false });
              await loadWorkspaces();
            }}
            onClose={() => setProjectsPage(null)}
          />}
          {searchPage && <ChatSearchPage
            conversations={taskList}
            chatParents={chatParents}
            projects={[...workspaces, ...shelved]}
            ledgerSnapshot={orchestrationState.snapshot}
            ledgerUnavailable={projectContextUnavailable}
            coordinatorChatKeys={coordinatorChatKeys}
            searchChats={searchChats}
            onOpenChat={openConversation}
            onClose={() => setSearchPage(false)}
            deletedCount={deletedChats.length}
            onShowDeleted={() => setTrashOpen(true)}
          />}
          {/* Settings and the Agents dashboard are pages like the ones above.
              A project's own sheet (ProjectSettings) still opens over them. */}
          {appSettings && (
            <Settings
              current={themeId}
              onPick={setThemeId}
              notify={notifyOn}
              onNotify={(on, viaPush) => {
                setNotifyOn(on);
                setPushOn(on && viaPush);
              }}
              projects={[...workspaces, ...shelved]}
              onProject={setSettingsFor}
              agentsMode={agentsMode}
              onAgentsMode={changeAgentsMode}
              onFeedback={() => setFeedbackOpen(true)}
              initialSection={settingsSection}
              onClose={() => { setAppSettings(false); setSettingsSection("projects"); }}
            />
          )}

          {agentsDashboard && agentsMode && (
            <AgentsDashboard
              snapshot={orchestrationState.snapshot}
              ledgerError={orchestrationState.error}
              connected={conn === "open"}
              projects={[...workspaces, ...shelved]}
              running={running}
              busy={busySet}
              waitingOn={(chatKey) => {
                const id = chatKey.replace(/^chat:/, "");
                return (asks[id]?.length ?? 0) + (questions[id]?.length ?? 0) + (safetyBlocks[id]?.length ?? 0);
              }}
              chatTitle={(chatKey) => conversations.find((c) => keyFor(c.id) === chatKey)?.title}
              chatExists={(chatKey) => conversations.some((c) => keyFor(c.id) === chatKey)}
              // Both throw when the chat is not in this browser's list yet;
              // the page says so and stays put.
              onOpenChat={(chatKey) => {
                openWorkflowChat(chatKey);
                setAgentsDashboard(false);
              }}
              onOpenRun={(chatKey, runId) => {
                openWorkflowChat(chatKey);
                const id = chatKey.replace(/^chat:/, "");
                setRunOpened((before) => ({ ...before, [id]: true }));
                setWorkflowViews((before) => ({ ...before, [id]: "run" }));
                setDisplayedRuns((before) => ({ ...before, [chatKey]: runId }));
                setAgentsDashboard(false);
              }}
              onManage={openAgentsSettings}
              onClose={() => setAgentsDashboard(false)}
            />
          )}
          <div className="chat-app-surface" hidden={mainPage}>
          {unavailableChat ? <div className="hero" role="status"><h1 className="hero-title">Chat unavailable</h1><p>This chat was deleted or is no longer in this profile. Choose another chat from the chat list.</p></div> : <>
          {(!workerChat || workflowVisible) && <ChatWorkflowBar snapshot={runWorkflow} orchestrated={workflowVisible} view={workflowView} focusMode={focusMode} split={workflowSplit}
            unified={workflowVisible} selectedRun={displayedRun} worker={workerChat}
            // One way back at a time: while the run panel is on screen its
            // Main agent chat button is that way, so the bar does not repeat it.
            onBackToMain={workerChat && (workerCoordinatorKey ?? runChatKey) && !(workflowVisible && (workflowSplit || workflowView === "run"))
              ? () => openWorkflowChat((workerCoordinatorKey ?? runChatKey)!) : undefined}
            planPending={!!plan}
            pendingApprovals={pendingApprovals}
            onView={showWorkflowView} />}
          <div className={`workflow-surfaces${workflowSplit ? " is-split" : ""}`}>
          {workflowVisible && <div className="workflow-run-surface" hidden={!workflowSplit && workflowView !== "run"}
            style={{ "--run-w": `${runDock.width}px` } as React.CSSProperties}>
            {workflowSplit && <div className="workflow-run-resizer" role="separator" aria-orientation="vertical"
              aria-label="Resize the run column" onPointerDown={runDock.startDrag} />}
            <OrchestrationPanel embedded sharedHeading project={project} coordinatorKey={runChatKey}
              allowManualRun={!agentsMode}
              // Cards for the main chat and its workers render in the main
              // chat, so only there does its button carry them.
              pendingApprovals={workerChat ? 0 : pendingApprovals}
              projectName={(id) => [...workspaces, ...shelved].find((item) => item.id === id)?.name}
              onSelectedRunChange={onSelectedRunChange}
              coordinatorBusy={!workerChat && chat.busy && !cutOff}
              currentChatKey={conversationId ? keyFor(conversationId) : null}
              initialSnapshot={orchestration} currentCwd={effectiveCwd}
              onEnsureCoordinator={ensureCoordinator} onStartMaster={startWorkflowMaster}
              onOpenChat={openWorkflowChat} onClose={() => showWorkflowView("chat")}
              setupContext={<div className="workflow-setup-context">
                <label>Project<select aria-label="Run project" value={project?.id ?? ""} disabled={!!conversationId} onChange={(event) => chooseProject(event.target.value || null)}>
                  <option value="">Choose a project</option>
                  {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select></label>
                <label>Main agent<select aria-label="Main agent" value={choice.id} onChange={(event) => {
                  const model = MODELS.find((item) => item.id === event.target.value); if (model) changeModel(model);
                }}>
                  {choice.agent === "pi" && <option value={choice.id} disabled>Choose Codex or Claude</option>}
                  {MODELS.filter((item) => item.agent !== "pi" && (!installed || installed.includes(item.agent))).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
                </select></label>
                <p>Keep talking in Chat. Worker providers are independent of the main agent.</p>
              </div>} />
          </div>}
          <div className="workflow-chat-surface" hidden={!workflowSplit && workflowView === "run"}>
          {conversationId && reading[conversationId] && chat.messages.length > 0 && (
            <div className="chat-sync-note" role="status">Updating conversation…</div>
          )}
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
          ) : chat.messages.length === 0 && workerChat ? (
            <div className="hero"><h1 className="hero-title">Agent conversation</h1><p className="hero-sub">The agent's progress will appear here. Send instructions in the main chat.</p></div>
          ) : chat.messages.length === 0 && currentWorkflow.runs.length > 0 ? (
            <div className="hero"><h2 className="hero-title">Main chat</h2><p className="hero-sub">Talk with the main agent here. Select a task to follow its conversation.</p></div>
          ) : chat.messages.length === 0 ? (
            <div className={`hero ${project ? "" : "hero-start"}`}>
              <h1 className="hero-title">{headDraftOn
                ? (head ? `Talk to ${head.name}` : "Choose who you talk to")
                : newTask
                ? (project ? `What's the task in ${project.name}?` : "What's the task?")
                : project ? `What do you want to do in ${project.name}?` : "What should we work on?"}</h1>
              {headDraftOn && (head ? (
                <p className="hero-sub">
                  {head.role ? `${head.role}. ` : ""}Works across every project: picks the project, repository and teammate for each part, and you approve the plan before anyone starts.
                </p>
              ) : (
                <p className="hero-sub">
                  No lead is set up to talk to across projects. <button type="button" className="hero-link" onClick={openAgentsSettings}>Choose one in Settings</button>
                </p>
              ))}
              {(!project || newTask) && (
                newChatError && <p className="hero-route-error" role="alert">{newChatError}</p>
              )}
              {newTask && !headDraftOn && (
                <LeadPicker team={team} leadId={lead?.id ?? null} onPick={pickLead} onManage={openAgentsSettings} />
              )}
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
              {project && !workerChat && <SessionSearch projectPath={effectiveCwd} onResume={resumeHistory} />}
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
              <PathCwdProvider value={effectiveCwd}>
                {/* Which cards are still waiting on work they started. Read
                    four levels down, past a grouping pass that rebuilds its
                    rows — see components/Background. */}
                <BackgroundProvider value={runningCalls}>
                  <div className="chat-main">
                    <MessageList
                      messages={chat.messages}
                      hasEarlier={!!conversationId && chatHistory.current.hasEarlier(conversationId)}
                      loadingEarlier={!!conversationId && !!earlierReads[conversationId]?.loading}
                      earlierError={conversationId ? earlierReads[conversationId]?.error : undefined}
                      onLoadEarlier={loadEarlier}
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
                      hostName={senderName(persona, providerFor(choice.agent).name)}
                      hostPersona={persona}
                      onCancelQueued={!workerChat && conn === "open" ? cancelQueued : undefined}
                      onStartQueued={!workerChat && conn === "open" ? startQueued : undefined}
                      onRestoreUnsent={workerChat ? undefined : restoreUnsent}
                      onDismissUnsent={workerChat ? undefined : dismissUnsent}
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
                      onSetting={workerChat ? undefined : send}
                      agentByTool={agentByTool}
                      onOpenAgent={setFocusedAgent}
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

          {(failure || autoResume) && conversationId && (
            <div className={`failure ${failure?.outOfCredit || autoResume ? "is-quota" : ""}`} role="alert">
              {/* Read, and now done with. Speaking again clears it too, but the
                  failure people actually sit with is a quota one — where the
                  answer is to WAIT, and asking again just puts the same banner
                  back. Without this the only way past it was to leave the
                  chat. Written down as well as cleared, because a reload
                  replays the transcript that produced it. */}
              {failure && !autoResume && (
                <button
                  className="failure-close"
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => {
                    dismissFailure(conversationId, failure);
                    patch(conversationId, (s) => ({ ...s, failure: undefined }));
                  }}
                >
                  ×
                </button>
              )}
              <div className="failure-title">{failure?.title ?? "Auto-resume scheduled"}</div>
              {failure?.detail && <div className="failure-detail">{failure.detail}</div>}
              {autoResume && (
                <div className="auto-resume-row">
                  <span>
                    OctiqFlow will resume this {autoResume.agent === "claude" ? "Claude" : autoResume.agent === "codex" ? "Codex" : "Pi"} session around{" "}
                    {new Date(autoResume.runAt * 1000).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}.
                  </span>
                  {!workerChat && <button
                    className="auto-resume-cancel"
                    type="button"
                    onClick={() => {
                      void bridge
                        .invoke("chat_cancel_auto_resume", { key: keyFor(conversationId) })
                        .catch((error) => {
                          patch(conversationId, (state) => ({
                            ...state,
                            notices: [
                              ...state.notices,
                              `Could not cancel auto-resume: ${String((error as Error).message ?? error)}`,
                            ],
                          }));
                        });
                    }}
                  >
                    Cancel auto-resume
                  </button>}
                </div>
              )}
              {failure?.link && (
                <a
                  className="failure-link"
                  href={failure.link}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {failure.link}
                </a>
              )}
            </div>
          )}

          {conversationId && visibleNotices.length > 0 && (
            <ChatNotices
              notices={visibleNotices}
              onClear={() => patch(conversationId, (s) => ({ ...s, notices: [] }))}
            />
          )}

          {conversationId && !workerChat && (
            <ChatRequests
              asks={asks[conversationId] ?? []}
              safetyBlocks={safetyBlocks[conversationId] ?? []}
              questions={questions[conversationId] ?? []}
              onPermissionAnswered={(id) => setAsks((prev) => ({
                ...prev, [conversationId]: (prev[conversationId] ?? []).filter((item) => item.id !== id),
              }))}
              onSafetyAnswered={(id) => setSafetyBlocks((prev) => ({
                ...prev, [conversationId]: (prev[conversationId] ?? []).filter((item) => item.id !== id),
              }))}
              onQuestionsAnswered={(ids) => setQuestions((prev) => ({
                ...prev, [conversationId]: (prev[conversationId] ?? []).filter((item) => !ids.includes(item.id)),
              }))}
              onContinue={send}
            />
          )}

          {conversationId && sandboxes.snapshot?.environments[keyFor(conversationId)]?.enabled &&
            <SandboxStatus key={conversationId} environment={sandboxes.snapshot.environments[keyFor(conversationId)]}
              running={chat.busy} onRefresh={sandboxes.refresh} />}

          {/* Keyed by project: switching project gets that project's own
              terminals, and coming back reattaches to them rather than
              starting a second set. */}
          {termOpen && sessionProject && (
            <TerminalDrawer
              key={sessionProject.id}
              project={sessionProject}
              onCommandsChanged={loadWorkspaces}
              onHide={() => {
                setTermOpen(false);
                remember(TERM_KEY, "0");
              }}
            />
          )}

          {workerRequestIds.map((id) => ((asks[id]?.length ?? 0) + (safetyBlocks[id]?.length ?? 0)) > 0 && (
            <section key={id} aria-label="Agent safety approvals">
              <p className="worker-approval-context">Approval for {conversations.find((chat) => chat.id === id)?.title ?? "agent"}. Follow-up instructions go through this main chat.</p>
              <ChatRequests asks={asks[id] ?? []} safetyBlocks={safetyBlocks[id] ?? []} questions={[]}
                onPermissionAnswered={(requestId) => setAsks((prev) => ({ ...prev, [id]: (prev[id] ?? []).filter((item) => item.id !== requestId) }))}
                onSafetyAnswered={(requestId) => setSafetyBlocks((prev) => ({ ...prev, [id]: (prev[id] ?? []).filter((item) => item.id !== requestId) }))}
                onQuestionsAnswered={() => {}}
                onContinue={(message) => send(`For your worker chat ${id}:\n\n${message}\n\nCoordinate any follow-up through the orchestration tools.`)} />
            </section>
          ))}

          {workerChat ? <WorkerChatNotice
            busy={chat.busy && !cutOff}
            onOpenMain={coordinatorConversation ? () => openWorkflowChat(keyFor(coordinatorConversation.id)) : undefined}
          /> : <Composer
            focusMode={focusMode}
            session={conversationId ?? undefined}
            focusOn={focusBox}
            choice={choice}
            onChoice={changeModel}
            started={chat.messages.length > 0}
            access={access}
            onAccess={changeAccess}
            onSend={send}
            onStop={stop}
            /* What the ✕ took back off a queued bubble, on its way into the
               box. Only this conversation's — another chat's waits until you
               are looking at it. */
            putBack={(conversationId && reclaimed[conversationId]) || undefined}
            onPutBack={() => conversationId && tookBack(conversationId)}
            busy={chat.busy && !cutOff}
            installed={installed}
            commands={providerCommands(choice.agent, (projectId && commands[projectId]?.[choice.agent]) || [])}
            onCommandOpen={loadCodexSkills}
            onReloadSkills={choice.agent === "codex" ? () => loadCodexSkills(true) : undefined}
            skillsStatus={codexSkillsStatus[`${projectId}:codex`]}
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
            projects={workspaces}
            projectId={project && projectSlug(project.name) !== "general" ? project.id : null}
            onProject={chooseProject}
            branch={executionPlan ? executionPlan.branch : branch}
            branches={branches}
            onBranch={executionPlan ? (value) => setOverrides((o) => ({ ...o, branch: value })) : setBranch}
            useSandbox={executionPlan ? executionPlan.useSandbox : useSandbox}
            onUseSandbox={executionPlan ? (value) => setOverrides((o) => ({ ...o, useSandbox: value })) : setSandboxChoice}
            newWorktree={executionPlan ? executionPlan.newWorktree : newWorktree}
            onNewWorktree={executionPlan ? (value) => setOverrides((o) => ({ ...o, newWorktree: value })) : setNewWorktree}
            showWorkLocation={!conversationId && !headDraftOn && !executionPlan?.crossProject}
            advanced={executionPlan && composerIdentity && !executionPlan.crossProject ? {
              open: advancedOpen,
              onToggle: () => setAdvancedOpen((open) => !open),
              summary: executionPlan.reason,
              overridden: executionPlan.chosenBy === "advanced",
            } : undefined}
            cwd={effectiveCwd}
            /* The last turn's receipt. It had a row of its own under the box
               until now; it rides on the composer's own eyebrow instead. */
            model={chat.model}
            lastDurationMs={chat.lastDurationMs}
            lastCostUsd={chat.lastCostUsd}
            identity={composerIdentity}
            terminalOpen={termOpen}
            onTerminal={
              project && !focusMode
                ? () =>
                    setTermOpen((open) => {
                      remember(TERM_KEY, open ? "0" : "1");
                      return !open;
                    })
                : undefined
            }
          />}

          </div>
          </div>
          </>}
          </div>
        </main>

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
        {!mainPage && !previewVisible && !railShut && chat.agents.length > 0 && (
          <aside className="side">
            <AgentRail
              agents={chat.agents}
              onOpen={setFocusedAgent}
              onClose={() => showRail(false)}
            />
          </aside>
        )}

        {/* The Git column stays at the far right as a sibling of the chat,
            rather than something laid over it, so the chat gives up width while
            this is open and takes it straight back when it closes. On a phone
            the stylesheet turns it into a sheet that slides in from the right. */}
        {!mainPage && gitMounted && !previewVisible && sessionProject && (
          <GitPanel
            project={sessionProject}
            open={gitOpen}
            persistent={desktopGit}
            onClose={() => showGit(false)}
          />
        )}

        {!mainPage && previewVisible && conversationId && <ImagePreviewPanel key={conversationId} conversationKey={keyFor(conversationId)} images={previews.images} error={previews.error} onClose={() => previews.setOpen(false)} />}
        {!mainPage && filesMounted && !previewVisible && (
          <SessionFilesPanel
            pins={sessionFiles}
            open={filesOpen}
            busy={chat.busy && !cutOff}
            onClose={() => showFiles(false)}
          />
        )}
      </div>
      </div>

      {shelfOpen && (
        <ShelvedProjects
          projects={shelved}
          onRestored={loadWorkspaces}
          onClose={() => setShelfOpen(false)}
        />
      )}

      {trashOpen && (
        <DeletedChats
          chats={deletedChats}
          projects={[...workspaces, ...shelved]}
          onRestore={restoreDeletedChat}
          onClose={() => setTrashOpen(false)}
        />
      )}

      {feedbackOpen && <FeedbackInbox onClose={() => setFeedbackOpen(false)}
        availableChatIds={new Set(conversations.map(chat => chat.id))}
        onOpenChat={id => {
          const source = conversations.find(chat => chat.id === id);
          if (source) { setFeedbackOpen(false); setAppSettings(false); openConversation(source); }
        }} />}

      {settingsFor && (
        <ProjectSettings
          project={
            // Settings lists shelved projects too, so the focused sheet must
            // resolve against both collections.
            settingsFor === "new"
              ? null
              : [...workspaces, ...shelved].find((w) => w.id === settingsFor) ?? null
          }
          projects={[...workspaces, ...shelved]}
          onChanged={loadWorkspaces}
          onClose={() => setSettingsFor(null)}
          backToSettings={appSettings}
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
    </ChatPersonaContext.Provider>
    </AgentRosterContext.Provider>
    </WorkspaceSlotsContext.Provider>
  );
}
