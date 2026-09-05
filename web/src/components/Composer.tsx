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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import { Thumb } from "./Thumb";
import { elapsedLabel, workingLine } from "../lib/working";
import { Mascot } from "./Mascot";
import { FolderPicker } from "./FolderPicker";
import { AttachList } from "./AttachMenu";
import { AgentLogo } from "./AgentLogo";
import { RoomPanel, RoomSheet } from "./RoomPanel";
import { completeMention, mentionMatches, mentionPicks, mentionQuery } from "../lib/mention";
import { RoundBar, type RoundState } from "./RoundBar";
import { pasteRefusal, readClipboard, reason } from "../lib/paste";
import { formatQuote, onQuote } from "../lib/quote";
import { Drafts, type Draft } from "../lib/drafts";
import type { Seat } from "../lib/chat";
import type { BackgroundTask } from "../lib/background";
import { BackgroundNote } from "./Background";
import { useMedia, WIDE } from "../lib/media";
import { RollingText } from "./RollingNumber";
import { commandToken, replaceCommandToken, withCommandTrigger } from "../lib/commandMenu";
import {
  AGENT_NAME,
  effortSteps,
  PROVIDERS,
  providerFor,
  type AccessLevel,
  type AgentCommand,
  type ComposerStyle,
  type Effort,
  type ModelChoice,
  type Provider,
} from "../lib/agentProviders";

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

/** The access list: modes as rows, and `bypass` as the switch under them.
 *
 *  Drawn in two places — the dropdown on a wide screen and the settings sheet
 *  on a phone — and the switch has enough behaviour of its own (turning it OFF
 *  has to land somewhere) that keeping two copies of it was asking for them to
 *  drift. */
