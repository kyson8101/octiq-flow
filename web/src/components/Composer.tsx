// The prompt box: type, pick a model, send.
//
// Enter sends; Shift+Enter, Cmd/Ctrl+Enter or Option/Alt+Enter makes a new
// line — the shape every agent chat uses, on a keyboard. Shift+Enter is what a
// textarea already does, so it is left alone; the other two do nothing
// natively, so the line break is put in by hand. A phone keyboard has no Shift
// or Cmd to hold, so on a touch screen Enter is a plain new line and the send
// button is how you send.
// The field is 16px because anything smaller makes iOS Safari zoom the page the
// moment it takes focus.
//
// Detected from the POINTER, not the screen width: a narrow window on a desktop
// still has a real keyboard and should still send on Enter.
import { ActionIcon } from "./ActionIcon";
import { bindPasteSave, deliverPaste, pasteSaveFor, type PasteOwner, type PasteSaveResult } from "../lib/pasteStore";
import { ContextMeter, Working } from "./ComposerStatus";
import { useProviderModels, AccessList, SlidersIcon, SettingsSheet, ModelPicker, EffortBars, EffortSlider } from "./ComposerSettings";
import { HISTORY_MAX, loadHistory, moveInHistory, saveHistory, withPutBack, type HistoryDirection } from "../lib/sentHistory";
export { EffortList, SettingsSheet } from "./ComposerSettings";
export { moveInHistory, withPutBack } from "../lib/sentHistory";
export type { HistoryDirection } from "../lib/sentHistory";
import { useCommittedCallback } from "../lib/useCommittedCallback";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { transitionZen } from "../lib/zenMotion";
import { bridge } from "../lib/bridge";
import { Thumb } from "./Thumb";
import { Mascot } from "./Mascot";
import { FolderPicker } from "./FolderPicker";
import { AttachList } from "./AttachMenu";
import { AgentLogo } from "./AgentLogo";
import type { AgentIdentity } from "../lib/agentsMode";
import { composerPlaceholder } from "../lib/agentPersona";
import {
  WorkLocation,
  type WorkLocationBranches,
  type WorkLocationProject,
} from "./WorkLocation";
import { pasteRefusal, readClipboard, reason, spliceTextareaText } from "../lib/paste";
import { PASTE_FILE_MAX_BYTES, pastedTextLabel, pastedTextLines, pastedTextName, pastedTextSizeError, shouldSaveAsFile, type PastedText } from "../lib/longPaste";
import { formatQuote, onQuote } from "../lib/quote";
import { Drafts, type Draft } from "../lib/drafts";
import type { BackgroundTask } from "../lib/background";
import { BackgroundNote, useHasRunningJob } from "./Background";
import { RollingText } from "./RollingNumber";
import { receiptLines, runsAtLine, runsAtParts, runsAtRows, type KnownSettings } from "../lib/chatSettings";
import { ROW_FITS, rowFit, type RowFit } from "../lib/composerFit";
import { WAIT_WORDS, type ChatHold } from "../lib/chatWait";
import { type TurnWaits } from "../lib/turnClock";
import { commandToken, replaceCommandToken, withCommandTrigger } from "../lib/commandMenu";
import { AGENT_NAME, effortSteps, providerFor, type AccessLevel, type AgentCommand, type Effort, type ModelChoice, type Provider } from "../lib/agentProviders";

// Kept as exports while the components that use the picker migrate. Their
// implementation now comes from the provider registry above.
export {
  ACCESS,
  AGENT_NAME,
  EFFORTS,
  effortFor,
  effortSteps,
  MODELS,
  modelFromId,
  providerCommands,
  providerFor,
} from "../lib/agentProviders";
export type {
  AccessLevel,
  AccessOption,
  AgentCommand,
  AgentProvider,
  ComposerStyle,
  Effort,
  EffortOption,
  ModelChoice,
  Provider,
} from "../lib/agentProviders";

const TYPES_ON_GLASS =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/** The idle line in front of the box. On a touch screen Enter is a new line
 *  and nothing else — the keyboard's own return key, sent with the button —
 *  so there is no keyboard rule worth a line to state. */
export function idleHint(onGlass: boolean): string | null {
  return onGlass ? null : "Enter to send · Shift+Enter for a new line";
}

/** Who sits in front of the idle line. A registered agent's face introduces
 *  the words after it, so with no words (a touch screen, nothing running) it
 *  would sit there alone and is left out. A companion stays: it is the
 *  person's chosen mascot, not a label. */
export function idleCompanion(isAgent: boolean, text: string | null | undefined): "avatar" | "mascot" | null {
  if (!isAgent) return "mascot";
  return text ? "avatar" : null;
}

/** Whether the browser will let the PAGE read the clipboard at all.
 *
 *  Only in a secure context, which on a phone means the https address rather
 *  than `http://192.168.x.x:1421` — there `navigator.clipboard` is simply not
 *  there. So the button is not there either: a paste button that cannot paste
 *  is worse than no button, and holding the box and choosing Paste still
 *  works. */
/** How long "Cleared · Undo" stays. Long enough to notice a mis-tap and reach
 *  for it, short enough that it is gone before it becomes furniture. */
const UNDO_MS = 8000;

const CAN_PASTE =
  typeof navigator !== "undefined" &&
  !!navigator.clipboard &&
  !!(navigator.clipboard.read || navigator.clipboard.readText);

export type Attachment = {
  path: string;
  name: string;
  isImage: boolean;
  /** A local object URL for the thumbnail, when the browser already holds the
   *  bytes (a paste or an upload). Absent for a file picked on the machine —
   *  that one is fetched instead. Owned by the composer, which revokes it. */
  url?: string;
  /** Original clipboard bytes for Insert as text; never persisted. */
  pasted?: PastedText;
};


export function AttachmentChip({ attachment: a, onRemove, onInsert }: {
  attachment: Attachment;
  onRemove: () => void;
  onInsert: () => void;
}) {
  const label = a.pasted ? pastedTextLabel(a.pasted.text) : a.name;
  return (
    <span className={`chip ${a.isImage ? "is-image" : ""} ${a.pasted ? "is-pasted" : ""}`} title={a.path}>
      {a.isImage ? <Thumb attachment={a} /> : <PaperIcon />}
      <span className="chip-name">{label}</span>
      {a.pasted && <button className="chip-insert" type="button" onClick={onInsert}>Insert as text</button>}
      <button className="chip-x" type="button" aria-label={`Remove ${label}`} onClick={onRemove} data-icon-action title={`Remove ${label}`}>
        <ActionIcon name="dismiss" />
      </button>
    </span>
  );
}

export type ReclaimedMessage = { text: string; attachments: Attachment[] };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;


