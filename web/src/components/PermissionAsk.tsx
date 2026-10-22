// The agent is waiting on you.
//
// `claude -p` cannot prompt, so a permission it was not granted in advance is
// simply denied. The agent asks the server over its own control channel
// instead, and the server asks here — which is why this is the one thing in the
// app that is worth interrupting for. Until it is answered, nothing else in
// that chat moves.
//
// It shows what the terminal's y/n cannot: the tool, the file, and the content
// it is about to write. The answer you would give depends on those, and having
// to guess is how people end up granting everything. The plan `ExitPlanMode`
// asks you to approve arrives here too, and is the clearest case of it: there
// is nothing else on the card to judge it by.
//
// It arrives folded (`lib/cardFold`): the tool, the path, the short facts and
// the answers. A long part is named with its size and opens whole, above the
// answers; nothing on this card is ever cut.
//
// A command is not a long part. It is what is being approved, so it is on the
// folded card whole, up to twelve lines; past that the card shows the lines
// it can, says how many it does not, and holds Allow back until the whole
// command has been drawn. Its first line never stands for it, in the title
// or under it.
//
// Nothing here is cut. Opened, a text is every character of it, scrolling
// inside the card; a text the page cannot draw whole (`lib/cardFold`'s
// `WHOLE_MAX`) is not opened in part, and the card will not take an Allow
// for it at all: it says why, and Deny still answers.
import { useEffect, useId, useMemo, useState } from "react";
import { ASK_WAIT_SECS, askDeadline, askRemaining, askWaitSecs, clockText } from "../lib/askClock";
import { askDetail, changeFacts, isCommand, type ChangeRow } from "../lib/askDetail";
import { bridge } from "../lib/bridge";
import {
  allowHeld, chars, commandDrawn, commandFold, commandOpens, commandShown, commandTitle, count, diffLabel, drawnWhole,
  hiddenIn, hiddenNote, lineFeedAfter, longRowsLabel, marksInText, notShown,
  rowFold, textFold, tooLong, tooLongNote, unseenLines, type CommandAsked, type RowFold,
} from "../lib/cardFold";
import { fileDiff } from "../lib/diff";
import { mcpParts, toolLook, toolWords } from "../lib/toolKind";
import { FoldBody, FoldButton, FoldLine, useFold, WholeText } from "./CardFold";
import { DiffView, FIRST_OPENED } from "./DiffView";
import { ToolIcon } from "./ToolIcon";

export type Ask = {
  provider?: "claude" | "codex" | "pi" | "antigravity";
  id: string;
  chatKey?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown> | null;
  toolUseId?: string;
  cwd?: string;
  /** A question the host raised about one change: answered once, never with
   *  "Always" (a new or changed registered agent). */
  once?: boolean;
  /** Its deadline, when it is not the usual three minutes. */
  answerWithinSecs?: number;
  /** When this page saw it arrive, in ms. The page's own stamp, never the
   *  host's: absent on a question read back after a reload, whose age is
   *  unknown (`lib/askClock`). */
  receivedAt?: number;
};

/** The line beside the buttons, in the three parts the card draws: the one
 *  consequence that matters, with the time left when the page knows it. The
 *  rest of `askNote` is the line's tooltip and, on a card that opens, the
 *  last thing in its detail. */
export function askShortParts(ask: Ask, remaining?: number | null): [string, string | null, string] {
  if (typeof remaining === "number") return ["No answer in ", clockText(remaining), " counts as Deny"];
  const secs = askWaitSecs(ask);
  if (secs === 0) return ["No answer counts as Deny", null, ""];
  const within = secs < ASK_WAIT_SECS ? (secs === 1 ? "1 second" : `${secs} seconds`) : "three minutes";
  return [`No answer within ${within} counts as Deny`, null, ""];
}

/** The same line said in full, in the three parts a clock splits it into:
 *  what holds the agent, the time left when the page knows it, and what
 *  follows. */
export function askNoteParts(ask: Ask, remaining?: number | null): [string, string | null, string] {
  const always = ask.once ? "" : " “Always” lasts until this chat is stopped.";
  if (typeof remaining === "number") {
    return ["Paused until you answer. No answer in ", clockText(remaining), ` counts as Deny.${always}`];
  }
  // No clock: the page did not see the question arrive, or the host does not
  // wait on it at all, and then no length of time is true to name.
  const secs = askWaitSecs(ask);
  if (secs === 0) return [`Paused until you answer. No answer counts as Deny.${always}`, null, ""];
  const within = secs < ASK_WAIT_SECS ? (secs === 1 ? "1 second" : `${secs} seconds`) : "three minutes";
  return [`Paused until you answer. No answer within ${within} counts as Deny.${always}`, null, ""];
}