function AccessList({
  list,
  access,
  onPick,
}: {
  list: readonly { id: AccessLevel; label: string; hint: string; bypass?: boolean }[];
  access: AccessLevel;
  onPick: (a: AccessLevel) => void;
}) {
  const modes = list.filter((p) => !p.bypass);
  const bypass = list.find((p) => p.bypass);
  // Where turning the switch off goes back to. The mode you were last ON, not a
  // fixed one: someone who was planning, flipped bypass to get one thing done,
  // and flipped it back meant to go back to planning.
  const before = useRef<AccessLevel>(access === bypass?.id ? modes[modes.length - 1].id : access);
  if (access !== bypass?.id) before.current = access;

  return (
    <>
      {modes.map((p) => (
        <button
          key={p.id}
          type="button"
          role="menuitem"
          className={`picker-item ${p.id === access ? "is-on" : ""}`}
          onClick={() => onPick(p.id)}
        >
          <span className="picker-name">{p.label}</span>
          <span className="picker-model">{p.hint}</span>
          {/* The same mark the model list and the effort list use. A row that
              is merely tinted reads as hovered; a tick reads as chosen. */}
          {p.id === access && (
            <span className="picker-tick" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      ))}

      {bypass && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={access === bypass.id}
          className={`picker-item is-bypass ${access === bypass.id ? "is-on" : ""}`}
          title={bypass.hint}
          onClick={() => onPick(access === bypass.id ? before.current : bypass.id)}
        >
          <span className="picker-name">{bypass.label}</span>
          <span className="picker-switch">{access === bypass.id ? "Enabled" : "Enable"}</span>
        </button>
      )}
    </>
  );
}

export type Attachment = {
  path: string;
  name: string;
  isImage: boolean;
  /** A local object URL for the thumbnail, when the browser already holds the
   *  bytes (a paste or an upload). Absent for a file picked on the machine —
   *  that one is fetched instead. Owned by the composer, which revokes it. */
  url?: string;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** How many past messages Up can reach. Enough to find the thing you sent a
 *  few minutes ago, few enough to stay small in storage. */
const HISTORY_MAX = 100;

/** Input history is PER CHAT.
 *
 *  One shared list meant pressing Up in a chat about the payroll migration
 *  offered what you last typed at a novel — recall is only useful when what
 *  comes back belongs to the conversation you are in. Chats with no id yet
 *  (a new one, before it is saved) share a scratch list rather than writing
 *  into somebody else's. */
function historyKey(session?: string): string {
  return `octiq.v2.history:${session || "new"}`;
}

function loadHistory(session?: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(session)) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(session: string | undefined, list: string[]): void {
  try {
    localStorage.setItem(historyKey(session), JSON.stringify(list));
  } catch {
    /* storage blocked: history lasts this session only */
  }
}

/** What the box says once messages taken back out of the queue are put in it.
 *
 *  They go at the END, after whatever is already there. Two reasons, and they
 *  point the same way: a half-typed line in the box is NEWER than a message
 *  that was queued before it, and words arriving in two batches stay in the
 *  order they were sent rather than turning inside out.
 *
 *  A blank line between them, because each one was its own message and is
 *  about to be one again — run together, two paragraphs become a single prompt
 *  nobody wrote. */
export function withPutBack(current: string, words: readonly string[]): string {
  return [current.trim(), ...words.map((w) => w.trim())].filter(Boolean).join("\n\n");
}

export function Composer({
  session,
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
  contextTokens,
  contextWindow,
  activity,
  turnStartedAt,
  turnTokens,
  turnApprox,
  thinking,
  thought,
  background,
  effort,
  onEffort,
  lite,
  onLite,
  room,
  seats,
  round,
  onAsk,
  onStopRound,
  onNewTopic,
  topicDrawn,
  onAddSeat,
  onRemoveSeat,
  cwd,
  onTerminal,
  terminalOpen,
  onRestart,
  installed,
  model,
  lastDurationMs,
  lastCostUsd,
}: {
  /** Which chat this is, so Up walks back through ITS input and no one else's.
   *  Absent for a chat that has not been saved yet. */
  session?: string;
  /** Changes when someone has asked for a new chat by pressing a button, and
   *  the box should take the focus. Only the CHANGE is read — the number is
   *  a way of saying "again", not a value. */
  focusOn?: number;
  choice: ModelChoice;
  onChoice: (c: ModelChoice) => void;
  access: AccessLevel;
  onAccess: (a: AccessLevel) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  /** Words taken back out of the queue before any agent was given them — the ✕
   *  on a queued bubble. That bubble is gone, and the box is the only place
   *  left for them.
   *
   *  APPENDED, never assigned: whatever is half-typed here now was typed after
   *  they were, and a message put back must not take a newer one away. Emptied
   *  through `onPutBack` once it is in, so the same words cannot land twice. */
  putBack?: readonly string[];
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
  /** Card 66 — the room controls, passed straight through to the settings
   *  sheet. Optional: a composer given none draws no room controls.
   *
   *  Card 82: `room` is DERIVED now, not stored — a chat is a group when it has
   *  a seat in it. It is still a prop because the caller is the one holding the
   *  seat list, and two places computing the same thing is two places to get it
   *  wrong. */
  room?: boolean;
  seats?: Seat[];
  /** Card 68 — the round in flight, and the two things you can do about it. */
  round?: RoundState | null;
  onAsk?: () => void;
  onStopRound?: () => void;
  /** Card 69 — draw a line under the discussion so far. */
  onNewTopic?: () => void;
  topicDrawn?: boolean;
  onAddSeat?: (want: { label: string; agent: "claude" | "codex"; kind?: "on_demand"; provider?: string; context?: "room_only" }) => void;
  onRemoveSeat?: (seatId: string) => void;
  /** The project folder, so the file picker opens where the work is. */
  cwd?: string;
  /** Show the shell drawer. Absent when there is no project to open one in. */
  onTerminal?: () => void;
  terminalOpen?: boolean;
  /** End the agent and keep the conversation. Absent when nothing is running:
   *  the next message spawns a fresh one anyway, so there is nothing to offer. */
  onRestart?: () => void;
  /** What the last turn was: which model actually answered, how long it took
   *  and what it cost. All three arrive with the agent's `result`, so there is
   *  nothing to draw until a turn has finished. Drawn on the eyebrow's right
   *  half rather than on a row under the box — see `.composer-last`. */
  model?: string;
  lastDurationMs?: number;
  lastCostUsd?: number;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState(false);
  /** The phone's stand-in for the three pickers: one sheet holding all of them. */
  const [sheet, setSheet] = useState(false);
  /** Who is in this chat, opened by the person+ button. Its OWN state, not the
   *  settings sheet's: card 90 split them, because "who else is here" is not a
   *  setting of the agent you are talking to. */
  const [roomOpen, setRoomOpen] = useState(false);
  /** Which shape that panel takes. A dropdown over the row where there is a row
   *  to hang it over; a sheet from the bottom edge where a 360px bar cannot
   *  hold one. Asked of the browser, not of CSS, because the two are different
   *  ELEMENTS in different places — see lib/media.ts. */
  const wide = useMedia(WIDE);
  const [permMenu, setPermMenu] = useState(false);
  const [pick, setPick] = useState(0);
  const [dismissedCommand, setDismissedCommand] = useState<string | null>(null);
  // Every option list depends on which provider is chosen: the two agents do
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

  // What was in the box before Up was first pressed, so Down can put it back
  // rather than leaving you with the last thing you sent.
  const draft = useRef("");
  const [filePicker, setFilePicker] = useState(false);

  // Codex skills may appear at the caret inside a sentence. Claude's native
  // slash commands remain whole-input; lib/commandMenu owns that distinction.
  const commandInput = commandToken(text, choice.agent, caret);
  const commandQuery = commandInput?.query;
  const commandIntent = commandInput !== undefined;
  const commandKey = commandInput
    ? `${commandInput.start}:${commandInput.end}:${text}`
    : null;
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
  const slashOpen = matches.length > 0 && commandKey !== dismissedCommand;

  // Card 85 — the @ menu, on exactly the same terms as the slash menu above:
  // open while the WHOLE box is one `@word`, gone the moment a space is typed.
  // Absent in a chat with nobody else in it, where an `@` is just a character.
  const atQuery = (seats ?? []).length > 0 ? mentionQuery(text) : undefined;
  const whoList: { key: string; label: string; seat?: Seat }[] =
    atQuery === undefined
      ? []
      : ([
          // Everyone first: it is the one that is always there, and the one
          // whose name never changes.
          { key: "all", label: "all", seat: undefined },
          ...(seats ?? []).map((s) => ({ key: s.id, label: s.name, seat: s })),
        ] as { key: string; label: string; seat?: Seat }[]).filter((w) =>
          mentionMatches(w.label, w.seat?.id, atQuery),
        );
  // One highlight serves both menus. They can never both be open — a box cannot
  // start with a `/` and an `@` at once — which is what makes that safe.
  const atOpen = whoList.length > 0;

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

  // The same, for the @ menu. One highlight serves both, and only one is ever
  // open — a box cannot start with both a `/` and an `@`.
  useEffect(() => {
    setPick((i) => (i < whoList.length ? i : 0));
  }, [whoList.length]);

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

  function completeWho(label: string) {
    setText(completeMention(label));
    areaRef.current?.focus();
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

  /** Take files from a paste or a file input and turn each into an attachment.
   *
   *  Images are saved on the server and travel as a path, because that is what
   *  both agents can use: Codex wants `-i <FILE>`, and Claude needs bytes to
   *  read. Anything that is not an image is refused here rather than silently
   *  dropped later — see `attachPaths` for referencing a file that already
   *  exists on the machine. */
  const attachFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setAttachError("Only images can be pasted. Use “Attach” for other files.");
        continue;
      }
      try {
        const buffer = await file.arrayBuffer();
        // Chunked, because spreading a few million bytes into String.fromCharCode
        // in one call overflows the argument stack.
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const path = await bridge.invoke<string>("save_attachment", {
          dataBase64: btoa(binary),
          extension,
        });
        setAttachError(null);
        setAttached((prev) => [
          ...prev,
          {
            path,
            name: file.name || `pasted.${extension}`,
            isImage: true,
            // The bytes are already here; showing them costs nothing and
            // needs no trip back to the server.
            url: URL.createObjectURL(file),
          },
        ]);
      } catch (err) {
        setAttachError(String((err as Error).message ?? err));
      }
    }
  }, []);

  /** Put text in at the caret, the way a paste does.
   *
   *  `setRangeText` moves the DOM value ahead of React; mirroring it straight
   *  back into state keeps the two in step and leaves the caret where `"end"`
   *  put it — the same trick Cmd+Enter uses to add a line break. */
  const insertText = useCallback((value: string) => {
    const area = areaRef.current;
    if (!area) {
      setText((prev) => prev + value);
      return;
    }
    area.focus();
    area.setRangeText(value, area.selectionStart, area.selectionEnd, "end");
    setText(area.value);
  }, []);

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
    setAttachError(null);

    /** Refused. The box takes focus so the way round it — hold, then Paste —
     *  is where the finger already is. */
    const refused = (err: unknown) => {
      setAttachError(pasteRefusal(err));
      areaRef.current?.focus();
    };

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
        if (files.length) await attachFiles(files);
        if (text) insertText(text);
        if (!files.length && !text) setAttachError("There is nothing to paste.");
      } catch (err) {
        setAttachError(`Could not read what is on the clipboard (${reason(err)}).`);
      }
      return;
    }

    // No `read()` at all — Firefox does not give pages one. Words only, then.
    try {
      const text = await navigator.clipboard.readText();
      if (text) insertText(text);
      else setAttachError("There is nothing to paste.");
    } catch (err) {
      refused(err);
    }
  }, [attachFiles, insertText]);

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
  const drafts = useRef(new Drafts<Attachment>());
  /** The chat whose words the box is currently showing. */
  const shownFor = useRef(session);

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
  useEffect(() => {
    if (shownFor.current === session) return;
    drafts.current.keep(shownFor.current, box.current);
    shownFor.current = session;
    const back = drafts.current.take(session);
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

  /** Words that were queued and never sent, put back where they were typed.
   *
   *  Below the effect above on purpose: arriving in a chat fills the box from
   *  its draft, and these go on the END of that, not instead of it.
   *
   *  The guard is the ARRAY, not a boolean — a re-render with the same words
   *  must be a no-op, or the box would keep re-filling for as long as the
   *  parent held them. */
  const putBackDone = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (!putBack?.length || putBackDone.current === putBack) return;
    putBackDone.current = putBack;
    setText((prev) => withPutBack(prev, putBack));
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

  function send() {
    const value = text.trim();
    if ((!value && attached.length === 0) || disabled) return;
    onSend(value, attached);
    // Remembered before the box is cleared. A repeat of the last message does
    // not stack: two identical entries in a row make Up feel broken.
    setHistory((prev) => {
      const next = prev[0] === value ? prev : [value, ...prev].slice(0, HISTORY_MAX);
      saveHistory(session, next);
      return next;
    });
    setRecall(-1);
    draft.current = "";
    setText("");
    // The message owns them now; these previews are done.
    forget(attached);
    setAttached([]);
    setAttachError(null);
  }

  return (
    <div className="composer" data-composer-style={choice.composerStyle} data-model-id={choice.id}>
      {/* Everything ABOUT the turn sits above the box: the thought being had,
          and under it how long this has taken and how much has been written.
          Both are lines of text, and a line of text in a row of buttons gets
          eight characters and an ellipsis. */}
      {!!thought?.trim() && (
        <div className="think-live" aria-live="off">
          <span className="think-live-text">{thought}</span>
        </div>
      )}

      {/* The eyebrow: the hint on the left, the mode on the right. No new row —
          this one was already here, saying "Enter to send", and it was empty on
          the right the whole time. */}
      <div className="composer-hint">
        <span className="composer-hint-said">
        {/* Work the turn left running behind it rides on this same line: a dot
            in front of the clock, and what it is running after the words. It
            used to have a row of its own directly above, which is a line of
            chrome parked in the chat for as long as the build takes. */}
        <BackgroundNote tasks={background ?? []} busy={busy}>
        {busy ? (
          <Working
            since={turnStartedAt}
            tokens={turnTokens}
            approx={turnApprox}
            activity={activity}
            thinking={thinking}
            effort={eff.label.toLowerCase()}
            background={(background ?? []).length > 0}
            robot={choice.composerStyle}
          />
        ) : (
          <>
            {/* The same robot, standing still: who you are about to talk to,
                in the slot it will dance in. Quieter than the working one
                (`--fg-3`) because between turns this line is a hint, not
                news — and nothing on it moves, which is the whole point of
                putting a character on an idle screen. */}
            <Mascot robot={choice.composerStyle} mood="still" size={16} />
            {activity ?? (TYPES_ON_GLASS ? "Enter for a new line" : "Enter to send · Shift+Enter for a new line")}
          </>
        )}
        </BackgroundNote>
        </span>

        {/* The last turn's receipt, on the half of this row that was empty the
            whole time. It used to be a row of its own UNDER the box — a third
            line of chrome below the thing you type in, holding three facts you
            glance at once. Icons rather than words because it sits at the end
            of a line that a running turn writes a whole sentence on: what it
            says has to survive being read in a quarter of a second, and the
            tooltip spells all of it out. */}
        {(model || lastDurationMs !== undefined || lastCostUsd !== undefined) && (
          <span
            className="composer-last"
            title={[
              model && `Model · ${model}`,
              lastDurationMs !== undefined &&
                `Last turn · ${(lastDurationMs / 1000).toFixed(1)}s`,
              lastCostUsd !== undefined && `Cost · $${lastCostUsd.toFixed(3)}`,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            {model && <span className="composer-last-model">{model}</span>}
            {lastDurationMs !== undefined && (
              <span className="composer-last-item">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                <RollingText>{`${(lastDurationMs / 1000).toFixed(1)}s`}</RollingText>
              </span>
            )}
            {lastCostUsd !== undefined && (
              <span className="composer-last-item">
                {/* No icon here on purpose: the `$` in front of the number is
                    one, and a coin drawn at 11px beside it read as a circled
                    dollar next to a dollar — the same mark twice. */}
                <RollingText>{`$${lastCostUsd.toFixed(3)}`}</RollingText>
              </span>
            )}
          </span>
        )}
      </div>

      {/* Card 85 — who this message is for. Same shape and same keys as the
          slash menu below it, because it is the same gesture: a character that
          opens a list, arrows and Tab to choose, and a space to give up on it. */}
      {atOpen && (
        <div className="slash" role="listbox" aria-label="Send to">
          <div className="slash-head">
            <RollingText>{`${whoList.length} to choose from · Tab to pick`}</RollingText>
          </div>
          <ul className="slash-list">
            {whoList.map((w, i) => (
              <li key={w.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  className={`slash-item ${i === pick ? "is-on" : ""}`}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => completeWho(w.label)}
                >
                  {w.seat ? (
                    <AgentLogo agent={w.seat.agent === "claude" ? "claude" : "codex"} size={12} />
                  ) : null}
                  @{w.label}
                  {/* Said here because this is where the choice is made:
                      picking a seat without knowing it cannot see the project
                      is picking blind. */}
                  {w.seat?.context === "room_only" && (
                    <span className="slash-note">room-only</span>
                  )}
                  {!w.seat && <span className="slash-note">everyone, in turn</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {slashOpen && (
        <div className="slash" role="listbox">
          <div className="slash-head">
            <RollingText>
              {`${matches.length} command${matches.length === 1 ? "" : "s"} · ${nothingToComplete ? "Enter to send" : "Tab to complete"}`}
            </RollingText>
          </div>
          <ul className="slash-list">
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
      {/* Card 78 — the group's own row, above the box.
          It stays MOUNTED when this is not a room, collapsed to nothing. A CSS
          transition cannot run on an element that has been removed, and the ask
          was for it to slide down on the way out as well as up on the way in —
          so an ordinary chat carries one empty, zero-height row here. It shows
          nothing and takes no space; it is not literally nothing, which is the
          price of the animation. */}
      <div className={`room-strip ${room ? "is-open" : ""}`} aria-hidden={!room}>
        <div className="room-strip-inner">
          {room && (
            <>
              {onAsk && onStopRound && (
                <RoundBar
                  seats={seats ?? []}
                  round={round ?? null}
                  onAsk={onAsk}
                  onStop={onStopRound}
                  onNewTopic={onNewTopic}
                  topicDrawn={topicDrawn}
                />
              )}
            </>
          )}
        </div>
      </div>
      <div className="composer-box">
        {(attached.length > 0 || attachError || cleared) && (
          <div className="attach">
            {attached.map((a) => (
              <span className={`chip ${a.isImage ? "is-image" : ""}`} key={a.path} title={a.path}>
                {a.isImage ? <Thumb attachment={a} /> : <PaperIcon />}
                <span className="chip-name">{a.name}</span>
                <button
                  className="chip-x"
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => {
                    forget([a]);
                    setAttached((prev) => prev.filter((x) => x.path !== a.path));
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
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
        <textarea
          ref={areaRef}
          className="composer-input"
          rows={2}
          value={text}
          placeholder={disabled ? "Pick a project first" : `Ask ${choice.name} to…`}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            // Only intercept when the clipboard actually carries a file.
            // Pasting text must stay ordinary pasting.
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length) return;
            e.preventDefault();
            void attachFiles(files);
          }}
          onKeyDown={(e) => {
            // Card 85 — the @ menu takes the same keys the command list does,
            // and gives them back the moment it closes.
            if (atOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPick((i) => (i + 1) % whoList.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPick((i) => (i - 1 + whoList.length) % whoList.length);
                return;
              }
              // Enter and Tab both pick — see `mentionPicks` for why Enter
              // has to, and what it cost to learn.
              if (mentionPicks(e)) {
                e.preventDefault();
                completeWho(whoList[pick].label);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedCommand(commandKey);
                return;
              }
            }
            // While the command list is up it owns the arrows, Tab and Enter —
            // the same keys a shell completion takes.
            if (slashOpen) {
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
              const next = Math.min(recall + 1, history.length - 1);
              if (recall === -1) draft.current = text;
              e.preventDefault();
              setRecall(next);
              setText(history[next]);
              return;
            }
            if (e.key === "ArrowDown" && recall >= 0 && onLastLine) {
              e.preventDefault();
              const next = recall - 1;
              setRecall(next);
              setText(next < 0 ? draft.current : history[next]);
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
        <div className="composer-row">

          {/* One "+", two ways in. They were a clip and a picture standing
              side by side, which read as the same idea drawn twice — see
              `AttachList` for why they are not, and why naming them beats
              guessing at two icons. */}
          <div className="picker">
            <button
              className="picker-btn attach-btn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={attachMenu}
              aria-label="Attach"
              title="Reference a file, or upload an image"
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
            >
              <BinIcon />
            </button>
          )}

          <input
            ref={fileRef}
            className="attach-input"
            type="file"
            accept="image/*"
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
          <div className="composer-settings">
          <div className="picker">
            <button
              className="picker-btn model-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              title={`${choice.name} · ${choice.model}`}
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

          {/* Card 82 — the way somebody else gets into this chat.
              Beside the terminal button because it is the same kind of
              decision: who does this. In EVERY chat, because a seat is what
              makes a chat a group and there is no longer a mode to turn on
              first — the room's own controls appear above the box once
              somebody is actually in it.

              Card 90 — and it opens the ROOM, not the settings sheet. This
              button used to open the same pile as the button beside it, with
              the room fourth in it under Model, Access and Effort; pressing the
              one drawn as a person and getting a model picker is not what the
              icon promised. */}
          {onAddSeat && onRemoveSeat && (
            <div className="picker">
              <button
                className={`picker-btn ${room ? "is-on" : ""}`}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={roomOpen}
                title={room ? "Who is in this chat" : "Add an agent to this chat"}
                aria-label={room ? "Who is in this chat" : "Add an agent to this chat"}
                onClick={() => setRoomOpen((v) => !v)}
              >
                <AddAgentIcon />
              </button>
              {roomOpen &&
                (wide ? (
                  <>
                    <div className="picker-scrim" onClick={() => setRoomOpen(false)} />
                    {/* No Done: a dropdown closes on the scrim, the same as the
                        three beside it. And it does NOT close on adding a seat
                        — adding two is one act, and the list you are adding to
                        is the thing you want to keep watching. */}
                    <div className="picker-menu is-room" role="dialog" aria-label="Who is in this chat">
                      <RoomPanel
                        seats={seats ?? []}
                        onAdd={onAddSeat}
                        onRemove={onRemoveSeat}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="sheet-scrim" onClick={() => setRoomOpen(false)} />
                    <RoomSheet
                      seats={seats ?? []}
                      onAdd={onAddSeat}
                      onRemove={onRemoveSeat}
                      onDone={() => setRoomOpen(false)}
                    />
                  </>
                ))}
            </div>
          )}

          {/* What used to be the status line stood here, between the buttons
              and Send, and took whatever width was left — which on a phone was
              about eight characters of it. It is a line of text, so it is on a
              line of its own now, above the box. This holds its place in the
              row and keeps Send at the right end. */}
          <span className="composer-gap" />

          <ContextMeter tokens={contextTokens} window={contextWindow} />

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
            disabled={!text.trim() || !!disabled}
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
    </div>
  );
}

/** Somebody else joining: two figures, and a plus for the one who is not here
 *  yet. Named on the button rather than in the drawing — the convention every
 *  other icon button in this composer already keeps. */
function AddAgentIcon() {
  return (
    <svg
      width="15"
      height="15"
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
      <path d="M18 8.5v5M15.5 11h5" />
    </svg>
  );
}

/** Round again: an arrow that comes back to where it set off. An open circle
 *  rather than a closed one, because the gap is what stops it reading as a
 *  loading spinner frozen mid-spin. */
function RestartIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 6" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
  );
}

/** Phone only: the same settings as the pickers in the wide bar — but as a
 *  STACK OF PAGES rather than one long scroll.
 *
 *  All three lived in one scroller, in the order the toolbar happened to put
 *  them: the model grid, then five access rows, then effort at the bottom, and
 *  a Done under all of it. Reaching effort meant scrolling past two decisions
 *  you were not making, and the sheet was the only surface in the app where
 *  three questions were asked at once.
 *
 *  So the root asks the one question the button is named after — which model —
 *  and effort and access become ROWS that say what they are set to and open
 *  their own page. A row that reads "Effort · High" answers the question
 *  without being opened at all, which the old sheet could only do by drawing
 *  the whole control.
 *
 *  The chrome is one bar rather than two: a title, and one button at its left
 *  that closes the sheet on the root and goes back on a page. The old Done sat
 *  in a foot under the scroller — a second commit surface for a sheet where
 *  every row already takes effect on the tap that chooses it.
 */
export function SettingsSheet({
  choice,
  onChoice,
  missing,
  noAgents,
  started,
  accessList,
  access,
  onAccess,
  effort,
  onEffort,
  lite,
  onLite,
  onRestart,
  onDone,
}: {
  choice: ModelChoice;
  onChoice: (m: ModelChoice) => void;
  missing: (p: Provider) => boolean;
  noAgents: boolean;
  started: boolean;
  accessList: readonly { id: AccessLevel; label: string; hint: string; bypass?: boolean }[];
  access: AccessLevel;
  onAccess: (a: AccessLevel) => void;
  effort: Effort;
  onEffort: (e: Effort) => void;
  lite: boolean;
  onLite: (on: boolean) => void;
  onRestart?: () => void;
  onDone: () => void;
}) {
  const [page, setPage] = useState<"root" | "effort" | "access">("root");
  /** Which way the last move went. The page coming in slides from the side it
   *  is arriving from, so going back is visibly the reverse of going in. */
  const [back, setBack] = useState(false);

  const open = (p: "effort" | "access") => {
    setBack(false);
    setPage(p);
  };
  const pop = () => {
    setBack(true);
    setPage("root");
  };

  // Off the list rather than off the id, so the word in the row is the same
  // word the page shows. Both can be absent for a moment while a provider
  // switch is in flight — the level or mode belongs to the OTHER agent until
  // the fallback lands.
  const eff = providerFor(choice.agent).efforts.find((e) => e.id === effort);
  const acc = accessList.find((a) => a.id === access);

  const title = page === "root" ? "Chat settings" : page === "effort" ? "Effort" : "Access";

  return (
    <div className="sheet settings-sheet" role="dialog" aria-label="Chat settings">
      {/* Fixed, and above the scroller: the way out of the sheet must never be
          the thing you have to scroll to reach. That was the whole point of
          the foot this replaces. */}
      <div className="sheet-nav">
        <button
          type="button"
          className="sheet-nav-btn"
          aria-label={page === "root" ? "Close" : "Back"}
          title={page === "root" ? "Close" : "Back"}
          onClick={page === "root" ? onDone : pop}
        >
          {page === "root" ? <CloseIcon /> : <BackIcon />}
        </button>
        <span className="sheet-title">{title}</span>
      </div>

      {/* Keyed on the page so React swaps the subtree rather than reusing it:
          the slide restarts, and a page opened after scrolling the root starts
          at its own top instead of inheriting how far down you were. */}
      <div key={page} className={`sheet-body sheet-page ${back ? "is-back" : ""}`}>
        {page === "root" && (
          <div className="sheet-group">
            <div className="sheet-head">Model</div>
            <ModelPicker
              rows
              choice={choice}
              onChoice={onChoice}
              missing={missing}
              noAgents={noAgents}
              started={started}
              lite={lite}
              onLite={onLite}
              onRestart={onRestart}
              afterList={
                <div className="sheet-card">
                  <SheetLink label="Effort" value={eff?.label} onClick={() => open("effort")} />
                  <SheetLink label="Access" value={acc?.label} onClick={() => open("access")} />
                </div>
              }
            />
          </div>
        )}

        {page === "effort" && (
          <div className="sheet-group">
            <EffortList
              agent={choice.agent}
              effort={effort}
              onEffort={onEffort}
              started={started}
            />
          </div>
        )}

        {page === "access" && (
          <div className="sheet-group">
            <div className="sheet-card">
              <AccessList list={accessList} access={access} onPick={onAccess} />
            </div>
            <div className="sheet-foot-note">
              A chat has no way to answer a permission prompt, so this is what
              {" "}{AGENT_NAME[choice.agent]} will do unattended.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A row that says what a setting is on, and opens the page that changes it.
 *
 *  The value is the point of it: a settings list you have to open to read is a
 *  list of questions, and this one answers two of them where it stands. */
function SheetLink({
  label,
  value,
  onClick,
}: {
  label: string;
  /** Absent only while a provider switch is in flight and the chosen level
   *  belongs to the agent being left. */
  value?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="sheet-link" onClick={onClick}>
      <span className="sheet-link-name">{label}</span>
      <span className="sheet-link-value">{value ?? "—"}</span>
      <ChevronIcon />
    </button>
  );
}

/** Effort on a phone: one row per level, the chosen one ticked.
 *
 *  The desktop keeps the slider — it has a mouse, and the scale is worth
 *  drawing when there is room for it. A phone does not: six rungs across
 *  360px is a 55px target for a drag, and the labels under them shrink to
 *  11px to fit. A row is the whole width, says the level in full with the
 *  sentence that explains it, and takes one tap.
 *
 *  Auto is a row here rather than the switch it is on the slider. It was only
 *  ever a switch because a scale has nowhere to put "stop deciding" — a list
 *  has: the end of it. */
export function EffortList({
  agent,
  effort,
  onEffort,
  started,
}: {
  agent: Provider;
  effort: Effort;
  onEffort: (e: Effort) => void;
  /** This conversation already has turns in it, so when the new level takes
   *  hold is worth saying. */
  started: boolean;
}) {
  return (
    <>
      <div className="sheet-card">
        {providerFor(agent).efforts.map((e) => (
          <button
            key={e.id}
            type="button"
            role="menuitemradio"
            aria-checked={e.id === effort}
            className={`picker-item ${e.id === effort ? "is-on" : ""}`}
            onClick={() => {
              // A tap on the level already on is not a change, and putting it
              // through would restart a Codex process to arrive where it is.
              if (e.id === effort) return;
              if (e.id === "ultracode") quake();
              onEffort(e.id);
            }}
          >
            <span className="picker-name">{e.label}</span>
            <span className="picker-model">{e.hint}</span>
            {e.id === effort && (
              <span className="picker-tick" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
      </div>

      {/* What the whole scale costs, and — once there is a chat to change —
          when the change lands in it. */}
      <div className="sheet-foot-note">
        Higher effort means more thorough answers, but takes longer and uses your limits faster.
        {started &&
          (providerFor(agent).capabilities.liveSettings.effort
            ? " Changes this chat straight away."
            : " Applies from your next message.")}
      </div>
    </>
  );
}

/** Back, close, and into a page: the three moves this sheet can make. Drawn
 *  here rather than pulled from the toolbar's icons because these are chrome,
 *  and chrome is thinner than a control. */
function BackIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="sheet-link-caret" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Choosing a model: one tab per agent, then a tile each.
 *
 *  This was a flat list of seven rows, five of them starting with the word
 *  "Claude" — the agent's name written out over and over, and the model's name
 *  pushed to the right of it. The agent moves up into a tab, so it is written
 *  twice instead of seven times, and what is left is the only thing being
 *  chosen: the model, as a grid of tiles you read in one pass.
 *
 *  Picking a TAB changes nothing — it only looks — because switching agent is
 *  the one choice here that can end the chat you are in. Only a tile commits.
 */
function ModelPicker({
  choice,
  onChoice,
  missing,
  noAgents,
  started,
  lite,
  onLite,
  onRestart,
  rows,
  afterList,
}: {
  choice: ModelChoice;
  onChoice: (m: ModelChoice) => void;
  /** True when this machine is known NOT to have that agent. */
  missing: (agent: Provider) => boolean;
  /** Asked, and nothing at all resolved. */
  noAgents: boolean;
  /** This conversation already has turns in it. */
  started: boolean;
  /** New chats start without this machine's skills, hooks and other MCP. */
  lite: boolean;
  onLite: (on: boolean) => void;
  /** End the running agent, keeping the conversation. Absent when there is no
   *  process to end. */
  onRestart?: () => void;
  /** Draw the models as full-width rows with their hints, rather than as the
   *  grid of name tiles the dropdown uses. The phone's sheet sets it. */
  rows?: boolean;
  /** Dropped in straight under the model list, above clean-start and restart.
   *  The sheet puts its effort and access rows here: they are the next thing
   *  you would look for after the model, and clean-start and restart are about
   *  the PROCESS rather than the choice, so they belong under both. The slot
   *  exists because which agent's shelf is showing is this component's own
   *  state, and the rows above it have to move with it. */
  afterList?: ReactNode;
}) {
  const [tab, setTab] = useState<Provider>(choice.agent);
  // Choosing elsewhere — the Agents page, or restoring a chat — moves the tab
  // to whatever is now in use, so reopening this never shows the wrong shelf.
  useEffect(() => setTab(choice.agent), [choice.agent]);

  const agents = PROVIDERS.map((provider) => provider.id);
  const list = providerFor(tab).models;
  const gone = missing(tab);

  return (
    <div className="mp">
      <div className="mp-tabs" role="tablist" aria-label="Agent">
        {agents.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={tab === p}
            className={`mp-tab ${tab === p ? "is-on" : ""}`}
            disabled={missing(p)}
            onClick={() => setTab(p)}
          >
            <span className={`mp-dot ${missing(p) ? "is-off" : ""}`} aria-hidden="true" />
            <span className="mp-tab-name">{AGENT_NAME[p]}</span>
            {choice.agent === p && <span className="mp-tab-now">in use</span>}
          </button>
        ))}
      </div>

      {/* Tiles in a dropdown, rows on a phone. A 300px menu can hold five
          names in a grid you read in one pass; a sheet has the width for the
          line that says what each model is FOR, and the height to spend on
          targets a thumb can hit. Same choice, same order, same tick. */}
      <div className={rows ? "mp-list" : "mp-grid"} role="tabpanel" aria-label={AGENT_NAME[tab]}>
        {list.map((m) => {
          const on = m.id === choice.id;
          return (
            <button
              key={m.id}
              type="button"
              className={`${rows ? "picker-item has-robot" : "mp-card"} ${on ? "is-on" : ""}`}
              aria-pressed={on}
              disabled={gone}
              onClick={() => onChoice(m)}
            >
              {/* Its own robot, standing still. This grid is the only place
                  the cast is ever seen together, and it is the place the
                  choice is made — so the face you will be watching for the
                  next hour is shown while you are picking it, rather than
                  introduced later by a robot you have to guess at. */}
              <Mascot robot={m.composerStyle} mood="still" size={rows ? 18 : 22} />
              <span className={rows ? "picker-name" : "mp-card-name"}>{m.model}</span>
              {rows && <span className="picker-model">{m.hint}</span>}
              {on && (
                <span className={rows ? "picker-tick" : "mp-card-tick"} aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      {afterList}

      {/* Under the tiles because it is the same decision as the model: what
          this chat is made of, chosen before it starts. Claude only — Codex
          keeps its skills in a folder rather than in the config it can be told
          to skip, so the same flags there saved about 2% and are not worth a
          switch that would look like it did something. */}
      {providerFor(tab).capabilities.cleanStart && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={lite}
          className={`mp-lite ${lite ? "is-on" : ""}`}
          title="Start without this machine's skills, hooks or other MCP servers"
          onClick={() => onLite(!lite)}
        >
          <span className="mp-lite-text">
            <span className="mp-lite-name">Clean start</span>
            <span className="mp-lite-hint">
              No skills, hooks or other MCP — about half the context
            </span>
          </span>
          <span className="picker-switch">{lite ? "On" : "Off"}</span>
        </button>
      )}

      {/* Under the clean-start switch because it answers the same question from
          the other end: that one decides what a chat is made of BEFORE it
          starts, this one is how a chat already running gets made again.

          Both live in the model menu rather than beside the terminal button
          because neither is a thing you do — they are what the agent in this
          chat IS. And here it reaches a phone for free: the menu is drawn from
          this one component in two places, the dropdown and the sheet. */}
      {onRestart && (
        <button type="button" className="mp-restart" onClick={onRestart}>
          <span className="mp-lite-text">
            <span className="mp-lite-name">Restart agent</span>
            {/* What it keeps first. The word "restart" on a chat you have been
                talking to for an hour reads as a threat until you know the
                conversation is not the thing being restarted. */}
            <span className="mp-lite-hint">
              Keeps the conversation — your next message picks up new MCP servers and plugins
            </span>
          </span>
          <RestartIcon />
        </button>
      )}

      <ModelNote
        tab={tab}
        choice={choice}
        gone={gone}
        noAgents={noAgents}
        started={started}
        lite={lite}
      />
    </div>
  );
}

/** The one line under the tiles. There is always at most one thing worth
 *  saying, and saying two of them at once is how the old menu ended up with a
 *  paragraph sitting on top of a list. */
function ModelNote({
  tab,
  choice,
  gone,
  noAgents,
  started,
  lite,
}: {
  tab: Provider;
  choice: ModelChoice;
  gone: boolean;
  noAgents: boolean;
  started: boolean;
  lite: boolean;
}) {
  if (noAgents) {
    return <div className="mp-note is-warn">No agent CLI on this machine — a chat cannot start</div>;
  }
  if (gone) {
    return (
      <div className="mp-note is-warn">
        {AGENT_NAME[tab]} is not on this machine — install it to use these
      </div>
    );
  }
  // The flags are read once, when the agent starts. Said here rather than on
  // the switch itself, because it is only true of a chat already running.
  if (started && lite && providerFor(tab).capabilities.cleanStart && choice.agent === tab) {
    return <div className="mp-note">Clean start applies to your next new chat</div>;
  }
  if (!started) return null;
  return tab === choice.agent ? (
    <div className="mp-note">Another {AGENT_NAME[tab]} model keeps this chat going</div>
  ) : (
    <div className="mp-note">{AGENT_NAME[tab]} is a different program — it starts a new chat</div>
  );
}

/** How full this session's context is, next to the send button.
 *
 *  A conversation has a ceiling, and running into it is the thing that ends a
 *  session — so it belongs where you decide whether to keep going, not in a
 *  settings page. Both numbers arrive with the turn's `result`, so this shows
 *  nothing until the first answer has landed rather than guessing.
 *
 *  The ring fills as the context does, and turns amber then red. That is the
 *  whole message; the exact numbers are in the tooltip for when you want them. */
/** The meter itself: bars rising left to right, lit up to the chosen level.
 *
 *  It sits ON the button, so how hard the agent is set to think is readable
 *  from the composer bar without opening anything — which a word alone never
 *  was. "High" tells you nothing about whether anything sits above it.
 *
 *  Auto lights every bar at half strength: not a level, but not off either. */
function EffortBars({ at, of, auto }: { at: number; of: number; auto?: boolean }) {
  const PITCH = 3.4;
  const BAR = 2.2;
  const H = 11;
  const w = of * PITCH - (PITCH - BAR);
  return (
    <svg
      className={`eff-bars ${auto ? "is-auto" : ""}`}
      width={w}
      height={H}
      viewBox={`0 0 ${w} ${H}`}
      aria-hidden="true"
    >
      {Array.from({ length: of }, (_, i) => {
        const h = 3 + (i * (H - 3)) / Math.max(1, of - 1);
        return (
          <rect
            key={i}
            className={auto || i <= at ? "is-lit" : ""}
            x={i * PITCH}
            y={H - h}
            width={BAR}
            height={h}
            rx={1}
          />
        );
      })}
    </svg>
  );
}

/** How long the ultracode quake runs. The CSS animation is the same length,
 *  and the two have to agree: taking the class off is what ends it. */
const QUAKE_MS = 2000;

let quakeTimer = 0;

/** Ultracode sits at the top of the scale, so landing on it is an event, not
 *  one more step: for two seconds the app shakes and its colours run.
 *
 *  The class goes on `body` and the CSS moves everything under it EXCEPT the
 *  slider — the control under your finger has to hold still, or the level you
 *  were aiming at becomes a moving target. */
function quake(): void {
  const body = document.body;
  body.classList.remove("is-ultra");
  // A reflow between off and on, so arriving again restarts the animation
  // instead of being ignored as "that class is already there".
  void body.offsetWidth;
  body.classList.add("is-ultra");
  window.clearTimeout(quakeTimer);
  quakeTimer = window.setTimeout(() => body.classList.remove("is-ultra"), QUAKE_MS);
}

/** Effort as a slider along its rungs, with Auto as its own switch.
 *
 *  This was a dropdown, which is the one control that hides a scale: you saw
 *  the word you were on and nothing about what lay above or below it, and
 *  moving two levels meant opening a menu and aiming at a row. Effort is
 *  ordered — that is its whole shape — so it is a slider: one drag crosses the
 *  range, arrow keys step it, and the rungs are on screen the entire time.
 *
 *  Every level names itself under the track. The one you are on is spelled out
 *  in full above it, with the sentence saying what it costs you, because that
 *  is the part a short tick label cannot carry.
 *
 *  A drag crosses every rung on the way, and each one used to reach the agent
 *  — one decision left five `/effort` turns in the transcript and restarted
 *  the process five times. So the level is sent when the gesture ENDS, not
 *  while it moves: one drag, one change; a tap on a rung or on Auto is its own
 *  whole gesture and lands at once.
 *
 *  It used to be a button UNDER the slider that sent it, which inside the
 *  settings sheet put a second commit button above Done — every other row in
 *  that sheet takes effect on the tap that chooses it, and this one alone
 *  asked twice, with the two buttons stacked and neither saying which was
 *  which. Letting go is the confirmation now, and the hollow fill under your
 *  thumb is what says it has not been sent yet. */
function EffortSlider({
  agent,
  effort,
  onEffort,
  started,
}: {
  agent: Provider;
  effort: Effort;
  onEffort: (e: Effort) => void;
  /** This conversation already has turns in it, so when the new level takes
   *  hold is worth saying. */
  started: boolean;
}) {
  const steps = effortSteps(agent);
  const autoRow = providerFor(agent).efforts.find((e) => e.id === "auto");
  /** The middle when the level belongs to the OTHER agent — the same fallback
   *  the button makes, so the two never disagree while a switch is in flight. */
  const idxOf = (id: Effort) => {
    const i = steps.findIndex((e) => e.id === id);
    return i < 0 ? Math.floor(steps.length / 2) : i;
  };

  /** What the slider is showing, which is not yet what the chat is running. */
  const [draft, setDraft] = useState<Effort>(effort);
  /** The same value, readable the instant it changes. React batches state, so
   *  two moves in one tick would both see the OLD draft — and the quake, which
   *  fires on ARRIVING at Ultracode, would miss or repeat. */
  const shown = useRef<Effort>(effort);
  // The chosen level can change from outside — another agent, a resumed
  // session, the confirm below landing. The draft follows it back.
  useEffect(() => {
    setDraft(effort);
    shown.current = effort;
  }, [effort, agent]);

  const isAuto = draft === "auto";
  /** Where the slider rests while Auto is on. Auto has no rung, and leaving the
   *  thumb wherever it happened to be would make turning Auto off a surprise —
   *  this is the level it goes back to, shown the whole time. */
  const [held, setHeld] = useState(() => idxOf(effort));
  const at = isAuto ? held : idxOf(draft);
  useEffect(() => {
    if (draft !== "auto") setHeld(idxOf(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, agent]);

  const cur = isAuto && autoRow ? autoRow : steps[at];
  /** Moved, but not let go of yet. The fill goes hollow while this is true, so
   *  a slider under your thumb is never read as the level in force. */
  const dirty = draft !== effort;
  const last = steps.length - 1;
  const pct = (i: number) => (i / Math.max(1, last)) * 100;

  /** Dragging while Auto is on turns Auto off at that level, rather than
   *  refusing to move: a dead control is a worse answer than an obvious one. */
  const pickAt = (i: number) => {
    const id = steps[i].id;
    if (id === "ultracode" && shown.current !== "ultracode") quake();
    shown.current = id;
    setHeld(i);
    setDraft(id);
  };

  /** The one place a level reaches the agent: the end of the gesture that chose
   *  it. Off `shown` rather than `draft` because a release lands in the same
   *  tick as the move before it, and state would still hold the old value. */
  const release = () => {
    if (shown.current !== effort) onEffort(shown.current);
  };

  /** A drag can end anywhere — past the end of the track, off the sheet, out of
   *  the window — so the release is listened for on the window rather than on
   *  the input, which only hears the ones that end on top of it. */
  const armRelease = () => {
    const up = () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      release();
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className={`eff ${isAuto ? "is-auto" : ""} ${dirty ? "is-draft" : ""}`}>
      {/* Belongs to the control, not to one of the two things that hold it:
          the dropdown said when a change lands and the phone's sheet did not,
          which is the same control answering the same question twice. */}
      {started && (
        <div className="picker-note">
          {providerFor(agent).capabilities.liveSettings.effort
            ? "Changes this chat straight away"
            : "Applies from your next message"}
        </div>
      )}

      <div className="eff-head">
        <span className="eff-name">{cur.label}</span>
        <span className="eff-hint">{cur.hint}</span>
      </div>

      <div className="eff-slide">
        <div className="eff-track" aria-hidden="true">
          <span className="eff-fill" style={{ width: `${pct(at)}%` }} />
          {steps.map((e, i) => (
            <span
              key={e.id}
              className={`eff-stop ${!isAuto && i <= at ? "is-past" : ""}`}
              style={{ left: `${pct(i)}%` }}
            />
          ))}
        </div>
        <input
          className="eff-range"
          type="range"
          min={0}
          max={last}
          step={1}
          value={at}
          aria-label="Effort"
          aria-valuetext={cur.label}
          onChange={(ev) => pickAt(Number(ev.target.value))}
          onPointerDown={armRelease}
          /* Arrow keys step it one rung at a time, and a held key repeats —
             so the keyboard's end of the gesture is the key coming back up. */
          onKeyUp={release}
        />
      </div>

      {/* Also the click targets: the ends of a scale are where you most often
          want to land, and dragging to one is slower than saying so. */}
      <div className="eff-marks">
        {steps.map((e, i) => (
          <button
            key={e.id}
            type="button"
            className={`eff-mark ${!isAuto && i === at ? "is-on" : ""}`}
            style={
              i === 0
                ? { left: 0 }
                : i === last
                  ? { right: 0 }
                  : { left: `${pct(i)}%`, transform: "translateX(-50%)" }
            }
            title={`${e.label} — ${e.hint}`}
            onClick={() => {
              pickAt(i);
              release();
            }}
          >
            {e.short}
          </button>
        ))}
      </div>

      {autoRow && (
        <button
          type="button"
          className={`eff-auto ${isAuto ? "is-on" : ""}`}
          role="switch"
          aria-checked={isAuto}
          onClick={() => {
            const id = isAuto ? steps[held].id : "auto";
            shown.current = id;
            setDraft(id);
            release();
          }}
        >
          <span className="eff-auto-text">
            <span className="picker-name">{autoRow.label}</span>
            {/* Off, it has to say what it does. On, the line above already
                said that — so it answers the question the greyed-out slider
                raises instead: what happens when you switch this back. */}
            <span className="picker-model">
              {isAuto ? `on — off goes back to ${steps[held].label}` : autoRow.hint}
            </span>
          </span>
          <span className="eff-switch" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ContextMeter({ tokens, window }: { tokens?: number; window?: number }) {
  if (!tokens || !window) return null;
  const percent = Math.min(100, Math.round((tokens / window) * 100));
  const level = percent >= 90 ? "is-danger" : percent >= 70 ? "is-warn" : "";
  // A circle drawn with a dash: the visible run is the used share of it.
  const R = 7;
  const C = 2 * Math.PI * R;

  return (
    <span
      className={`ctx ${level}`}
      title={`Context: ${short(tokens)} of ${short(window)} used (${percent}%)`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="ctx-track" cx="9" cy="9" r={R} fill="none" strokeWidth="2.5" />
        <circle
          className="ctx-fill"
          cx="9"
          cy="9"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * C} ${C}`}
          // Start the run at the top rather than at three o'clock.
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="ctx-val">
        <RollingText>{`${percent}%`}</RollingText>
      </span>
    </span>
  );
}

/** The status line while a turn runs: how long, how much, how hard.
 *
 *  It keeps its own second hand rather than being handed an elapsed time, so
 *  the clock advances between agent events — a turn can go a whole minute
 *  without one. The interval lives and dies with the component, and the
 *  component only exists while the chat is busy, so an idle chat ticks nothing.
 *  Nothing above it re-renders either: the second belongs to this span. */
function Working({
  since,
  tokens,
  approx,
  activity,
  thinking,
  effort,
  background,
  robot,
}: {
  since?: number;
  tokens?: number;
  approx?: boolean;
  activity?: string;
  thinking?: boolean;
  effort: string;
  /** Which of the ten robots is doing this turn — the chosen model's
   *  `composerStyle`. It is the one fact on this line you can read without
   *  reading: a face you already know, moving the way that model moves. */
  robot: ComposerStyle;
  /** Something started by this turn is still running behind it. It reaches the
   *  mascot's eyes rather than a dot of its own — see `BackgroundNote`. */
  background?: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // The clock is the one figure on this line that is NOT rolled. It changes
  // every second, and a wheel that turns and then flashes takes 1.46s to do it
  // — so the line was never once still for the length of a turn, which is the
  // whole of what a reader notices about it. Rolling exists to make a change
  // findable; a change that happens every second finds itself. Tabular digits
  // keep it from nudging the words after it, which was the other half of the
  // wheel's job. The token count and the words keep theirs: they move rarely,
  // and rarely is exactly when the motion earns its keep.
  return (
    <>
      {/* The robot for the model doing the work, dancing its own step. It was
          here before the turn started, standing still on the idle line — a turn
          starting sets it moving rather than making a robot appear, so the
          words after it never shift along. */}
      <Mascot robot={robot} alert={background} mood={thinking ? "think" : "work"} />
      {since !== undefined && (
        <>
          <span className="working-clock">{elapsedLabel(Date.now() - since)}</span>
          {" · "}
        </>
      )}
      <RollingText>
        {workingLine({
          tokens,
          approx,
          activity,
          thinking,
          effort,
        })}
      </RollingText>
    </>
  );
}

/** 357076 → "357k". Token counts are only ever read as a rough size. */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}


function BinIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7.5 7.3 19a1.8 1.8 0 0 0 1.8 1.7h5.8a1.8 1.8 0 0 0 1.8-1.7l.8-11.5" />
      <path d="M10.5 11v6M13.5 11v6" />
    </svg>
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