export function Composer({
  focusMode = false,
  session,
  draftStore,
  focusOn,
  choice,
  onChoice,
  access,
  onAccess,
  onSend,
  onStop,
  putBack,
  onPutBack,
  busy,
  disabled,
  started,
  commands,
  onCommandOpen,
  onReloadSkills,
  skillsStatus,
  contextTokens,
  contextWindow,
  activity,
  turnStartedAt,
  thinking,
  thought,
  background,
  jobChat,
  effort,
  onEffort,
  lite,
  onLite,
  projects,
  projectId,
  onProject,
  branch,
  branches,
  onBranch,
  newWorktree,
  onNewWorktree,
  showWorkLocation,
  cwd,
  onTerminal,
  terminalOpen,
  onRestart,
  installed,
  lastDurationMs,
  lastCostUsd,
  runsAt,
  waiting,
  onRecheckWaits,
  turnWaits,
  identity,
  advanced,
}: {
  /** Agents mode, new task: where it will run is chosen automatically, and
   *  the location controls stay out of sight behind this toggle. `summary` is
   *  the automatic choice in words, for the toggle's tooltip. Absent: the
   *  controls show exactly as they always did. */
  advanced?: { open: boolean; onToggle: () => void; summary: string; overridden: boolean };
  /** Agents mode: who this conversation is with. The agent's registration owns
   *  its provider, model, effort and access, so the pickers give way to a
   *  read-only name and role. Absent in an ordinary chat, which keeps them. */
  identity?: AgentIdentity | null;
  /** Quiet presentation only: the same mounted input retains its draft. */
  focusMode?: boolean;
  /** Which chat this is, so Up walks back through ITS input and no one else's.
   *  Absent for a chat that has not been saved yet. */
  session?: string;
  /** Where half-typed messages wait, when that has to outlive this box. A
   *  read-only task chat draws no composer, so opening one full-width and
   *  coming back to its main chat mounts a new box — which, holding its own
   *  drafts, would come back empty. Absent, the box keeps its own. */
  draftStore?: Drafts<Attachment>;
  /** Changes when someone has asked for a new chat by pressing a button, and
   *  the box should take the focus. Only the CHANGE is read — the number is
   *  a way of saying "again", not a value. */
  focusOn?: number;
  choice: ModelChoice;
  onChoice: (c: ModelChoice) => void;
  access: AccessLevel;
  onAccess: (a: AccessLevel) => void;
  onSend: (text: string, attachments: Attachment[]) => void | boolean | Promise<boolean>;
  onStop: () => void;
  /** Words taken back out of the queue before any agent was given them — the ✕
   *  on a queued bubble. That bubble is gone, and the box is the only place
   *  left for them.
   *
   *  APPENDED, never assigned: whatever is half-typed here now was typed after
   *  they were, and a message put back must not take a newer one away. Emptied
   *  through `onPutBack` once it is in, so the same words cannot land twice. */
  putBack?: readonly ReclaimedMessage[];
  onPutBack?: () => void;
  busy: boolean;
  disabled?: boolean;
  /** True once this conversation has turns in it. The model and the provider
   *  are fixed when the agent process spawns, so from here on picking another
   *  one opens a new chat — the menu says so rather than looking inert. */
  started?: boolean;
  /** The agents whose CLI this machine actually has. An agent that is missing
   *  cannot be picked: its chat would spawn a shell, print "command not found"
   *  and die, which reads as the app being broken.
   *
   *  UNDEFINED means "we could not ask" — an older backend, or a socket that
   *  was not up yet — and then everything stays offered, exactly as before this
   *  existed. An EMPTY array is the opposite: we asked, and this machine has
   *  none of them. */
  installed?: Provider[];
  /** The provider-owned commands available in this project. */
  commands?: readonly AgentCommand[];
  /** Lazy providers use the first command-prefix gesture to fetch their list. */
  onCommandOpen?: () => void;
  onReloadSkills?: () => void;
  skillsStatus?: string;
  /** How much of the model's context this session is holding, and its ceiling.
   *  Both absent until the first turn ends — the agent only reports them with
   *  its `result`. */
  contextTokens?: number;
  contextWindow?: number;
  /** What the agent is doing when it is not writing — compacting, so far.
   *  A long silent pause with "working…" under it tells you nothing. */
  activity?: string;
  /** When the running turn started, and how much the agent has written since.
   *  The two halves of the same answer to "is this going anywhere?" — a turn
   *  four minutes in with 16k tokens written is working; the same four minutes
   *  with nothing written is not. */
  turnStartedAt?: number;
  turnTokens?: number;
  /** True while a message is still being written, so part of `turnTokens` is
   *  an estimate. Drawn as a tilde — see `workingLine`. */
  turnApprox?: boolean;
  /** True while the model is reasoning rather than typing, which is when the
   *  effort level is worth naming: it is the setting that chose this wait. */
  thinking?: boolean;
  /** Work the turn started and left running behind it. Shown on the status
   *  line rather than on a row of its own — see `BackgroundNote`. */
  background?: BackgroundTask[];
  /** The chat's key (`chat:<id>`), whose registered jobs (`lib/jobs`) join
   *  `background` on the same line. */
  jobChat?: string;
  /** The thought being written right now, or "" — see `thinkingNow` in
   *  lib/chat. Watched here and nowhere else: it is left out of the transcript
   *  entirely, because a fold-out row of the agent talking to itself between
   *  every pair of tool cards is a timeline nobody reads back. */
  thought?: string;
  effort: Effort;
  onEffort: (e: Effort) => void;
  /** New chats start without this machine's skills, hooks and other MCP
   *  servers. Read when the agent process starts, so it only ever describes
   *  the NEXT chat. */
  lite: boolean;
  onLite: (on: boolean) => void;
  /** The visible execution location for a new chat. OctiqFlow prepares it
   *  before the agent starts; the prompt is never parsed for routing clues. */
  projects?: readonly WorkLocationProject[];
  projectId?: string | null;
  onProject?: (id: string | null) => void;
  branch?: string;
  branches?: WorkLocationBranches;
  onBranch?: (branch: string) => void;
  newWorktree?: boolean;
  onNewWorktree?: (enabled: boolean) => void;
  /** The execution-location shelf belongs only to the unsaved new-chat page. */
  showWorkLocation?: boolean;
  /** The project folder, so the file picker opens where the work is. */
  cwd?: string;
  /** Show the shell drawer. Absent when there is no project to open one in. */
  onTerminal?: () => void;
  terminalOpen?: boolean;
  /** End the agent and keep the conversation. Absent when nothing is running:
   *  the next message spawns a fresh one anyway, so there is nothing to offer. */
  onRestart?: () => void;
  /** The last turn's receipt: how long it took and what it cost. Both arrive
   *  with the agent's `result`. Never on the eyebrow: two lines of a tooltip,
   *  on the agent's chip or on the model picker (`lib/chatSettings`). */
  lastDurationMs?: number;
  lastCostUsd?: number;
  /** An agent's chat: what this chat runs at, `opus · high · Auto`, said
   *  beside the agent's name. Read-only. Absent or shorter where the page
   *  does not know (`lib/chatSettings.knownSettings`). */
  runsAt?: KnownSettings;
  /** The chat waits on the person (`lib/chatWait`): the agent is parked on a
   *  card, so the running line says so in the decision colour, its clock
   *  stops and nothing on it moves. Only read while `busy`. */
  waiting?: ChatHold | null;
  /** Ask the page's lists of what waits again: offered on the running line
   *  when it could not check them (`chatWait`'s `unchecked`). */
  onRecheckWaits?: () => void;
  /** The waits of the turn in flight, so its clock leaves them out
   *  (`lib/turnClock`). */
  turnWaits?: TurnWaits;
}) {
  const [text, setText] = useState("");
  const [focusOptions, setFocusOptions] = useState(false);
  useEffect(() => { setFocusOptions(false); }, [focusMode]);
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState(false);
  /** The phone's stand-in for the three pickers: one sheet holding all of them. */
  const [sheet, setSheet] = useState(false);
  // Whether the row has room for its pickers side by side, by its own
  // width and never the window's (`lib/composerFit`): a chat column beside
  // the run panel and a side column is narrower than a phone. Read when the
  // row's size changes, when what it holds does, and once its fonts are in;
  // never on every render. A folded row that is tried side by side again is
  // looked at before the paint (the effect on `fit.tight`), so a try that
  // does not fit is never seen.
  const rowRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<RowFit>(ROW_FITS);
  const measureRow = useCallback((again = false) => {
    const row = rowRef.current;
    if (row) setFit((before) => rowFit(before, row, again));
  }, []);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureRow());
    observer.observe(row);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) measureRow(true); });
    return () => { live = false; observer.disconnect(); };
  }, [measureRow]);
  const rowHolds = [choice.agent, choice.model, access, effort, identity?.name, !!advanced, !!onTerminal, focusMode].join("|");
  useLayoutEffect(() => measureRow(true), [measureRow, rowHolds]);
  useLayoutEffect(() => measureRow(), [measureRow, fit.tight]);
  const [permMenu, setPermMenu] = useState(false);
  const [pick, setPick] = useState(0);
  // Every option list depends on which provider is chosen: the agents do
  // not offer the same access wording or the same effort levels.
  const provider = providerFor(choice.agent);
  const accessList = provider.access;
  const effortList = provider.efforts;
  const effSteps = effortSteps(choice.agent);
  const perm = accessList.find((p) => p.id === access) ?? accessList[0];
  const eff = effortList.find((e) => e.id === effort) ?? effortList[Math.floor(effortList.length / 2)];
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [effMenu, setEffMenu] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // What "clear" just threw away, for as long as it can still be taken back.
  // Null the rest of the time, which is also what hides the Undo.
  const [cleared, setCleared] = useState<{ text: string; attached: Attachment[] } | null>(null);
  // What you have sent before, newest first, and where Up has walked to.
  // -1 is "not browsing"; anything else is an index into `history`.
  const [history, setHistory] = useState<string[]>(() => loadHistory(session));
  const [recall, setRecall] = useState(-1);

  // Switching chats swaps the list under you. Recall has to let go with it, or
  // the next Up would index into the new chat's history at the old position.
  useEffect(() => {
    setHistory(loadHistory(session));
    setRecall(-1);
  }, [session]);
  /** Whether this machine is known NOT to have that agent. Undefined
   *  `installed` is no answer rather than a negative one, so it says false for
   *  everything and nothing is greyed out — see the prop. */
  const missing = (agent: Provider) => installed !== undefined && !installed.includes(agent);
  /** Asked, and nothing resolved. Worth saying out loud: every row is then
   *  unpickable, and a menu of dead rows explaining nothing looks like a bug. */
  const noAgents = installed !== undefined && installed.length === 0;
  const modelCatalog = useProviderModels(menu || sheet, installed);

  // What was in the box before Up was first pressed, so Down can put it back
  // rather than leaving you with the last thing you sent.
  const draft = useRef("");
  const [filePicker, setFilePicker] = useState(false);

  /** Up/Down on a keyboard and the two glass controls both come through here.
   *  A touch also keeps the field focused and puts the caret after the recalled
   *  message, ready for an immediate edit. */
  const moveRecall = useCallback(
    (direction: HistoryDirection, refocus = false) => {
      const moved = moveInHistory(history, recall, text, draft.current, direction);
      draft.current = moved.draft;
      setRecall(moved.index);
      setText(moved.text);

      if (!refocus) return;
      setCaret(moved.text.length);
      const area = areaRef.current;
      area?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (!area) return;
        area.setSelectionRange(area.value.length, area.value.length);
      });
    },
    [history, recall, text],
  );

  // Codex skills may appear at the caret inside a sentence. Claude's native
  // slash commands remain whole-input; lib/commandMenu owns that distinction.
  const commandInput = commandToken(text, choice.agent, caret);
  const commandQuery = commandInput?.query;
  const commandIntent = commandInput !== undefined;
  useEffect(() => {
    if (commandIntent) onCommandOpen?.();
  }, [commandIntent, onCommandOpen]);
  const matches =
    commandQuery === undefined
      ? []
      : (commands ?? [])
          .filter((item) => item.id.toLowerCase().startsWith(commandQuery.toLowerCase()))
          // A command you have typed in full sorts to the top, so it is the one
          // highlighted. `/context` still matches `context`, so without this the
          // menu stays up on a finished command and Enter "completes" it to
          // itself — swallowing the send and making you press Enter twice.
          .sort(
            (a, b) =>
              Number(b.id.toLowerCase() === commandQuery.toLowerCase()) -
              Number(a.id.toLowerCase() === commandQuery.toLowerCase()),
          )
          .slice(0, 40);
  const slashOpen = commandIntent && (matches.length > 0 || !!onReloadSkills);

  /** The highlighted command is exactly what is typed: there is nothing left to
   *  complete, so Enter should send it. Arrowing to a different one puts
   *  completion back. */
  const nothingToComplete =
    commandQuery !== undefined &&
    matches[pick]?.id.toLowerCase() === commandQuery.toLowerCase();

  // Keep the highlight inside the list as it narrows.
  useEffect(() => {
    setPick((i) => (i < matches.length ? i : 0));
  }, [matches.length]);

  function complete(command: AgentCommand) {
    const token = commandInput ?? commandToken(text, choice.agent, areaRef.current?.selectionStart);
    if (!token) return;
    const next = replaceCommandToken(
      text,
      token,
      withCommandTrigger(command.insert, token.trigger),
    );
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      areaRef.current?.focus();
      areaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  // Grow with the text, up to a few lines, then scroll inside.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Room to actually write in. A prompt is often a paragraph or a pasted
    // stack trace, and a three-line window turns that into a keyhole.
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, [text]);

  /** Both clipboard text and ordinary files use exactly the same upload. */
  const uploadFile = useCallback(async (file: File, requireConnection = false): Promise<Attachment> => {
    if (file.size > PASTE_FILE_MAX_BYTES) throw new Error(`${file.name}: file is larger than 12 MB`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const extension = (file.type.split("/")[1] || "bin").replace("jpeg", "jpg");
    const name = file.name || `pasted.${extension}`;
    const isImage = IMAGE_EXT.test(name);
    if (requireConnection && bridge.state !== "open") throw new Error("Connection is not open");
    const path = await bridge.invoke<string>("save_attachment", {
      dataBase64: btoa(binary), extension, filename: name,
    });
    return { path, name, isImage, url: isImage ? URL.createObjectURL(file) : undefined };
  }, []);

  const attachFiles = useCallback(async (files: File[], owner?: PasteOwner) => {
    for (const file of files) {
      try {
        const attachment = await uploadFile(file);
        if (owner) {
          deliverPaste(owner, { error: null });
          deliverPaste(owner, { attachment });
        } else {
          setAttachError(null);
          setAttached((prev) => [...prev, attachment]);
        }
      } catch (err) {
        if (owner) deliverPaste(owner, { error: reason(err) });
        else setAttachError(reason(err));
      }
    }
  }, [uploadFile]);

  /** Put text in at the caret, the way a paste does.
   *
   *  The DOM normalises line endings, so only use it for the selection. Splice
   *  into raw React state and let `setRangeText` place the visible caret. */
  const insertText = useCallback((value: string) => {
    const area = areaRef.current;
    if (!area) {
      setText((prev) => prev + value);
      return;
    }
    area.focus({ preventScroll: true });
    const start = area.selectionStart;
    const end = area.selectionEnd;
    area.setRangeText(value, start, end, "end");
    // Keep the original line endings in React state, even though textarea's
    // DOM value normalises CRLF. Sending without an edit keeps the exact text.
    setText((prev) => spliceTextareaText(prev, start, end, value));
    setCaret(area.selectionStart);
  }, []);

  const [savingPastes, setSavingPastes] = useState(0);
  const pasteText = useCallback(async (value: string, owner: PasteOwner = { store: drafts.current, session: shownFor.current }) => {
    const error = pastedTextSizeError(value);
    if (error) { deliverPaste(owner, { error }); return; }
    if (!shouldSaveAsFile(value)) { deliverPaste(owner, { text: value }); return; }
    const save = pasteSaveFor(owner.store, owner.session);
    save.pending++;
    save.receive?.(save.pending);
    deliverPaste(owner, { error: null });
    try {
      if (bridge.state !== "open") throw new Error("Connection is not open");
      const file = new File([new TextEncoder().encode(value)], pastedTextName(new Date()), { type: "text/plain" });
      const attachment = { ...await uploadFile(file, true), pasted: { text: value, lines: pastedTextLines(value) } };
      deliverPaste(owner, { attachment });
    } catch (err) {
      const error = `Could not save the paste as a file (${reason(err)}); it was put in the message instead.`;
      deliverPaste(owner, { text: value, error });
    } finally {
      save.pending--;
      save.receive?.(save.pending);
    }
  }, [uploadFile]);

  /** Text highlighted in a file, on its way in at the caret.
   *
   *  The file panel cannot hand it over directly — it is a cousin of this box
   *  in the tree, not a parent — so it leaves the quote with lib/quote and this
   *  picks it up. Registering is also what tells the panel there is a box to
   *  put one in at all: with no chat on screen it draws no button. */
  useEffect(() => onQuote((quote) => insertText(formatQuote(quote, cwd))), [insertText, cwd]);

  /** Paste whatever is on the clipboard: a picture becomes an attachment, text
   *  goes in at the caret.
   *
   *  A button for it because on a phone there is no Cmd+V. Holding the box and
   *  choosing Paste is the OS answer, and it is two seconds of aiming at a
   *  small menu — which is a long way round for the commonest thing anyone does
   *  with a screenshot they just took.
   *
   *  `read()` is called before anything is awaited, because Safari counts the
   *  clipboard as something only a tap may reach and an await in front of it
   *  spends the tap. It is also the call Safari answers with its own "Paste"
   *  confirmation, which is the browser's to show and not ours to skip. */
  const pasteIn = useCallback(async () => {
    // Started on the FIRST line of the handler, before even clearing the last
    // error: the tap is what gives the page the right to look at the clipboard,
    // and anything awaited in front of this spends it.
    const reading = navigator.clipboard?.read ? navigator.clipboard.read() : null;
    const owner = { store: drafts.current, session: shownFor.current };
    const save = pasteSaveFor(owner.store, owner.session);
    save.pending++;
    save.receive?.(save.pending);
    deliverPaste(owner, { error: null });

    /** Refused. The box takes focus so the way round it — hold, then Paste —
     *  is where the finger already is. */
    const refused = (err: unknown) => {
      deliverPaste(owner, { error: pasteRefusal(err) });
      if (drafts.current === owner.store && shownFor.current === owner.session) areaRef.current?.focus();
    };

    try {
      if (reading) {
        let items: Awaited<typeof reading>;
        try {
          items = await reading;
        } catch (err) {
          refused(err);
          return;
        }
        // A separate try: being refused a look and failing to read what was
        // there are different problems, and one message for both would send
        // someone hunting for a permission that was never the trouble.
        try {
          const { files, text } = await readClipboard(items);
          if (files.length) await attachFiles(files, owner);
          if (text) {
            const error = pastedTextSizeError(text);
            if (error) deliverPaste(owner, { error });
            else if (files.length) deliverPaste(owner, { text });
            else await pasteText(text, owner);
          }
          if (!files.length && !text) deliverPaste(owner, { error: "There is nothing to paste." });
        } catch (err) {
          deliverPaste(owner, { error: `Could not read what is on the clipboard (${reason(err)}).` });
        }
        return;
      }

      // No `read()` at all — Firefox does not give pages one. Words only, then.
      try {
        const text = await navigator.clipboard.readText();
        if (text) await pasteText(text, owner);
        else deliverPaste(owner, { error: "There is nothing to paste." });
      } catch (err) {
        refused(err);
      }
    } finally {
      save.pending--;
      save.receive?.(save.pending);
    }
  }, [attachFiles, pasteText]);

  /** Reference files that already exist on the machine, by path. */
  const attachPaths = useCallback((paths: string[]) => {
    setAttachError(null);
    setAttached((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const add = paths
        .filter((p) => p && !seen.has(p))
        .map((p) => ({
          path: p,
          name: p.split("/").filter(Boolean).pop() ?? p,
          isImage: IMAGE_EXT.test(p),
        }));
      return [...prev, ...add];
    });
  }, []);

  /** Drop an attachment, and the object URL that was drawing its thumbnail. */
  const forget = useCallback((gone: Attachment[]) => {
    for (const a of gone) if (a.url) URL.revokeObjectURL(a.url);
  }, []);

  /** Empty the box: the words and every file waiting to go with them.
   *
   *  One tap, and on a phone there is no Cmd+Z behind it — so nothing is really
   *  thrown away yet. What was in the box is held aside and an Undo appears
   *  beside it; only when that goes does the last of it (the object URLs
   *  drawing the thumbnails) actually go. */
  const clearAll = useCallback(() => {
    // A second clear before the first Undo has gone: the older snapshot is the
    // one nobody can reach any more.
    if (cleared) forget(cleared.attached);
    setCleared({ text, attached });
    setText("");
    setAttached([]);
    setAttachError(null);
    setRecall(-1);
    draft.current = "";
    areaRef.current?.focus();
  }, [attached, cleared, forget, text]);

  const undoClear = useCallback(() => {
    if (!cleared) return;
    setText(cleared.text);
    setAttached(cleared.attached);
    setCleared(null);
    areaRef.current?.focus();
  }, [cleared]);

  // The Undo has a life of a few seconds, and typing anything ends it early:
  // once there is something new in the box, putting the old thing back would
  // take the new one away.
  useEffect(() => {
    if (!cleared) return;
    if (text || attached.length) {
      forget(cleared.attached);
      setCleared(null);
      return;
    }
    const timer = setTimeout(() => {
      forget(cleared.attached);
      setCleared(null);
    }, UNDO_MS);
    return () => clearTimeout(timer);
  }, [attached.length, cleared, forget, text]);

  /** What is in the box RIGHT NOW, readable from an effect that must not wake
   *  up on every keystroke. Written during the render, the way `runningRef` is
   *  in App: assigning the same value twice costs nothing and cannot drift. */
  const box = useRef<Draft<Attachment>>({ text: "", attached: [] });
  box.current = { text, attached };
  /** Half-typed messages, one per chat, for as long as this page is open. */
  const drafts = useRef(draftStore ?? new Drafts<Attachment>());
  /** The chat whose words the box is currently showing. */
  const shownFor = useRef(session);

  // A store that outlives the box: arriving, take this chat's words back out;
  // leaving, put them away. Before the paint, so the box is never drawn empty
  // over a chat that had words waiting. `box` is set by hand as well as by the
  // render, so a mount undone and redone at once (StrictMode) puts back what
  // it took.
  useLayoutEffect(() => {
    if (!draftStore) return;
    drafts.current = draftStore;
    const back = draftStore.take(shownFor.current);
    if (back.text || back.attached.length) {
      box.current = back;
      setText(back.text);
      setAttached(back.attached);
    }
    return () => draftStore.keep(shownFor.current, box.current);
  }, [draftStore]);

  // The box belongs to the CHAT, not to the screen.
  //
  // It is drawn once and the conversation under it changes — a tapped banner,
  // an answered question card, a chat picked in the sidebar. The words used to
  // stay behind in the box while the chat moved out from under them, and the
  // next Enter sent them to whatever had arrived. That is how a message lands
  // in a conversation nobody typed it into: the words were real, the chat that
  // got them was not the one they were written in.
  //
  // So leaving a chat puts the box away under its id, and arriving takes that
  // chat's own words back out — an empty box for one never typed in.
  useLayoutEffect(() => {
    if (shownFor.current === session) return;
    drafts.current.keep(shownFor.current, box.current);
    shownFor.current = session;
    const back = drafts.current.take(session);
    box.current = back;
    setText(back.text);
    setAttached(back.attached);
    setAttachError(null);
    // Up walks the history of the chat you are in, from wherever the box is
    // now — neither of which is what it was a moment ago.
    draft.current = "";
    // The Undo belonged to the chat that has just left. Offering it here would
    // put that chat's words in this one, which is the very thing above.
    setCleared((old) => {
      if (old) forget(old.attached);
      return null;
    });
    // Only the chat. Everything this reads about the box is read through a ref
    // precisely so that typing does not re-run it.
  }, [session, forget]);

  // The paste store outlives this mount and keeps `receive`, so it must not be
  // a closure of this render: V8 shares one scope between every closure made in
  // a render, and one stored there kept this render's `insertText`, `moveRecall`
  // and `onPutBack` (an App render) alive, with every transcript App held then.
  // A committed callback keeps only its cell and always runs the latest body.
  const receive = useCommittedCallback((pending: number, result?: PasteSaveResult) => {
    setSavingPastes(pending);
    if (!result) return;
    if ("attachment" in result) setAttached((prev) => [...prev, result.attachment]);
    else {
      if ("text" in result) insertText(result.text);
      if ("error" in result) setAttachError(result.error ?? null);
    }
  }, []);
  useLayoutEffect(
    () => bindPasteSave(pasteSaveFor(drafts.current, session), receive, setAttachError),
    [session, draftStore, receive],
  );

  /** Words that were queued and never sent, put back where they were typed.
   *
   *  Below the effect above on purpose: arriving in a chat fills the box from
   *  its draft, and these go on the END of that, not instead of it.
   *
   *  The guard is the ARRAY, not a boolean — a re-render with the same words
   *  must be a no-op, or the box would keep re-filling for as long as the
   *  parent held them. */
  const putBackDone = useRef<readonly ReclaimedMessage[] | null>(null);
  useEffect(() => {
    if (!putBack?.length || putBackDone.current === putBack) return;
    putBackDone.current = putBack;
    setText((prev) => withPutBack(prev, putBack.map((message) => message.text)));
    setAttached((prev) => {
      const restored = putBack.flatMap((message) => message.attachments);
      return [...prev, ...restored.filter((a) => !prev.some((existing) => existing.path === a.path))];
    });
    // Up walks history from wherever the box is, and the box has just moved.
    setRecall(-1);
    draft.current = "";
    onPutBack?.();
  }, [putBack, onPutBack]);

  /** A new chat, asked for by pressing "+": the box takes the focus, so the
   *  thing you do next is type rather than aim.
   *
   *  Not on glass. There the focus is what RAISES the keyboard, and half the
   *  screen would go to it before anyone had said they wanted to write —
   *  covering the empty page's own way in, the search for a session to carry
   *  on. A phone gets the blank chat and nothing else, and the box is one tap
   *  away where it always was.
   *
   *  The first run is skipped by starting the ref where the prop starts: a
   *  page that has just loaded has not had a button pressed on it. */
  const focusedOn = useRef(focusOn);
  useEffect(() => {
    if (focusedOn.current === focusOn) return;
    focusedOn.current = focusOn;
    if (TYPES_ON_GLASS || disabled) return;
    areaRef.current?.focus();
  }, [focusOn, disabled]);

  function rememberSent(value: string) {
    // A repeat of the last message does not stack in input history.
    setHistory((prev) => {
      const next = prev[0] === value ? prev : [value, ...prev].slice(0, HISTORY_MAX);
      saveHistory(session, next);
      return next;
    });
    setRecall(-1);
    draft.current = "";
  }

  function sendQuickResponse() {
    if (disabled || pasteSaveFor(drafts.current, shownFor.current).pending) return;
    const value = "👌 OK";
    onSend(value, []);
    rememberSent(value);
  }

  const clearing = useRef(new Set<string | undefined>());
  async function send() {
    const value = text.trim();
    if ((!value && attached.length === 0) || disabled || pasteSaveFor(drafts.current, shownFor.current).pending) return;
    if (value === "/clear") {
      const owner = shownFor.current, store = drafts.current, submitted = text;
      if (clearing.current.has(owner)) return;
      clearing.current.add(owner);
      try {
        if (await onSend(value, attached) === false) return;
        // A late reply belongs to the box it was sent from. Keep newer typing
        // and other chats' drafts, and only remove the successful command.
        if (shownFor.current === owner && drafts.current === store) {
          if (box.current.text === submitted) {
            rememberSent(value);
            setText("");
            forget(attached);
            setAttached([]);
            setAttachError(null);
          }
        } else {
          const saved = store.take(owner);
          if (saved.text === submitted) forget(saved.attached);
          else store.keep(owner, saved);
        }
      } catch (error) {
        if (shownFor.current === owner) setAttachError(reason(error));
      } finally {
        clearing.current.delete(owner);
      }
      return;
    }
    onSend(value, attached);
    rememberSent(value);
    setText("");
    // The message owns them now; these previews are done.
    forget(attached);
    setAttached([]);
    setAttachError(null);
  }

  // The last turn's receipt, for a tooltip: on the agent's chip, or on the
  // model picker of an ordinary chat. It is not on the eyebrow.
  const receipt = receiptLines(lastDurationMs, lastCostUsd);
  // A job the agent registered counts as work left running, for the robot's
  // eyes, the same as a background command does.
  const hasJob = useHasRunningJob(jobChat);

  return (
    <div className={`composer ${focusMode ? "composer-focus" : ""} ${focusMode && focusOptions ? "focus-options-open" : ""}`} data-composer-style={choice.composerStyle} data-model-id={choice.id}>
      {focusMode && <div className="focus-activity" role="status" data-waiting={(busy && waiting) || undefined}>{busy && waiting ? WAIT_WORDS[waiting] : activity || (busy ? "Working…" : "\u00a0")}</div>}
      {/* Everything ABOUT the turn sits above the box: the thought being had,
          and under it how long this has taken and the current activity.
          Both are lines of text, and a line of text in a row of buttons gets
          eight characters and an ellipsis. */}
      {!!thought?.trim() && (
        <div className="think-live" aria-live="off">
          <span className="think-live-text">{thought}</span>
        </div>
      )}

      {/* The eyebrow: the hint on the left, and on a touch screen the history
          keys on the right. What the chat runs at and the last turn's receipt
          are not here: the first is beside the agent's name in the row below,
          the second in a tooltip there. */}
      <div className="composer-hint">
        <span className="composer-hint-said">
        {/* Work the turn left running behind it rides on this same line: a dot
            in front of the clock, and what it is running after the words. It
            used to have a row of its own directly above, which is a line of
            chrome parked in the chat for as long as the build takes. */}
        <BackgroundNote tasks={background ?? []} chatKey={jobChat} busy={busy}>
        {busy ? (
          <Working
            since={turnStartedAt}
            waits={turnWaits}
            waiting={waiting ?? undefined}
            onRecheck={onRecheckWaits}
            activity={activity}
            thinking={thinking}
            background={(background ?? []).length > 0 || hasJob}
            robot={choice.composerStyle}
            persona={identity}
          />
        ) : (() => {
          // Idle companions dance in the same full-body slot used during work.
          // Registered agents are identified on their reply, without another avatar here.
          const text = activity ?? idleHint(TYPES_ON_GLASS);
          const face = idleCompanion(!!identity, text);
          return (
            <>
              {face === "mascot" ? <Mascot robot={choice.composerStyle} mood="idle" /> : null}
              {text}
            </>
          );
        })()}
        </BackgroundNote>
        </span>

        {/* Software keyboards have no Up/Down history keys. On touch screens
            their equivalent sits at the right of this eyebrow: close to the
            field it changes, without covering the words being edited. */}
        <div className="composer-history" role="group" aria-label="Sent message history">
          <button
            className="history-step"
            type="button"
            aria-label="Show previous sent message"
            title="Previous sent message"
            disabled={!history.length || recall >= history.length - 1}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => moveRecall("older", true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 14 6-6 6 6" />
            </svg>
          </button>
          <button
            className="history-step"
            type="button"
            aria-label="Show next sent message"
            title="Next sent message"
            disabled={recall < 0}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => moveRecall("newer", true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 10 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {slashOpen && (
        <div className="slash">
          <div className="slash-head">
            <RollingText>
              {matches.length ? `${matches.length} command${matches.length === 1 ? "" : "s"} · ${nothingToComplete ? "Enter to send" : "Tab to complete"}` : "No matching skills"}
            </RollingText>
          </div>
          {onReloadSkills && (
            <div className="skill-reload">
              <button type="button" disabled={skillsStatus === "loading"} onClick={onReloadSkills} data-icon-action title={skillsStatus === "loading" ? "Reloading…" : "Reload skills"} aria-label={skillsStatus === "loading" ? "Reloading…" : "Reload skills"}>
                <ActionIcon name="refresh" label="Reload" />
              </button>
              {skillsStatus && skillsStatus !== "loading" && <span role="alert">{skillsStatus}</span>}
            </div>
          )}
          <ul className="slash-list" role="listbox">
            {matches.map((command, i) => (
              <li key={command.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  className={`slash-item ${i === pick ? "is-on" : ""}`}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => complete(command)}
                >
                  {withCommandTrigger(command.label, commandInput?.trigger ?? "/")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {filePicker && (
        <FolderPicker
          start={cwd ?? ""}
          title="Reference a file"
          files
          onPick={(p) => {
            attachPaths([p]);
            setFilePicker(false);
          }}
          onClose={() => setFilePicker(false)}
        />
      )}
      <div className="composer-box">
        {(attached.length > 0 || attachError || cleared || savingPastes > 0) && (
          <div className="attach">
            {attached.map((a) => (
              <AttachmentChip key={a.path} attachment={a} onRemove={() => {
                forget([a]);
                setAttached((prev) => prev.filter((x) => x.path !== a.path));
              }} onInsert={() => {
                if (!a.pasted) return;
                setAttached((prev) => prev.filter((x) => x.path !== a.path));
                insertText(a.pasted.text);
              }} />
            ))}
            {savingPastes > 0 && <span className="attach-saving" role="status">Saving pasted text…</span>}
            {attachError && <span className="attach-error">{attachError}</span>}
            {cleared && (
              <span className="attach-undo">
                Cleared.
                <button className="attach-undo-btn" type="button" onClick={undoClear}>
                  Undo
                </button>
              </span>
            )}
          </div>
        )}
        <div className="composer-input-wrap">
          <textarea
            ref={areaRef}
            className="composer-input"
            aria-label="Message"
            rows={2}
            value={text}
            placeholder={disabled ? "Chat unavailable" : composerPlaceholder(identity, choice.name)}
            disabled={disabled}
            onChange={(e) => {
              // Input events are the reliable signal on a software keyboard;
              // it may never issue the printable keydown that desktop uses.
              if (recall >= 0) setRecall(-1);
              const value = e.target.value;
              // React can observe textarea's LF-normalised DOM value on the
              // next focus event after a programmatic insert. That is not an
              // edit to the original clipboard line endings.
              setText((prev) => prev.replace(/\r\n|\r/g, "\n") === value ? prev : value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (files.length) {
                e.preventDefault();
                void attachFiles(files);
                return;
              }
              const value = e.clipboardData.getData("text/plain");
              const error = pastedTextSizeError(value);
              if (error) {
                e.preventDefault();
                setAttachError(error);
                return;
              }
              if (shouldSaveAsFile(value)) {
                e.preventDefault();
                void pasteText(value);
              }
            }}
            onKeyDown={(e) => {
              // While the command list is up it owns the arrows, Tab and Enter —
              // the same keys a shell completion takes.
              if (slashOpen && matches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPick((i) => (i + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPick((i) => (i - 1 + matches.length) % matches.length);
                  return;
                }
                // Tab always completes; Enter only when it would add something
                // and is not being held as a new-line key.
                const plainEnter =
                  e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
                if (e.key === "Tab" || (plainEnter && !nothingToComplete)) {
                  e.preventDefault();
                  complete(matches[pick]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setText("");
                  return;
                }
              }
              // Up walks back through what you have sent, the way a shell does.
              // Only from the FIRST line, so it still moves the cursor inside a
              // message you are part-way through writing.
              const area = e.currentTarget;
              const atStart = area.selectionStart === 0 && area.selectionEnd === 0;
              const onFirstLine = !text.slice(0, area.selectionStart).includes("\n");
              const onLastLine = !text.slice(area.selectionEnd).includes("\n");

              if (e.key === "ArrowUp" && history.length && (recall >= 0 || (atStart && onFirstLine))) {
                e.preventDefault();
                moveRecall("older");
                return;
              }
              if (e.key === "ArrowDown" && recall >= 0 && onLastLine) {
                e.preventDefault();
                moveRecall("newer");
                return;
              }
              // Typing anything else means you are writing, not browsing.
              if (recall >= 0 && e.key.length === 1) setRecall(-1);

              if (e.key === "Enter") {
                // Cmd/Ctrl+Enter and Option/Alt+Enter are new lines too, but
                // unlike Shift+Enter the textarea does nothing with them on its
                // own, so the break goes in by hand at the caret. `setRangeText`
                // moves the DOM value ahead of React; mirroring it straight back
                // into state keeps the two in step and the caret where `"end"`
                // put it.
                if (e.metaKey || e.ctrlKey || e.altKey) {
                  e.preventDefault();
                  area.setRangeText("\n", area.selectionStart, area.selectionEnd, "end");
                  setText(area.value);
                  return;
                }
                // Shift+Enter is left alone so the textarea breaks the line. On
                // glass Enter is left alone too: there is no Shift to hold, so
                // claiming it would mean a multi-line prompt could not be typed
                // at all — the send button sends there.
                if (!e.shiftKey && !TYPES_ON_GLASS) {
                  e.preventDefault();
                  send();
                }
              }
            }}
          />

        </div>
        <div className={`composer-row${fit.tight ? " is-tight" : ""}`} ref={rowRef}>

          {/* One "+", two ways in. They were a clip and a picture standing
              side by side, which read as the same idea drawn twice — see
              `AttachList` for why they are not, and why naming them beats
              guessing at two icons. */}
          <div className="picker composer-attach">
            <button
              className="picker-btn attach-btn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={attachMenu}
              aria-label="Attach"
              title="Reference a file, or upload a file"
              onClick={() => setAttachMenu((v) => !v)}
            >
              <PlusIcon />
            </button>
            {attachMenu && (
              <>
                <div className="picker-scrim" onClick={() => setAttachMenu(false)} />
                <div className="picker-menu" role="menu" aria-label="Attach">
                  <AttachList
                    onReference={() => {
                      setFilePicker(true);
                      setAttachMenu(false);
                    }}
                    onUpload={() => {
                      fileRef.current?.click();
                      setAttachMenu(false);
                    }}
                  />
                </div>
              </>
            )}
          </div>
          {/* Cmd+V for a screen with no Cmd. Beside "+" because it is the same
              question — what goes in with this message — and it answers it in
              one tap for the case that is nearly always a screenshot. */}
          {CAN_PASTE && (
            <button
              className="picker-btn attach-btn"
              type="button"
              aria-label="Paste"
              title="Paste from the clipboard"
              disabled={!!disabled}
              onClick={() => void pasteIn()}
            >
              <ClipboardIcon />
            </button>
          )}

          {/* Only here when there is something to clear. A bin standing in an
              empty bar is a button that does nothing, and next to Send that is
              the wrong thing to leave lying around. */}
          {(!!text || attached.length > 0) && (
            <button
              className="picker-btn attach-btn clear-btn"
              type="button"
              aria-label="Clear the message"
              title="Clear the message and its files"
              onClick={clearAll}
             data-icon-action>
              <ActionIcon name="dismiss" />
            </button>
          )}

          <input
            ref={fileRef}
            className="attach-input"
            type="file"
            multiple
            onChange={(e) => {
              void attachFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />

          {/* A phone fits one of these, not three. `display: contents` keeps
              them as direct flex children on a wide screen, so wrapping them
              costs the desktop layout nothing; the phone rule hides the lot and
              shows `settings-toggle` in their place. */}
          {identity && advanced && (
            <button
              className={`picker-btn composer-advanced${advanced.open ? " is-open" : ""}${advanced.overridden ? " is-overridden" : ""}`}
              type="button"
              aria-expanded={advanced.open}
              aria-label={advanced.open ? "Hide where this task runs" : "Where this task runs (Advanced)"}
              title={`${advanced.overridden ? "Changed under Advanced" : "Automatic"}: ${advanced.summary}`}
              onClick={advanced.onToggle}
            >
              <SlidersIcon />
            </button>
          )}
          {identity ? <AgentIdentityChip identity={identity} chat={session} runsAt={runsAt} receipt={receipt} /> : <>
          <div className="composer-settings">
          <div className="picker">
            <button
              className="picker-btn model-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              title={[`${choice.name} · ${choice.model}`, ...receipt].join("\n")}
              onClick={() => setMenu((v) => !v)}
            >
              {/* The mark, not the name. "Claude · Opus" spent a third of the
                  toolbar saying a word that never changes between two values,
                  and the two marks tell them apart faster than reading does —
                  which is what a logo is for. The name is still in the title,
                  and `AgentLogo` labels itself for a screen reader. */}
              <AgentLogo agent={choice.agent} />
              {choice.model}
              <span className="picker-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {menu && (
              <>
                <div className="picker-scrim" onClick={() => setMenu(false)} />
                <div className="picker-menu is-models" role="dialog" aria-label="Model">
                  <ModelPicker
                    choice={choice}
                    models={modelCatalog.models}
                    catalogStatus={modelCatalog.status}
                    onReloadModels={modelCatalog.reload}
                    onChoice={(m) => {
                      onChoice(m);
                      setMenu(false);
                    }}
                    missing={missing}
                    noAgents={noAgents}
                    started={!!started}
                    lite={lite}
                    onLite={onLite}
                    onRestart={
                      onRestart &&
                      (() => {
                        onRestart();
                        setMenu(false);
                      })
                    }
                  />
                </div>
              </>
            )}
          </div>

          <div className="picker">
            <button
              className={`picker-btn perm-${perm.id}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={permMenu}
              title={perm.hint}
              onClick={() => setPermMenu((v) => !v)}
            >
              {perm.label}
              <span className="picker-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {permMenu && (
              <>
                <div className="picker-scrim" onClick={() => setPermMenu(false)} />
                <div className="picker-menu" role="menu">
                  <AccessList
                    list={accessList}
                    access={access}
                    note={providerFor(choice.agent).accessNote}
                    onPick={(a) => {
                      onAccess(a);
                      setPermMenu(false);
                    }}
                  />
                </div>
              </>
            )}
          </div>

          {/* The effort meter. The button is the meter — bars filled to the
              level, so the scale is readable without opening anything — and
              what opens is the slider that moves along it. */}
          <div className="picker">
            <button
              className="picker-btn eff-btn"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={effMenu}
              title={`Effort: ${eff.label} — ${eff.hint}`}
              onClick={() => setEffMenu((v) => !v)}
            >
              {/* Read off `eff`, not off `effort`: mid-switch the chosen level
                  can be one the new agent does not have, and `eff` is already
                  the fallback the word beside it is using. Off `effort` the
                  bars would empty while the word said Medium. */}
              <EffortBars
                at={effSteps.findIndex((e) => e.id === eff.id)}
                of={effSteps.length}
                auto={eff.id === "auto"}
              />
              {eff.label}
            </button>
            {effMenu && (
              <>
                <div className="picker-scrim" onClick={() => setEffMenu(false)} />
                {/* No close on pick: a slider is dragged THROUGH levels, and a
                    menu that shut on the first one would end the drag before
                    you reached the level you were heading for. The scrim
                    closes it, the same as anywhere else. */}
                <div className="picker-menu is-effort" role="dialog" aria-label="Effort">
                  <EffortSlider
                    agent={choice.agent}
                    effort={effort}
                    onEffort={onEffort}
                    started={!!started}
                  />
                </div>
              </>
            )}
          </div>
          </div>

          {/* The same three settings behind one button, for a bar that cannot
              hold them side by side. It shows the model because that is the one
              worth seeing without opening anything. */}
          <button
            className="picker-btn settings-toggle model-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={sheet}
            title="Model, access and effort"
            onClick={() => setSheet(true)}
          >
            <AgentLogo agent={choice.agent} />
            {choice.model}
            <span className="picker-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          </>}

          {/* A shell in this project, for the things you would rather run than
              ask for. Next to the agent's own settings because it is the same
              decision: who does this — you, or it. */}
          {onTerminal && (
            <button
              className={`picker-btn ${terminalOpen ? "is-on" : ""}`}
              type="button"
              title={terminalOpen ? "Hide the terminal" : "Open a terminal here"}
              onClick={onTerminal}
            >
              <TerminalIcon />
            </button>
          )}

          {/* What used to be the status line stood here, between the buttons
              and Send, and took whatever width was left — which on a phone was
              about eight characters of it. It is a line of text, so it is on a
              line of its own now, above the box. This holds its place in the
              row and keeps Send at the right end. */}
          <span className="composer-gap" />

          {focusMode && (
            <button className="picker-btn focus-options-toggle" type="button"
              aria-label={focusOptions ? "Hide composer options" : "Show composer options"}
              title={focusOptions ? "Hide composer options" : "Composer options"}
              aria-expanded={focusOptions}
              onClick={() => transitionZen("options", () => setFocusOptions(value => !value))}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
          )}

          <ContextMeter tokens={contextTokens} window={contextWindow} scope={session ?? ""} />

          {focusMode && (
            <button
              className="focus-quick-response"
              type="button"
              aria-label="Send 👌 OK"
              title="Send 👌 OK"
              disabled={!!disabled || savingPastes > 0}
              onClick={sendQuickResponse}
            >
              <span aria-hidden="true">👌</span>
            </button>
          )}

          {/* Stop and Send used to SHARE this spot, so while a turn ran there
              was no send button at all — you could not add "and also check the
              tests" without first killing the turn you were adding it to. The
              backend never had that limit: chat_send writes to the agent's
              stdin, which it reads continuously, so a second message mid-turn
              is just the next thing it is told. Only the UI was in the way.

              So while a turn runs, BOTH are here: stop it, or say something
              else to it. Stop stays first — it is the one you want in a hurry,
              and it must not move to make room for the other. */}
          {busy && (
            <button className="send stop" type="button" title="Stop" onClick={onStop}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2.5" />
              </svg>
            </button>
          )}
          <button
            className="send"
            type="button"
            title={busy ? "Send anyway" : "Send"}
            disabled={(!text.trim() && !attached.length) || !!disabled || savingPastes > 0}
            onClick={send}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </button>
        </div>

        {sheet && (
          <>
            <div className="sheet-scrim" onClick={() => setSheet(false)} />
            <SettingsSheet
              choice={choice}
              models={modelCatalog.models}
              catalogStatus={modelCatalog.status}
              onReloadModels={modelCatalog.reload}
              onChoice={onChoice}
              missing={missing}
              noAgents={noAgents}
              started={!!started}
              accessList={accessList}
              access={access}
              onAccess={onAccess}
              effort={effort}
              onEffort={onEffort}
              lite={lite}
              onLite={onLite}
              onRestart={
                onRestart &&
                (() => {
                  onRestart();
                  setSheet(false);
                })
              }
              onDone={() => setSheet(false)}
            />
          </>
        )}
      </div>
      {showWorkLocation && (!advanced || advanced.open) && (
        <WorkLocation
          projects={projects ?? []}
          projectId={projectId ?? null}
          onProject={onProject ?? (() => undefined)}
          branch={branch ?? ""}
          branches={branches}
          onBranch={onBranch ?? (() => undefined)}
          newWorktree={!!newWorktree}
          onNewWorktree={onNewWorktree ?? (() => undefined)}
        />
      )}
    </div>
  );
}

/** Agents mode: the agent this conversation is with, in the place the model,
 *  access and effort pickers take in an ordinary chat. Read-only on purpose:
 *  the agent's registration (Settings, Agents) owns those settings.
 *  `chat` is the saved chat this composer is the composer of: a confirmed
 *  route's face and name land on the chip of the chat it opened and on no
 *  other (`lib/identityTravel.composerLanding`), whoever the chip names. */
export function AgentIdentityChip({ identity, chat, runsAt, receipt = [], initiallyOpen = false }: {
  identity: AgentIdentity;
  chat?: string;
  /** What THIS chat runs at (`lib/chatSettings.knownSettings`): only what
   *  the page knows of it, so a part may be absent, or all of it. */
  runsAt?: KnownSettings;
  /** The last turn's receipt, a line each. */
  receipt?: readonly string[];
  /** Static-render seam for the chip's test: there is no press to make. */
  initiallyOpen?: boolean;
}) {
  // The face and the name are the chip, with what the chat runs at beside
  // them in small quiet text. That text is not a picker: the agent's
  // registration says what its chats open on (Settings, Agents), and a chat
  // then keeps the level it has, which is what is said here and may not be
  // the registration's. It is a disclosure, because a narrow composer cuts
  // it short:
  // a press, a tap or Enter shows the three values whole, read-only, with
  // the last turn's receipt, so none of it is behind a hover alone.
  const [open, setOpen] = useState(initiallyOpen);
  const sheetId = useId();
  // A sheet opened in one chat is not another chat's.
  useEffect(() => setOpen(initiallyOpen), [chat, initiallyOpen]);
  const provider = AGENT_NAME[identity.provider];
  const line = runsAt ? runsAtLine(runsAt) : "";
  const { rest, access } = runsAtParts(runsAt ?? {});
  const tip = [
    identity.name,
    identity.role,
    `${provider} ${identity.model} · set in Settings, Agents`,
    // This session's own values, never the registration's in their place.
    line ? `This chat runs at ${line}` : "",
    identity.removed ? "No longer registered: this conversation keeps its last settings" : "",
    ...receipt,
  ].filter(Boolean).join("\n");
  return (
    <div className="composer-identity" title={open ? undefined : tip} data-removed={identity.removed || undefined} data-chat={chat || undefined}>
      {/* What a confirmed route's name lands on (`identityTravel`): it stays
          the name alone, and it is the last thing here to be cut short. */}
      <span className="composer-identity-name">{identity.name}</span>
      {/* The first part gives way before the access does, and both before
          the name. The button's target is the whole chip (the sheet's
          `::before`), so there is something to press at any width. */}
      {line && <button type="button" className="composer-identity-runs" aria-expanded={open} aria-controls={sheetId}
        aria-label={`What this chat runs at: ${line}`}
        onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}
        onClick={() => setOpen((shown) => !shown)}>
        {rest && <span className="composer-identity-rest">{rest}</span>}
        {access && <span className="composer-identity-access">{access}</span>}
      </button>}
      {line && open && <>
        <div className="picker-scrim" onClick={() => setOpen(false)} />
        <div className="picker-menu composer-identity-sheet" id={sheetId} role="group" aria-label="What this chat runs at">
          <dl>
            {runsAtRows(runsAt ?? {}).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
          </dl>
          {receipt.map((item) => <p key={item}>{item}</p>)}
          <p className="composer-identity-sheet-note">Read-only here. This chat keeps what it runs at. Settings, Agents sets what an agent's new chats open on.</p>
        </div>
      </>}
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="2.5" width="8" height="4" rx="1.3" />
      <path d="M9 4.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PaperIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 8 4 4-4 4" />
      <path d="M13 16h6" />
    </svg>
  );
}