/** The whole of it: what holds the agent, and for how long.
 *  `remaining` is the seconds left, for a question this page saw arrive. */
export function askNote(ask: Ask, remaining?: number | null): string {
  const [before, clock, after] = askNoteParts(ask, remaining);
  return `${before}${clock ?? ""}${after}`;
}

/** The time, once a second, while a card has a clock to draw. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** A text long enough, or with lines of its own, to want the whole width. */
const isLong = (text: string): boolean => text.includes("\n") || text.length > 48;

/** What one row of a change says. A text is drawn whole with the lines it
 *  came with, never taken apart; a move is what it was, then what it becomes,
 *  one above the other once either is long. */
function ChangeValue({ row }: { row: ChangeRow }) {
  if (!("before" in row)) return <dd>{row.value}</dd>;
  const stacked = isLong(row.before) || isLong(row.after);
  return (
    <dd className={stacked ? "is-stacked" : undefined}>
      <span className="ask-change-was">{row.before}</span>
      <span className="ask-change-arrow"> → </span>
      {row.after === "" ? (
        // Nothing is left of the field. Said in words, set apart from a text
        // that happens to read "cleared": a blank would look like a fault.
        <em className="ask-change-now is-cleared">cleared</em>
      ) : (
        <span className="ask-change-now">{row.after}</span>
      )}
    </dd>
  );
}

/** A row that is folded: what stays of it beside its label. The host's own
 *  line for it comes first, whole, then its size. Never a piece of the value. */
function FoldedValue({ fold }: { fold: Extract<RowFold, { folded: true }> }) {
  return (
    <dd className="is-folded">
      {fold.summary && <span className="ask-change-summary">{fold.summary}</span>}
      <span className="ask-change-size">{fold.note}</span>
    </dd>
  );
}

/** A character of a command that cannot be seen as typed, as its code. */
function Mark({ code }: { code: string }) {
  return <span className="ask-command-mark">{code}</span>;
}

/** A stretch of a command as the card draws it (`lib/cardFold.commandDrawn`):
 *  as written, but for the characters that draw nothing or turn the reading
 *  order round, each of which is its code where it stands. A command with
 *  none of them is the one text it always was. */
function CommandText({ text, lineFeedFollows, written }: {
  text: string;
  /** A line feed follows this text in the command (`lib/cardFold.lineFeedAfter`). */
  lineFeedFollows: boolean;
  /** The command's codes are written into its text, with no mark around
   *  each (`lib/cardFold.marksInText`): decided for the whole command, so
   *  the two texts drawn of it agree with the line under them. */
  written: boolean;
}) {
  // Kept between the clock's ticks: a command can be very long.
  const parts = useMemo(() => commandDrawn(text, lineFeedFollows, written), [text, lineFeedFollows, written]);
  return <>{parts.map((part, i) => (typeof part === "string" ? part : <Mark key={i} code={part.code} />))}</>;
}

/** The path a tool is about to touch, when it names one. */
function target(ask: Ask): string | null {
  const input = ask.toolInput ?? {};
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** One line naming what is being asked for: the tool, and the path when it
 *  names one. Written for the desktop notification, which gets one line and no
 *  diff — but it is the same question this card draws in full. */
export function askSummary(ask: Ask): string {
  const path = target(ask);
  const tool = ask.toolName || "A tool";
  return path ? `${tool} — ${path}` : tool;
}

export function PermissionAsk({ ask, onAnswered, startOpen = false }: {
  ask: Ask;
  onAnswered: (id: string) => void;
  /** Draw it opened. Off everywhere in the app, where a card arrives folded;
   *  on in the tests, which draw static markup and cannot press the control. */
  startOpen?: boolean;
}) {
  const [sending, setSending] = useState<"allow" | "deny" | "always" | null>(null);
  const path = target(ask);
  // The same drawing the card will show once the edit has run — asked BEFORE
  // it runs, so it has no line numbers to give. That is the honest half: what
  // is being decided here is the change, not where in the file it lands.
  // Kept between the clock's ticks, so an opened diff is not drawn again
  // every second.
  const diff = useMemo(() => fileDiff(ask.toolName ?? "", ask.toolInput), [ask.toolName, ask.toolInput]);
  const extra = diff ? null : askDetail(ask.toolInput);
  // A change to the registered agents, as the rows the host sent beside its
  // text. Rows that are not exactly the shape drawn below leave the text.
  const facts = extra?.label === "change" ? changeFacts(ask.toolInput?.changeFacts) : null;
  // The same icon and the same name the chat's own tool cards use. The question
  // is about a call that is one second away from appearing there, so it should
  // already look like it.
  const provider = ask.provider === "codex" ? "Codex" : ask.provider === "pi" ? "Pi" : ask.provider === "antigravity" ? "Antigravity" : "Claude";
  const look = toolLook(ask.toolName ?? "", ask.toolInput);
  // An MCP tool is the exception: it is asked about in words, with its server
  // and its id beside them. The chat's cards keep `mcp(server:tool)`.
  const mcp = mcpParts(ask.toolName ?? "");
  const now = useNow(askDeadline(ask) !== null);
  const [before, clock, after] = askShortParts(ask, askRemaining(ask, now));
  // What is folded, and under which name. A row keeps its label on the card
  // whether or not its value is; a text keeps its first line.
  const rows = (facts?.rows ?? []).map((row) => ({ row, fold: rowFold(row) }));
  const longRows = rows.filter((item) => item.fold.folded);
  // Something that runs is drawn by the command's rule; anything else that
  // is text (a plan, an older host's change) by its opening and its size.
  const runs = extra && !facts && isCommand(extra) ? extra.body : null;
  // Kept between the clock's ticks: a command can be very long.
  const command = useMemo(() => (runs === null ? null : commandFold(runs)), [runs]);
  // Opening shows the rest of it, all of it, or there is nothing to open.
  const opens = !!command && commandOpens(command);
  // One control. Behind it, a long command's own block and the sentences the
  // foot shortens are two boxes; every other card has the one.
  const fold = useFold(ask.id, { parts: opens ? 2 : 1, startOpen });
  // What this card draws of the command, and so what Allow is asked about.
  const shown = useMemo(() => (command ? commandShown(command, fold.shown) : null), [command, fold.shown]);
  const unshown = useMemo(() => (command && shown ? notShown(command, shown) : 0), [command, shown]);
  // What follows each of the two texts drawn, in the command itself.
  const feeds = useMemo(() => (command ? lineFeedAfter(command) : { head: false, rest: false }), [command]);
  // Characters in it that cannot be seen as typed, in all of it: the ones on
  // lines the folded card does not draw are counted too.
  const hidden = useMemo(() => (runs === null ? null : hiddenIn(runs)), [runs]);
  // Too many to set each apart: their codes are written into the text, in
  // both of the texts drawn, and the line under them says so.
  const written = !!hidden && marksInText(hidden.count);
  const prose = extra && !facts && !command ? extra.body : null;
  // A text the page cannot draw whole is not opened in part. Whichever part
  // of the ask it is, the ask cannot be allowed from this card.
  const over = useMemo(() => {
    if (command) return command.tooLong ? command.size : 0;
    if (prose !== null) return tooLong(prose) ? chars(prose) : 0;
    for (const row of facts?.rows ?? []) {
      for (const part of "before" in row ? [row.before, row.after] : [row.value]) {
        if (tooLong(part)) return chars(part);
      }
    }
    return 0;
  }, [command, prose, facts]);
  const text = useMemo(() => (prose !== null && over === 0 ? textFold(prose) : null), [prose, over]);
  const folded = [
    diff && diffLabel(diff),
    over === 0 && longRows.length > 0 && longRowsLabel(longRows.length),
    text && !text.whole && text.rest,
  ];
  const folds = folded.some(Boolean);
  const what = extra?.label === "replacing with" ? "text" : extra?.label ?? "command";
  // Its first command does not name it once any of it is off the card.
  const sized = command ? commandTitle(command, what === "command" ? "command" : "script") : null;
  // What an Allow here would approve: this ask's tool and the exact text it
  // runs, as the host sent it.
  const tool = ask.toolName ?? "";
  const key = extra?.label ?? "";
  const asked = useMemo<CommandAsked | null>(
    () => (runs === null ? null : { id: ask.id, tool, key, text: runs }),
    [runs, ask.id, tool, key],
  );
  // Allow waits for the whole command to have been drawn. Once is enough, and
  // it stays allowed if the card is folded again: for that command. What is
  // kept is the command that was drawn whole, not that something was, and it
  // is compared with the one on the card at every draw. The same id carrying
  // another text has not been read.
  const [whole, setWhole] = useState<CommandAsked | null>(null);
  useEffect(() => {
    // After a draw: it had every character of `asked` in it, or it changes
    // nothing.
    if (asked) setWhole((was) => drawnWhole(was, asked, unshown));
  }, [asked, unshown]);
  const held = !!asked && allowHeld(unshown, whole, asked);
  // Held until it is opened, or unavailable for good: either way the reason
  // is a sentence on the card, and the answers point at it.
  const off = held || over > 0;
  // A command within the bound by its own length and past it as drawn says
  // both sizes: the drawn one is why.
  const why = over > 0 ? tooLongNote(what, over, undefined, undefined, command?.tooLong ? command.drawn : undefined)
    : held ? `Open the full ${what} to allow it.` : "";
  const commandId = useId();
  const whyId = useId();

  const answer = async (choice: "allow" | "deny" | "always") => {
    setSending(choice);
    try {
      await bridge.invoke("permission_decide", {
        id: ask.id,
        decision: choice === "always" ? "allow" : choice,
        // Kept for the rest of THIS chat, and keyed by the program rather than
        // the exact line: someone who allows `pnpm test` means pnpm, not that
        // string. The backend drops the lot when the chat stops.
        remember: choice === "always",
      });
    } catch {
      // The question expired while the tap was in flight. Either way it is no
      // longer ours to answer, so it leaves the screen.
    }
    onAnswered(ask.id);
  };

  return (
    <div className="ask-card permission-card" role="alertdialog" aria-label="Permission needed">
      <div className="ask-card-head">
        <span className="ask-card-dot" aria-hidden="true" />
        {/* A script is something that runs, whatever its first line reads. */}
        <span className="tool-icon" data-kind={sized ? "run" : look.kind} aria-hidden="true">
          <ToolIcon kind={sized ? "run" : look.kind} />
        </span>
        {mcp ? (
          <span className="ask-card-title">
            {/* The whole name stays a hover away: it is what "Always" grants. */}
            {provider} wants to use <strong title={ask.toolName}>{toolWords(mcp.tool)}</strong>
            <span className="ask-card-chips">
              <span className="label-pill">{mcp.serverLabel}</span>
              <span className="label-pill is-mono">{mcp.tool}</span>
            </span>
            {/* What it runs is a script whichever tool runs it. */}
            {sized && <span className="ask-card-script">{sized}</span>}
          </span>
        ) : sized ? (
          <span className="ask-card-title">
            {/* The tool and how much it runs. `bash(echo)` over a script whose
                second line is `rm -rf`, or over one line too long to draw, was
                the card naming the harmless part. */}
            {provider} wants to use <strong>{ask.toolName || "a tool"}</strong>
            <span className="ask-card-script">{sized}</span>
          </span>
        ) : (
          <span className="ask-card-title">
            {provider} wants to use <strong>{ask.toolName ? look.label : "a tool"}</strong>
            {look.scope && <span className="tool-scope">{look.scope}</span>}
          </span>
        )}
      </div>

      {path && (
        <div className="ask-card-path" title={path}>
          <bdi>{path}</bdi>
        </div>
      )}

      {facts && (
        <div className="ask-card-detail ask-change">
          <p className="ask-change-lead">{facts.lead}</p>
          <dl className="ask-change-rows">
            {rows.map(({ row, fold: how }, i) => (
              <div key={i}>
                <dt>{row.label}</dt>
                {how.folded ? <FoldedValue fold={how} /> : <ChangeValue row={row} />}
              </div>
            ))}
          </dl>
        </div>
      )}

      {extra && command && shown && (
        <div className="ask-card-detail ask-command" data-held={off || undefined}>
          <div className="ask-command-top">
            <span className="ask-card-label" id={commandId}>
              {extra.label}{command.lines > 1 ? ` · ${count(command.lines, "line")}` : ""}
            </span>
            {/* Above what it opens, like every disclosure: the answers are on
                the far side of the command however the card is anchored. Only
                where opening is the whole command, which is what it says. */}
            {opens && (
              <FoldButton fold={fold} describedBy={commandId} className="ask-btn is-primary"
                shut={`Open the full ${what}`} open={`Fold the ${what}`} />
            )}
          </div>
          {opens ? (
            (shown.head || fold.shown) && (
              <div className="ask-card-body is-command is-long" data-open={fold.shown || undefined}>
                {shown.head && <pre className="ask-command-text"><CommandText text={shown.head} lineFeedFollows={feeds.head} written={written} /></pre>}
                <FoldBody fold={fold} bounded={false}>
                  {shown.rest !== null && <pre className="ask-command-text"><CommandText text={shown.rest} lineFeedFollows={feeds.rest} written={written} /></pre>}
                </FoldBody>
              </div>
            )
          ) : (
            shown.head && <pre className="ask-card-body is-command"><CommandText text={shown.head} lineFeedFollows={feeds.head} written={written} /></pre>
          )}
          {/* Under the block, at full strength: what the marks in it are,
              and how many the whole command holds. */}
          {hidden && hidden.count > 0 && (() => {
            const note = hiddenNote(hidden.count, what);
            return (
              <p className="ask-command-hidden">
                <strong>{note.count}</strong>{note.rest}<Mark code={hidden.example} />{note.after}
              </p>
            );
          })()}
          {/* The last thing above the answers while any of it is off the
              card: how much, then why the answers are off and what to do. */}
          {unshown > 0 && (
            <p className="ask-command-unseen">
              <strong>{unseenLines(command)}</strong>
              {off && <span className="ask-card-why" id={whyId}> {why}</span>}
            </p>
          )}
          {opens && (
            <FoldBody fold={fold} part={1} bounded={false}>
              <p className="card-fold-note">{askNote(ask)}</p>
            </FoldBody>
          )}
        </div>
      )}

      {extra && text && (
        <div className="ask-card-detail">
          <div className="ask-card-label">{extra.label}</div>
          {text.whole
            ? <pre className="ask-card-body">{extra.body}</pre>
            : <pre className="ask-card-body is-first"><span className="ask-card-first">{text.first}</span></pre>}
        </div>
      )}

      {/* A text the page cannot draw: none of it is drawn as if it were the
          text, and the sentence stands where it would have been. */}
      {over > 0 && !command && (
        <div className="ask-card-detail">
          {extra && !facts && <div className="ask-card-label">{extra.label}</div>}
          <p className="ask-command-unseen">
            <span className="ask-card-why" id={whyId}>{why}</span>
          </p>
        </div>
      )}

      <FoldLine fold={fold} labels={folded} />
      {folds && <FoldBody fold={fold}>
        {diff && (
          <div className="ask-card-detail">
            <div className="ask-card-label">{diff.kind === "create" ? "writing" : "changing"}</div>
            {/* This card has one disclosure, so the diff is whole in it as far
                as the page can draw at once. Past that the diff says how
                many rows it has left, on a control of its own. */}
            <DiffView diff={diff} first={FIRST_OPENED} />
          </div>
        )}
        {over === 0 && longRows.length > 0 && (
          <dl className="ask-change-rows is-whole">
            {longRows.map(({ row }, i) => (
              <div key={i}>
                <dt>{row.label}</dt>
                <ChangeValue row={row} />
              </div>
            ))}
          </dl>
        )}
        {extra && text && !text.whole && (
          <div className="ask-card-detail">
            <div className="ask-card-label">{extra.label}</div>
            <WholeText text={extra.body} />
          </div>
        )}
        <p className="card-fold-note">{askNote(ask)}</p>
      </FoldBody>}

      <div className="ask-card-foot">
        {/* Plain text, not a live region: a clock read out every second would
            bury the question the card is asking. The whole sentence is the
            line's tooltip. */}
        {clock === null ? (
          <p className="ask-card-wait" title={askNote(ask)}>{before}</p>
        ) : (
          <p className="ask-card-wait" title={askNote(ask)}>
            {before}
            <span className="ask-card-clock">{clock}</span>
            {after}
          </p>
        )}
        <div className="ask-card-actions">
          <button
            className="ask-btn is-quiet"
            type="button"
            disabled={!!sending}
            onClick={() => void answer("deny")}
          >
            {sending === "deny" ? "Denying…" : "Deny"}
          </button>
          {!ask.once && (
            <button
              className="ask-btn"
              type="button"
              disabled={!!sending}
              // Off, not disabled: it keeps its place in the tab order with
              // its reason read out, and Deny beside it still answers.
              aria-disabled={off || undefined}
              aria-describedby={off ? whyId : undefined}
              title={
                off ? why
                  : ask.toolName?.toLowerCase() === "bash"
                  ? "Stop asking about this program for the rest of this chat"
                  : "Stop asking about this tool for the rest of this chat"
              }
              onClick={() => { if (!off) void answer("always"); }}
            >
              {sending === "always" ? "Allowing…" : "Always"}
            </button>
          )}
          <button
            className="ask-btn is-primary"
            type="button"
            disabled={!!sending}
            aria-disabled={off || undefined}
            aria-describedby={off ? whyId : undefined}
            title={off ? why : undefined}
            onClick={() => { if (!off) void answer("allow"); }}
          >
            {sending === "allow" ? "Allowing…" : ask.once ? "Allow" : "Allow once"}
          </button>
        </div>
      </div>
    </div>
  );
}
