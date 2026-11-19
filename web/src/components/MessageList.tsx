// The conversation itself.
//
// Each assistant message is a stack of blocks in the order the agent produced
// them: prose, the tool calls it made along the way, more prose. Thinking is
// not here at all: it is watched live above the composer while it happens (see
// Composer), and a transcript of what the agent said to itself is not what
// anybody scrolls back through — `groupRows` drops those blocks.
//
// A subagent's messages are not part of that stack. They belong to the Task
// call that started them and open in the read-only agent focus view, so they
// are lifted out of the conversation here and kept by that call's id. The
// alternative is a reply where a subagent's thinking, tool calls and prose all
// read as the main agent's own.
import { type Kids, Blocks, SubAgent, Compacting, Chevron, UserText, StopMark } from "./MessageBlocks";
import { Prose, ProgressLog, CONFIRM_WINDOW } from "./MessageProse";
import { useJustArrived } from "../lib/justArrived";
export { justAppended } from "../lib/justArrived";
import { glideAt, isJumpControl, GLIDE_MS, GLIDE_MIN_PX, reducedMotion, NEAR_BOTTOM, PLACE_MS, SETTLE_MS, anchorsIn } from "../lib/messageScroll";
export { glideAt, isJumpControl } from "../lib/messageScroll";
import { groupTurns } from "../lib/groupTurns";
import { ChatReadingProvider, ReadingScope, ReadingStateContext, useReadingState } from "../lib/useReadingState";
import { ActionIcon } from "./ActionIcon";
import { readDeskRoute, readTaskBrief } from "../lib/taskBrief";
import { Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { Attached, Message } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";
import { AgentAvatar } from "./AgentAvatar";
import type { Persona } from "../lib/agentPersona";
import { MediaChatContext, MediaReplyContext } from "./MediaSlot";
import { ReopenedChatContext } from "./ReopenedNote";
import { AnswerBubble, AnsweredPlacesContext, AskPlacesContext, ChatQuestionsContext, LooseQuestions, type AskPlaces } from "./InlineQuestions";
import { answerTurnOf, isAnswerTurn, lateAnswers, placeAnswered, placeQuestions, saidLines } from "../lib/questionBlock";
import { setRevealer } from "../lib/questionSight";
import { LiveArrivals } from "./Arrive";
import { useLiveAppend } from "../lib/useArrival";
import { SentFiles } from "./Thumb";
import { turnFold } from "../lib/turnFold";
import { copyText } from "../lib/clipboard";
import { ConfigWorldProvider } from "./ConfigPanel";
import { seatKey, seatTints } from "../lib/seatTint";
import { ConversationMap, conversationMapTurns } from "./ConversationMap";
import { MessageBubble } from "./MessageBubble";
import { DayDivider, MessageTime } from "./MessageTime";
import { dayLabel, dividerBefore, fullLabel, turnTime, watchLocalDay } from "../lib/messageTime";
import { WrapUpNote } from "./CompleteChat";
import { useJob } from "./Background";
import { isJobTurn, jobIdOfTurn, jobTurnBubble } from "../lib/jobs";
import { wrapUpBubble } from "../lib/chatComplete";
import { foldNoticeReplies, isNoticeTurn, noticeReply, noticeText, readNoticeTurn } from "../lib/hostNotice";
import { ChatPersonaContext } from "../lib/agentRoster";
import { HostNotice } from "./HostNotice";
import { initialTurn, needsEarlierPage, orientedFirst, runningTurns, turnWindowStart, TURN_BATCH } from "../lib/messageWindow";
import { dropHeld, repeatsAnother } from "../lib/pressGuard";
import { chatPlaceOf, forgetChatPlace, placeFrom, placeTop, prependPlaceFrom, rememberChatPlace, type ChatPlace } from "../lib/chatPlace";

/** One TURN on screen.
 *
 *  An agent answers with several messages in a row — think, call a tool, think
 *  again, answer — and one bubble per message reads as a stack of fragments
 *  rather than a reply. Consecutive messages from the same side are drawn as a
 *  single turn, so the label appears once and the blocks flow in order. */
function TurnView({
  messages,
  kids,
  agentByTool,
  onOpenAgent,
  last,
  busy,
  tints,
  fresh,
  mapTurnId,
  stopped,
  onWorkOpen,
  hostName,
  hostPersona,
  onCancelQueued,
  onStartQueued,
  onRestoreUnsent,
  onDismissUnsent,
}: {
  stopped?: boolean;
  onWorkOpen?: () => void;
  messages: Message[];
  kids: Kids;
  agentByTool?: ReadonlyMap<string, string>;
  onOpenAgent?: (id: string) => void;
  /** Take back a message still waiting. See the same prop on `MessageList`. */
  onCancelQueued?: (turnId: string) => void;
  /** Make a waiting message the next turn now. */
  onStartQueued?: (turnId: string) => void;
  onRestoreUnsent?: (turnId: string) => void;
  onDismissUnsent?: (turnId: string) => void;
  /** What to call the host — the provider this conversation is running, in its
   *  own name. See the same prop on `MessageList`. */
  hostName?: string;
  hostPersona?: Persona | null;
  /** Arrived while the transcript was already on screen, rather than having
   *  been there when it opened. Only these animate in — see `justArrived`. */
  fresh?: boolean;
  /** The turn is part of the running one (`runningTurns`): the agent can still
   *  add to it, so its work is not folded away as finished. */
  last?: boolean;
  /** Whether the chat is working. A turn can only be waiting its turn while
   *  something else is having one. */
  busy?: boolean;
  /** Which colour each seat in this room speaks in. Empty in an ordinary chat,
   *  which has no seats — see lib/seatTint. */
  tints?: Map<string, number>;
  /** A person-sent turn is one return point on the conversation map. */
  mapTurnId?: string;
}) {
  const [workOpen, setWorkOpen] = useReadingState<boolean>("work", false);
  const wasSettled = useRef(false);
  // Settling is latched only for a turn this view has seen run. One mounted
  // before `busy` was restored (coming back to a chat) was latched as finished
  // and stayed folded after the agent turned out to be working.
  const sawRunning = useRef(false);
  const role = messages[0].role;
  const nameOf = useContext(ChatPersonaContext);
  // One turn is one voice — `groupTurns` breaks on the seat, so every message
  // here has the same one.
  const speaker = messages[0].speaker;
  // And, on a turn you typed, the seat you addressed it to. Absent for the
  // whole room, which is where every message has always gone.
  const to = messages[0].to;
  // The follow-up brief the host was handed once the others had spoken. Drawn
  // as one line rather than as its words: the brief QUOTES every answer above
  // it in full, so printing it would show the whole discussion twice — see
  // lib/relay.
  const relay = messages[0].relay;
  // Card 75 — the skill a typed command actually resolved to. Drawn as a badge
  // rather than as text in the bubble: it is the system's resolution, not
  // something the person said, and it used to appear as a second line of their
  // own message.
  const ranSkill = messages[0].ranSkill;
  const replyTo = messages.find((m) => m.replyTo)?.replyTo;
  const streaming = messages.some((m) => m.streaming);
  const blocks = messages.flatMap((m) => m.blocks);
  const turnLive = !!busy && !!last && !messages.some((m) => m.turnEnd) && !wasSettled.current;
  useLayoutEffect(() => {
    if (turnLive) sawRunning.current = true;
    else if (role === "assistant" && !streaming && sawRunning.current) wasSettled.current = true;
  }, [role, streaming, turnLive]);
  const plan = turnFold(messages, {
    live: turnLive, stopped,
    keepOut: (tool) => kids.has(tool.id) || !!agentByTool?.has(tool.id),
  });
  const foldWork = role === "assistant" && !streaming && !turnLive
    && (plan.hidden.size > 0 || plan.hasProgressWork);
  const progress = messages.flatMap((m) => m.progress ?? []);
  const codexCandidate = [...messages].reverse().find((m) => m.codexCandidate)?.codexCandidate;
  // The answer as it reads on screen. Thinking is left out — it is folded away
  // here for the same reason, it is not the answer — and so are tool calls,
  // whose arguments and results are machinery rather than something you would
  // paste anywhere.
  // Agents mode: a task's first message carries the lead's brief after the
  // person's words. Only the words are drawn; the brief is for the agent.
  const shown = (text: string) => (role === "user" ? readTaskBrief(text)?.task ?? text : text);
  const handedTo = role === "user"
    ? blocks.map((b) => b.kind === "text" ? readTaskBrief(b.text)?.lead : undefined).find(Boolean)
    : undefined;
  const deskRoute = role === "user" ? blocks.flatMap((b) => b.kind === "text" ? [readDeskRoute(shown(b.text))] : []).find(Boolean) : undefined;
  const answer = blocks
    .filter((b) => b.kind === "text")
    .map((b) => shown((b as { text: string }).text))
    .join("\n\n")
    .trim();

  // Only backend ownership enables queue actions. Missing provider output
  // can also mean connecting, already handed over, or a failed request.
  const message = messages[0];
  const unsent = role === "user" && messages.some((m) => m.queueLost && !m.echo && !m.takenUp);
  const queued = role === "user" && !unsent && !message.echo && !message.takenUp
    && message.delivery === "queued";
  const waitingId = queued ? message.turnId : undefined;
  const cancel = onCancelQueued && waitingId ? () => onCancelQueued(waitingId) : undefined;
  const start = onStartQueued && waitingId ? () => onStartQueued(waitingId) : undefined;
  // The host's wrap-up turn of a completion is not something the person said.
  const completion = role === "user" ? wrapUpBubble(message) : null;
  // Nor the turn that tells an agent a job it registered ended (`lib/jobs`),
  // named from the job the page holds, else from the turn's own first line.
  const jobTurn = role === "user" && isJobTurn(message.turnId) ? message.turnId! : null;
  const wakeJob = useJob(jobTurn ? jobIdOfTurn(jobTurn) : null);
  const jobEnd = jobTurn ? jobTurnBubble(message, wakeJob?.job, answer) : null;
  /** One of the host's own turns: named, with its words behind a disclosure. */
  const wrapUp = completion;

  // Cards 80 and 81 — a turn made ENTIRELY of things that HAPPENED takes no
  // name. A compaction is not something Claude said, and a `/model` answered by
  // the CLI never reached Claude at all; a name over either one attributes it to
  // someone who did not do it. A reply with prose in it is still somebody
  // talking, event blocks beside the prose or not.
  //
  // A peer's message is the same rule a step further out: it is not even this
  // machine's agent talking. Its own row says who said it, and "Claude" over
  // the top of that names the one participant who did not.
  const allEvent =
    blocks.length > 0 &&
    blocks.every((b) => b.kind === "compacted" || b.kind === "notice" || b.kind === "peer" || b.kind === "memory" || b.kind === "planAutoApproved" || b.kind === "reopened" || b.kind === "answered");

  // A turn that is only the host's one-line "plan auto-approved" fold sits close
  // to the lines around it (`.msg-event`, styles.css): it is bookkeeping between
  // replies, not a turn of its own that wants a turn's gap.
  const eventLine = blocks.length > 0 && blocks.every((b) => b.kind === "planAutoApproved");

  // What was attached to this turn. Taken across the messages the turn is made
  // of, and de-duplicated by path: the agent echoes a user turn back, so the
  // same file can arrive twice by two routes.
  const files = useMemo(() => {
    const seen = new Map<string, Attached>();
    for (const m of messages) for (const a of m.attachments ?? []) seen.set(a.path, a);
    return [...seen.values()];
  }, [messages]);

  // Answers that came back after their `ask_user` call had ended arrive as a
  // turn of the host's. It is the person's answer and not a message of
  // theirs: the bubble alone, with nothing on it that acts.
  const lateAnswer = role === "user" ? answerTurnOf(message) : null;
  const lateLines = lateAnswer ? saidLines(lateAnswer) : [];
  if (lateLines.length) {
    const waits = !message.echo && !message.takenUp;
    return (
      <article className={`msg msg-answer ${fresh ? "is-new" : ""}`}>
        <AnswerBubble lines={lateLines}
          status={waits && message.queueLost ? "Not delivered" : waits && message.delivery === "queued" ? "Sent when the current reply ends" : undefined} />
        <MessageTime at={message.at} />
      </article>
    );
  }

  // The job's wake-up is a host event, although the provider receives it as a
  // user turn. Keep it out of the person's bubble and its delivery/actions.
  if (jobEnd) {
    return (
      <article className={`msg msg-host ${fresh ? "is-new" : ""}`} aria-label="OctiqFlow job notification">
        <div className="msg-body">
          <div className="job-wake-line">
            <WrapUpNote label={jobEnd.label} detail={jobEnd.detail} text={answer} mark="job" />
            {cancel && <button className="job-wake-cancel" type="button" disabled={!!message.queueAction}
              title="Take this turn back. The agent is not told that the job ended."
              aria-label="Cancel telling the agent the job ended" onClick={cancel} data-icon-action>
              <ActionIcon name="dismiss" label="Cancel" />
            </button>}
          </div>
          {message.queueError && <p className="message-delivery-error" role="alert">{message.queueError}</p>}
        </div>
      </article>
    );
  }

  if (role === "user" && isNoticeTurn(message.turnId)) {
    const notices = readNoticeTurn(message.turnId, noticeText(messages));
    const reply = noticeReply(messages);
    return <article className={`msg msg-host ${fresh ? "is-new" : ""}`} aria-label="OctiqFlow host notifications">
      <div className="msg-body">
        <HostNotice notices={notices} coordinator={hostPersona?.name || "Coordinator"} nameOf={nameOf} reply={reply ?? undefined} />
        <SentFiles files={files} />
      </div>
    </article>;
  }

  if (relay && !wrapUp) {
    return (
      <article className="msg msg-relay">
        <span aria-hidden="true">↳</span> {relay}
      </article>
    );
  }

  // A guest's turn, drawn as its own block. The host keeps the plain full-width
  // prose every chat has always had — it is the voice a room never has to
  // identify, and marking it too would make a one-seat room read as two
  // strangers talking.
  const tint = speaker ? tints?.get(seatKey(speaker)) : undefined;

  return (
    <article
      className={`msg msg-${role} ${eventLine ? "msg-event" : ""} ${deskRoute ? "msg-desk-route" : ""} ${speaker ? "msg-seat" : ""} ${queued ? "is-queued" : ""} ${
        fresh ? "is-new" : ""
      }`}
      data-tint={tint}
      data-map-turn={mapTurnId}
      data-reading-turn={messages[0].id}
    >
      {/* Above your own words, because it changes how they read: "check this"
          means something different said to the room than said to one agent. */}
      {role === "user" && to && <div className="msg-to">to {to.name}</div>}
      {handedTo && !deskRoute && <div className="msg-to">task for {handedTo}</div>}
      {role === "user" && ranSkill && (
        <div className="msg-ran" title="The skill this command resolved to">
          {ranSkill}
        </div>
      )}
      {role === "assistant" && !allEvent && (
        <div className="msg-role">
          {/* Whoever wrote it. The host has no seat and keeps the plain word,
              with no mark beside it; a seat says its own name AND draws its
              mark, because in a room "which of these is talking" is the first
              question the eye asks.

              The word is the PROVIDER's, not the literal "Claude" it was until
              Codex became selectable — a Codex chat labelled every one of its
              own answers "Claude", which is the one thing a name over a reply
              must never do. */}
          {speaker ? (
            <>
              <AgentLogo agent={speaker.agent === "claude" ? "claude" : "codex"} size={13} />
              {speaker.name}
            </>
          ) : hostPersona ? (
            <>
              <AgentAvatar name={hostPersona.name} avatar={hostPersona.avatar} id={hostPersona.id ?? hostPersona.name} size={40} removed={hostPersona.removed} decorative />
              {hostPersona.name}
            </>
          ) : (
            hostName ?? "Claude"
          )}
        </div>
      )}
      {role === "assistant" && replyTo && (
        <div className="msg-reply" title={`Replying to: ${replyTo.preview}`}>
          <span className="msg-reply-label">Replying to</span>
          <span className="msg-reply-preview">{replyTo.preview}</span>
        </div>
      )}
      <MediaReplyContext.Provider value={message.id}>
      <MessageBubble user={role === "user"} message={message} wrapUp={!!completion} onStart={start} onCancel={cancel}
        onRestore={!wrapUp && (unsent || message.delivery === "unknown") && !message.echo && !message.takenUp && onRestoreUnsent && message.turnId ? () => onRestoreUnsent(message.turnId!) : undefined}
        onDismiss={unsent && onDismissUnsent && message.turnId ? () => onDismissUnsent(message.turnId!) : undefined}
        footer={role === "user" && answer && !wrapUp ? <CopyAnswer text={answer} what="message" /> : undefined}>

        {/* Above the words, the way they sit above the box while you attach
            them — and because a message whose words are "look at this" makes no
            sense until you have seen the picture it came with. */}
        {deskRoute && <header className="desk-route-head">
          <span className="desk-route-icon" aria-hidden="true">↗</span>
          <div><span className="desk-route-label">Front desk handoff</span>
            <strong>{handedTo ? `To ${handedTo}` : "Agent conversation"}</strong></div>
          <span className="desk-route-confirmed">Confirmed by you</span>
        </header>}
        <SentFiles files={files} />
        {foldWork && <div className="turn-work">
          <button type="button" className="turn-work-head" aria-expanded={workOpen}
            onClick={() => { if (!workOpen) onWorkOpen?.(); setWorkOpen(!workOpen); }}>
            <Chevron open={workOpen} />
            <span className="turn-work-label">{plan.label}</span>
            {plan.failed > 0 && <span className={`turn-work-failed${[...plan.failures].some((id) => plan.danger.has(id)) ? " is-danger" : ""}`}> · {plan.failed} failed</span>}
          </button>
        </div>}
        {foldWork && !workOpen && plan.lastProgress && <Prose text={plan.lastProgress} animate={false} />}
        {role === "assistant" && (!foldWork || workOpen) && (
          <ProgressLog updates={progress} candidate={codexCandidate} streaming={streaming} />
        )}
        {/* Each message you sent is cut on its own — two long pastes in a row
            are two messages, and one "show more" over both would open the pair.
            Anything else in a user turn (there is nothing today) still goes the
            ordinary way. */}
        {wrapUp ? (
          <WrapUpNote label={wrapUp.label} detail={wrapUp.detail} text={answer} mark="complete" />
        ) : role === "user" && blocks.every((b) => b.kind === "text") ? (
          blocks.map((b, i) => <ReadingScope key={i} id={`user:${i}`}><UserText text={deskRoute ? readDeskRoute(shown((b as { text: string }).text))?.text ?? shown((b as { text: string }).text) : shown((b as { text: string }).text)} /></ReadingScope>)
        ) : (
          <Blocks
            blocks={blocks}
            hidden={foldWork && !workOpen ? plan.hidden : undefined}
            danger={role === "assistant" ? plan.danger : undefined}
            streaming={streaming}
            kids={kids}
            agentByTool={agentByTool}
            onOpenAgent={onOpenAgent}
          />
        )}
        {deskRoute && <div className="desk-route-source">Handed over by {deskRoute.desk}</div>}
        {streaming && blocks.length === 0 && (
          <div className="dots" aria-label={hostPersona ? `${hostPersona.name} is working` : "working"} />
        )}
        {/* Copy, once the turn is over and there is prose worth taking.
            (The files the turn touched used to sit on this row too. They are a
            whole-session question now — see components/SessionFiles.)

            "Over" is not the same as "not streaming", and getting that wrong is
            what made this blink. A turn is a RUN of assistant messages, and the
            agent ends one message and starts another at every tool call — so
            mid-turn there are gaps, several a minute, where nothing is
            streaming and the footer would draw itself and then vanish again. A
            permission dialog holds one of those gaps open for as long as it
            takes to answer, which is how the flicker became impossible to
            miss. The bottom turn is the only one a working agent can still add
            to, so that is the one that has to wait for it to stop. */}
        {/* The time belongs to every visible agent turn, a tool-only or
            thinking-only one too; Copy stays with the prose. While the turn
            is still going the row is held out of sight at its full size, so
            nothing moves when it ends. */}
        {role === "assistant" && (answer || turnTime(messages, "assistant") !== undefined) && (
          <div className={`msg-foot${streaming || turnLive ? " is-placeholder" : ""}`}>
            {answer
              ? streaming || turnLive
                ? <span className="msg-copy" aria-hidden="true"><ActionIcon name="copy" /></span>
                : <CopyAnswer text={answer} what="reply" />
              : null}
            <MessageTime at={turnTime(messages, "assistant")} />
          </div>
        )}
      </MessageBubble>
      </MediaReplyContext.Provider>
    </article>
  );
}

/** Copy a whole turn — a reply, or something you said.
 *
 *  Says whether it worked rather than always claiming success: on a plain-http
 *  origin the copy goes through a fallback that can fail outright, and "copied"
 *  over an unchanged clipboard is worse than being told it did not. */
function CopyAnswer({ text, what }: { text: string; what: "reply" | "message" }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  return (
    <div className="msg-actions">
      <button
        className={`msg-copy ${state === "done" ? "is-done" : ""}`}
        type="button"
        title={state === "done" ? "Copied" : state === "failed" ? "Could not copy" : `Copy this ${what}`}
        onClick={async () => {
          const ok = await copyText(text);
          setState(ok ? "done" : "failed");
          setTimeout(() => setState("idle"), 1600);
        }}
       data-icon-action aria-label={state === "done" ? "Copied" : state === "failed" ? "Could not copy" : `Copy this ${what}`} aria-description={`Copy this ${what}`}>
        <ActionIcon name={state === "done" ? "allow" : "copy"} />
      </button>
    </div>
  );
}

/** The whole transcript.
 *
 *  MEMOISED, and it has to be. Every loaded chat lives in one state object in
 *  App, so a `content_block_delta` for a conversation NOT on screen — one of
 *  eight agents working in the background — re-rendered App, and this rebuilt
 *  the entire element tree of the chat you were actually reading. On a long
 *  transcript that is thousands of nodes for a message you cannot see; it
 *  measured at ~55 ms per foreign delta on an idle machine.
 *
 *  Everything it is handed must therefore hold still between renders: the
 *  callbacks are `useCallback`ed in App and read the loaded chats through
 *  `chatsRef` rather than taking `chats` as a dependency, which is what used to
 *  give this a new `onSetting` on every delta and make the memo do nothing. */
/** `Date.now()` as of the last time the local date changed (or the mount):
 *  one timer to the next local midnight, no per-second tick. */
function useLocalDay(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => watchLocalDay(() => setNow(Date.now())), []);
  return now;
}

const MessageListBody = function MessageList({
  messages,
  busy,
  stoppedAt,
  compactingSince,
  conversationId,
  onSetting,
  agentByTool,
  onOpenAgent,
  hostName,
  hostPersona,
  onCancelQueued,
  onStartQueued,
  onRestoreUnsent,
  onDismissUnsent,
  hasEarlier = false,
  loadingEarlier = false,
  earlierError,
  onLoadEarlier,
  onLoadLatest,
  tail,
  head,
  marks,
}: {
  messages: Message[];
  /** Drawn after the last turn, inside the transcript: a lead's plan card,
   *  which lives at the end of the conversation because it is always the
   *  CURRENT plan, read from the ledger, never a copy frozen into history.
   *  Must be memoised by the caller like every other prop here. */
  tail?: React.ReactNode;
  /** Drawn before the first turn, and scrolled away with it: history about
   *  the whole conversation, such as the handover a chat was started by.
   *  Memoised by the caller, like `tail`. */
  head?: React.ReactNode;
  /** Drawn under the turn holding the message with that id: something that
   *  happened at that point of the conversation and stays there, such as a
   *  settled handover. While that turn is behind "Load earlier messages" it
   *  is drawn after `head` instead, so it is never missing from the page.
   *  Memoised by the caller, like `tail`. */
  marks?: ReadonlyMap<string, React.ReactNode>;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  earlierError?: string;
  onLoadEarlier?: (ready?: () => Promise<void>) => Promise<void>;
  onLoadLatest?: () => Promise<void>;
  busy: boolean;
  stoppedAt?: string;
  /** What to call the host over its replies: the name of the PROVIDER this
   *  conversation runs, from `providerFor`.
   *
   *  A conversation is only ever one provider — changing it cannot be done in
   *  place at any price (a Claude session id means nothing to Codex), so
   *  switching providers opens a fresh chat instead. That is what makes one name for
   *  the whole transcript right rather than a guess: there are no turns in here
   *  that some other agent wrote.
   *
   *  Defaults to "Claude" for a caller that does not know — which is only the
   *  tests; the app always passes it. */
  hostName?: string;
  /** Agents mode: the registered agent this conversation is with. Its name
   *  and face sign every reply the host writes, in place of the provider's
   *  word; the provider stays in the details. Absent in an ordinary chat. */
  hostPersona?: Persona | null;
  /** Take back a message the agent has not been given yet, by the id it was
   *  sent under. Absent where nothing can be sent in the first place (the agent
   *  rail's read-only transcript), and a queued message there is then only a
   *  clock, as it always was. */
  onCancelQueued?: (turnId: string) => void;
  /** Stop the current turn and start this named queued message next. */
  onStartQueued?: (turnId: string) => void;
  /** Restore text from a prompt the backend no longer holds; never sends it. */
  onRestoreUnsent?: (turnId: string) => void;
  /** Remove a prompt the backend no longer holds from the durable transcript. */
  onDismissUnsent?: (turnId: string) => void;
  /** Send a line to the agent as though it had been typed — how the `/config`
   *  panel changes a setting. Absent where there is no chat to send into (the
   *  agent rail's read-only transcript), and the panel then only reads. */
  onSetting?: (line: string) => void;
  /** A task's tool-use id resolves to the persistent read-only agent run it
   * started. Kept outside the transcript so the focus view stays live. */
  agentByTool?: ReadonlyMap<string, string>;
  onOpenAgent?: (id: string) => void;
  /** When a compaction started, or absent when none is running. It is drawn
   *  at the foot of the conversation, in the SAME line the finished boundary
   *  leaves behind — one thing that starts, runs, and settles in place, rather
   *  than a bar somewhere else that vanishes and is replaced by a rule here. */
  compactingSince?: number;
  /** Which conversation is on screen. This component is REUSED across chats
   *  rather than remounted — a remount would restart the typewriter on a chat
   *  that is still streaming — so it needs telling when the content underneath
   *  it has been swapped for a different conversation. */
  conversationId?: string;
}) {
  const { state: readingState } = useContext(ReadingStateContext);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  const morePending = useRef(false);
  const prependAnchor = useRef<{ id?: string; first?: string; at: ChatPlace; server: boolean; orient?: { stuck: boolean } } | null>(null);
  const lastScroll = useRef(0);
  const touching = useRef(false);
  // Only follow the stream while the reader is already at the bottom: yanking
  // the view down while someone is reading back is the worst thing a streaming
  // chat can do.
  const stick = useRef(true);

  // Whether a scroll event came from the READER. Not every scroll event does:
  // pinning to the bottom fires one, and so does content reflowing. Judging
  // "have they scrolled away?" from those was the bug — a file list appearing
  // below the fold looked exactly like the reader scrolling up, so sticking
  // switched itself off and the view stopped short of the bottom.
  //
  // A real gesture always announces itself first (wheel, touch, key, or a grab
  // of the scrollbar), so only scroll events that follow one are believed.
  const gesture = useRef(false);

  // Whether the reader has left the bottom, which is the only thing on this
  // path that has to be STATE rather than a ref: it draws the jump button.
  // Set on every believed scroll event, which sounds expensive and is not —
  // React compares the value and skips the render when the answer is the same,
  // so a flick through a long transcript re-renders twice, at the two moments
  // the answer actually changed.
  const [away, setAway] = useState(false);

  // The rAF handle of a glide in flight, or 0. It is also the flag that holds
  // the instant pin below OFF while one runs: two things writing `scrollTop` in
  // the same frame is what a jerky scroll IS, and the glide is already tracking
  // the bottom for itself.
  const glide = useRef(0);

  // Which conversation the scroll listeners below are looking at. They are
  // attached once and this list is REUSED across chats, so a closure over the
  // id would name the first chat opened for the life of the page. Set by the
  // swap effect, before anything can scroll the new transcript.
  const conv = useRef(conversationId);

  // The place this chat will be remembered at, and the timer that will write
  // it. Held rather than written on every scroll event: one flick fires dozens
  // of them, and where the reader ENDED UP is the only one worth keeping.
  // `at: null` is "at the bottom" — the state that is remembered by having no
  // record at all (see lib/chatPlace).
  const pending = useRef<{ id: string; at: ChatPlace | null } | null>(null);
  const writing = useRef(0);

  // A place being restored, and how long it is held against a transcript that
  // is still settling. Null once the reader takes over, or once the hold
  // expires — past that a height change is the conversation growing.
  const resuming = useRef<{ at: ChatPlace; until: number } | null>(null);
  const holdTimer = useRef(0);
  // Hover protects controls only until pointer leave. Explicit reading input
  // still changes stick permanently through mark().
  const hoveredMedia = useRef<{ player: Element; at: ChatPlace } | null>(null);
  const releasePlace = () => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = 0;
    resuming.current = null;
    hoveredMedia.current = null;
    if (scrollerRef.current) scrollerRef.current.style.removeProperty("overflow-anchor");
  };
  const holdPlace = (at: ChatPlace) => {
    releasePlace();
    const back = { at, until: performance.now() + SETTLE_MS };
    resuming.current = back;
    // Only one anchor owns the view while restoring. Outside this hold the
    // browser can still anchor ordinary reading and momentum scrolling.
    if (scrollerRef.current) scrollerRef.current.style.overflowAnchor = "none";
    // Quiet transcripts still need to hand anchoring back to the browser at
    // the deadline. Waiting for another resize would miss its first layout.
    holdTimer.current = window.setTimeout(() => {
      if (resuming.current !== back) return;
      restorePlace(back.at);
      releasePlace();
    }, SETTLE_MS);
  };
  // A restore writes scrollTop and later receives its own scroll event. That
  // event is not another reader gesture, even if the click/flick that loaded
  // the page is still inside the gesture window.
  const correctedTop = useRef<number | null>(null);
  const restorePlace = (at: ChatPlace) => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = placeTop(at, anchorsIn(el), el.scrollHeight - el.clientHeight);
    if (el.scrollTop === top) return;
    el.scrollTop = top;
    correctedTop.current = el.scrollTop;
  };

  // Only reads refs, so the copy an effect closes over on the first render
  // stays correct for the life of the component.
  const stopGlide = () => {
    if (glide.current) cancelAnimationFrame(glide.current);
    glide.current = 0;
  };

  /** Write the held place down now.
   *
   *  It never re-measures: by the time this runs the scroller may already be
   *  showing another conversation, or be detached from the page entirely — and
   *  an element that is not on the page reports a scroll of zero, which would
   *  write "the top" over the place we are trying to keep. */
  const flushPlace = () => {
    window.clearTimeout(writing.current);
    writing.current = 0;
    const held = pending.current;
    pending.current = null;
    if (!held) return;
    if (held.at) rememberChatPlace(held.id, held.at);
    else forgetChatPlace(held.id);
  };

  /** Note where this chat is being left, to be written a moment later.
   *
   *  Called from every scroll event, believed or not: a map jump and the
   *  keyboard move the reader without a wheel or a finger, and where they land
   *  is as much their place as a flick's. What it will not do is take a
   *  position from under the STREAM — a pin that has not yet caught up with a
   *  growing transcript looks exactly like a reader part-way up, and writing
   *  that down would send them back into the middle of a chat they were
   *  reading live. */
  const savePlace = () => {
    const el = scrollerRef.current;
    const id = conv.current;
    if (!el || !id || glide.current || resuming.current || hoveredMedia.current) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (!atBottom && stick.current) return;
    pending.current = { id, at: atBottom ? null : placeFrom(el.scrollTop, anchorsIn(el)) };
    window.clearTimeout(writing.current);
    writing.current = window.setTimeout(flushPlace, PLACE_MS);
  };

  /** Travel to the bottom over `GLIDE_MS` rather than arriving there. The frame
   *  math, and why the target is re-read every frame, is in `glideAt`. */
  const glideToBottom = (travelMs?: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    stopGlide();

    const to = el.scrollHeight - el.clientHeight;

    // Where the travel starts. Normally where the reader already is — but the
    // jump button can be pressed from the top of a very long transcript, and
    // easing through twenty thousand pixels is a grey blur with no information
    // in it. So the far part is covered instantly and only the last screenful
    // is animated: what the reader sees is the end of the conversation sliding
    // up into place, which is the part that tells them where they landed.
    const reach = Math.max(el.clientHeight * 1.5, 400);
    const from = Math.max(el.scrollTop, to - reach);

    // Nothing worth watching: no room to travel, a hair's width of it, or a
    // reader who has asked not to be moved smoothly.
    if (to - from < GLIDE_MIN_PX || reducedMotion()) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (from !== el.scrollTop) el.scrollTop = from;

    const t0 = performance.now();
    const duration = travelMs ?? (el.closest(".focus-mode") ? 440 : GLIDE_MS);
    const step = (now: number) => {
      const p = (now - t0) / duration;
      el.scrollTop = glideAt(from, el.scrollHeight - el.clientHeight, p);
      if (p < 1) {
        glide.current = requestAnimationFrame(step);
        return;
      }
      // Cleared BEFORE the closing pin, so the observer is live again for
      // whatever else the same frame brings.
      glide.current = 0;
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    glide.current = requestAnimationFrame(step);
  };

  /** The jump button. Going back to the bottom is also a decision to FOLLOW
   *  again — a reader who has caught up wants the next reply to arrive under
   *  them, not to have to press this after every turn. */
  const jumpToBottom = (travelMs?: number) => {
    stick.current = true;
    setAway(false);
    // Said now rather than left to the scroll events the glide produces: this
    // press is the decision, and it should hold even if the travel is cut
    // short by the next thing the reader does.
    releasePlace();
    prependAnchor.current = null;
    if (conv.current) pending.current = { id: conv.current, at: null };
    flushPlace();
    glideToBottom(travelMs);
  };

  // A past window ends before the live tail. Its bottom is not "caught up",
  // even when no new delta has arrived since paging. Keep the way back in the
  // viewport for EVERY past window, without retaining or counting live output.
  const jumpVisible = !!onLoadLatest || away;
  const latestRequested = useRef<{ id: string | undefined; pending: boolean } | null>(null);
  useLayoutEffect(() => {
    const requested = latestRequested.current;
    if (!requested || loadingEarlier) return;
    latestRequested.current = null;
    // A failed read leaves onLoadLatest in place; a chat switch belongs to
    // that chat's restore effect. Only a successful, explicit return follows.
    if (requested.id === conversationId && !onLoadLatest) jumpToBottom(180);
  }, [conversationId, loadingEarlier, onLoadLatest]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let until = 0;
    const mark = (event?: Event) => {
      if (isJumpControl(event?.target ?? null)) return;
      if (event) correctedTop.current = null;
      if (event) lastScroll.current = performance.now();
      gesture.current = true;
      // The reader has taken the scroller. An animation still running under
      // their finger fights them for it, and they win either way — so it ends
      // here rather than being scrolled against. A place being restored is the
      // same fight, and goes the same way: where they are now is their place.
      stopGlide();
      releasePlace();
      window.clearTimeout(until);
      // Long enough to cover the scroll events one flick produces, short
      // enough that it cannot be mistaken for the next thing that happens.
      until = window.setTimeout(() => (gesture.current = false), 400);
      if (event?.target instanceof Element && event.target.closest("video, audio")) {
        // Native controls do not scroll, so waiting for onScroll to clear
        // stick lets the next streaming resize move them under the press.
        // Focusing or pressing a player is explicit reading intent. Reuse
        // the restore anchor while layout settles; Jump resumes following.
        stick.current = false;
        holdPlace(placeFrom(el.scrollTop, anchorsIn(el)));
        setAway(el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM);
      }
    };
    const mediaIntent = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("video, audio")) mark(event);
    };
    const mediaHover = (event: PointerEvent) => {
      const player = event.target instanceof Element ? event.target.closest("video, audio") : null;
      if (!player || player.contains(event.relatedTarget as Node | null)) return;
      if (event.type === "pointerover") {
        if (!stick.current) return;
        stopGlide();
        releasePlace();
        hoveredMedia.current = { player, at: placeFrom(el.scrollTop, anchorsIn(el)) };
        el.style.overflowAnchor = "none";
      } else if (hoveredMedia.current?.player === player) {
        releasePlace();
        if (stick.current) {
          el.scrollTop = el.scrollHeight;
          setAway(false);
        }
      }
    };
    const onScroll = () => {
      const corrected = correctedTop.current;
      correctedTop.current = null;
      if (corrected !== null && Math.abs(el.scrollTop - corrected) <= 1) return;
      // The reader may keep moving (or use the map) while chat_page is in
      // flight. Preserve their latest view when the page finally arrives.
      if (gesture.current && prependAnchor.current && el.querySelector<HTMLElement>("[data-map-turn]")?.dataset.mapTurn === prependAnchor.current.first) {
        prependAnchor.current.at = prependPlaceFrom(el.scrollTop, anchorsIn(el));
      }
      if (!gesture.current) {
        // Not the reader's doing, so it says nothing about whether they have
        // scrolled away — but it can still be a move they asked for (a map
        // jump, the end of a glide), and where they land is worth keeping.
        savePlace();
        return;
      }
      // A flick on a phone keeps scrolling long after the finger is gone —
      // momentum runs for seconds, while the window above is 400ms. Letting it
      // expire mid-glide was the mobile bug: the rest of the glide arrived
      // unbelieved, `stick` never turned off, and the next height change yanked
      // the reader back to the bottom they had just scrolled away from. The
      // glide is still the reader's gesture, so it keeps the window open.
      mark();
      lastScroll.current = performance.now();
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
      stick.current = atBottom;
      setAway(!atBottom);
      // After `stick`, not before: coming back to the bottom is what says
      // there is no place left to keep.
      savePlace();
      if (el.scrollTop < 160) loadMoreRef.current();
    };
    // A reload is the other half of what a place is for, and a place noted
    // 200ms before one would otherwise be lost with the page.
    const leaving = () => flushPlace();
    const touchStart = (event: Event) => { touching.current = true; mark(event); };
    const touchEnd = () => { touching.current = false; lastScroll.current = performance.now(); };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", leaving);
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchend", touchEnd, { passive: true });
    el.addEventListener("touchcancel", touchEnd, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", mark, { passive: true });
    el.addEventListener("keydown", mark);
    el.addEventListener("pointerover", mediaHover, { passive: true });
    el.addEventListener("pointerout", mediaHover, { passive: true });
    el.addEventListener("focusin", mediaIntent);
    return () => {
      window.clearTimeout(until);
      touching.current = false;
      conv.current = undefined;
      stopGlide();
      // Whatever was noted and not yet written: the transcript is going away,
      // and the place was worked out while it was still on screen.
      flushPlace();
      window.removeEventListener("pagehide", leaving);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchend", touchEnd);
      el.removeEventListener("touchcancel", touchEnd);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("pointerdown", mark);
      el.removeEventListener("keydown", mark);
      el.removeEventListener("pointerover", mediaHover);
      el.removeEventListener("pointerout", mediaHover);
      el.removeEventListener("focusin", mediaIntent);
    };
  }, []);

  // Opening a chat starts where it was left — at the bottom for one that was
  // being read live, which is most of them and the only case there used to be.
  //
  // Nothing here happens on its own: the scroller keeps the pixel offset of
  // the chat you left, and `stick` keeps its answer to a question about THAT
  // chat — scroll up in one conversation and every one you opened afterwards
  // would stay pinned to the top. Before paint, so there is no flash of the
  // wrong end of the transcript.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    // The chat being LEFT, first, and from the note rather than the DOM: this
    // runs after React has already put the new conversation's turns in, so the
    // scroller no longer holds an offset that means anything about the old one.
    flushPlace();
    releasePlace();
    conv.current = conversationId;
    if (!el) return;
    // Whatever gesture opened this chat was aimed at the sidebar, not at the
    // transcript; letting it carry over would judge the new chat by it.
    gesture.current = false;
    touching.current = false;
    correctedTop.current = null;
    // A glide belongs to the conversation it was started in. Left running it
    // would ease the NEW transcript from the old one's offset — see it as the
    // wrong chat sliding into place.
    stopGlide();
    const saved = conversationId ? chatPlaceOf(conversationId) : undefined;
    if (!saved) {
      stick.current = true;
      setAway(false);
      el.scrollTop = el.scrollHeight;
      return releasePlace;
    }
    // Left part-way up: put them back there, and do NOT follow the stream.
    // Someone who parked half-way through a conversation to read it did not
    // ask to be taken to the end of it because a turn happened to arrive.
    stick.current = false;
    holdPlace(saved);
    restorePlace(saved);
    // Asked of where the place actually LANDED, not assumed from there being
    // one. A place is kept for a chat whose transcript was long; reopened
    // after a compaction, or on a phone whose pane is taller than the whole
    // conversation, it restores to a transcript with no bottom to come back
    // from — and the button drew itself over the last message offering to take
    // the reader somewhere they already were.
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM);
    // Layout cleanup runs before refs detach, including on unmount. A hold
    // and its timer must never belong to the next conversation or a dead pane.
    return releasePlace;
  }, [conversationId, readingState]);

  const workLayout = useRef<{ id?: string; folds: number; busy: boolean; anchor: HTMLElement | null; bottom: number } | null>(null);
  // A collapse can leave less than one pane of content. scrollTop alone then
  // cannot hold the final reply: retain just the removed space above it.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const before = workLayout.current;
    const folds = inner.querySelectorAll(".turn-work").length;
    if (before?.id !== conversationId || (busy && !before?.busy)) inner.style.removeProperty("--fold-space");
    const following = stick.current && !glide.current && !hoveredMedia.current && !resuming.current;
    if (following) el.scrollTop = el.scrollHeight;
    if (following && before && before.id === conversationId && folds > before.folds && before.anchor?.isConnected) {
      const delta = before.bottom - before.anchor.getBoundingClientRect().bottom;
      if (delta > 1) {
        const held = parseFloat(inner.style.getPropertyValue("--fold-space")) || 0;
        inner.style.setProperty("--fold-space", `${held + delta}px`);
        el.scrollTop = el.scrollHeight;
      }
    }
    const prose = inner.querySelectorAll<HTMLElement>(".msg-assistant .msg-body > .prose");
    const anchor = prose[prose.length - 1] ?? null;
    workLayout.current = { id: conversationId, folds, busy, anchor, bottom: anchor?.getBoundingClientRect().bottom ?? 0 };
  }, [messages, busy, conversationId]);

  // Scrolling to the bottom ONCE is not enough, because the bottom moves
  // afterwards. A turn's file list is fetched from the backend and appears a
  // moment later; a code block reflows; a font finishes loading. Each grows the
  // content below where we just scrolled to — and none of it re-renders this
  // component, so no effect here would fire again.
  //
  // So watch the content itself. Every time it changes height, if the reader is
  // meant to be at the bottom, put them there.
  useEffect(() => {
    const el = scrollerRef.current;
    const inner = innerRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // Not while a glide is running: it is already following the bottom, one
      // eased step per frame, and a pin written in the same frame would erase
      // the step and land the reader at the end before the travel had begun.
      const hover = hoveredMedia.current;
      if (hover) {
        restorePlace(hover.at);
        return;
      }
      if (stick.current && !glide.current) {
        el.scrollTop = el.scrollHeight;
        return;
      }
      // A restored place needs re-applying for the same reason the bottom
      // needs re-pinning: the height it was measured against is not the final
      // one. Everything the comment above describes — a file list arriving, a
      // code block reflowing, a font landing — happens ABOVE the reader too,
      // and one screenful of it is the difference between the paragraph they
      // left and one they have to hunt for. The anchor is re-read each time,
      // so this converges rather than repeating a stale number.
      const back = resuming.current;
      if (back) {
        // Rendering can cross the deadline before the timer gets its task.
        // This layout happened with browser anchoring off, so restore FIRST.
        restorePlace(back.at);
        if (performance.now() >= back.until) releasePlace();
      }
      // Whether there is a way back down is a question about the height, and
      // the height is what just changed. Without this a transcript that fitted
      // the pane when it was opened never grew a jump button as the turn under
      // it arrived — nothing else here asks again until the reader scrolls,
      // and the reader is exactly who cannot.
      //
      // Not during a glide: it starts far from the bottom and ends at it, and
      // the press that started it has already said where the reader is going.
      if (!glide.current) {
        setAway(el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM);
      }
    });
    observer.observe(inner);
    // And the pane itself. A card coming in above the composer takes its
    // height from this scroller, not from what is in it: the content is the
    // same size and the bottom of it is now under the card. With the card
    // opening over a few frames, each one is a step this follows.
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // There is deliberately no `scrollIntoView` pass here.
  //
  // One used to run after EVERY render, which during a stream means once per
  // chunk — and it raced the observer above, two different scroll APIs writing
  // the same position several times a frame. That is what made a reply look
  // jumpy rather than smooth.
  //
  // `scrollIntoView` is also the wrong tool on a phone: it scrolls every
  // scrollable ANCESTOR to bring the target into view, not just this list, so
  // it would drag the whole app shell and take the composer off screen with it.
  // Setting `scrollTop` moves this one element and nothing else, and the
  // observer already fires on every height change the stream produces.

  // The conversation, minus the subagents — and the subagents, filed under the
  // Task call each one belongs to. A subagent message never appears at this
  // level: it is drawn inside that card, by `BlockView`.
  const { turns, kids } = useMemo(() => {
    const kids: Kids = new Map();
    const top: Message[] = [];
    for (const m of messages) {
      if (!m.parent) {
        top.push(m);
        continue;
      }
      const own = kids.get(m.parent);
      if (own) own.push(m);
      else kids.set(m.parent, [m]);
    }
    return { turns: foldNoticeReplies(groupTurns(top)), kids };
  }, [messages]);

  const initialWindow = () => {
    const placed = conversationId ? chatPlaceOf(conversationId)?.turn : undefined;
    const base = readingState?.first !== undefined ? readingState.first : initialTurn(turns, placed);
    // A chat left mid-scroll comes back to that place and nothing else. One
    // that was at the end opens with the person's last real request in it, so
    // a window cut to the last two or three turns still says what was asked.
    return {
      id: conversationId,
      ready: turns.length > 0,
      readingState,
      first: placed ? base : orientedFirst(turns, base),
      placed: !!placed,
    };
  };
  let [visibleWindow, setWindow] = useState(initialWindow);
  if (visibleWindow.id !== conversationId || visibleWindow.readingState !== readingState || (!visibleWindow.ready && turns.length > 0)) {
    visibleWindow = initialWindow();
    setWindow(visibleWindow);
    prependAnchor.current = null;
  }
  // The incoming page and its visible window are ONE commit. Previously App
  // first installed the messages behind the old window, then the callback
  // revealed them on another commit. WebKit could scroll/overwrite the anchor
  // between those two layouts.
  const incoming = prependAnchor.current;
  if (incoming?.server && incoming.id === conversationId && turns[0]?.[0].id !== incoming.first && visibleWindow.first !== null) {
    visibleWindow = { id: conversationId, readingState, ready: true, first: null, placed: true };
    setWindow(visibleWindow);
  }
  // The turns that tell where the chat stands can arrive after the first
  // paint (a cached tail, then the page behind it). A window that opened on the
  // end and still follows it grows back to the last request instead of staying
  // cut to the turns it first saw.
  if (visibleWindow.ready && !visibleWindow.placed && stick.current && !prependAnchor.current) {
    const first = orientedFirst(turns, visibleWindow.first);
    if (first !== visibleWindow.first) {
      visibleWindow = { ...visibleWindow, first };
      setWindow(visibleWindow);
    }
  }
  // The page read to find the last request is here: widen the window to it
  // in the same commit (the anchor below holds the place), when it is near.
  if (incoming?.orient && incoming.id === conversationId && turns[0]?.[0].id !== incoming.first && visibleWindow.ready && visibleWindow.first !== null) {
    const first = orientedFirst(turns, visibleWindow.first);
    if (first !== visibleWindow.first) {
      visibleWindow = { ...visibleWindow, first };
      setWindow(visibleWindow);
    }
  }
  useLayoutEffect(() => {
    if (readingState && visibleWindow.ready) readingState.first = visibleWindow.first;
  }, [readingState, visibleWindow]);
  const start = turnWindowStart(turns, visibleWindow.first);
  const visibleTurns = useMemo(() => turns.slice(start), [turns, start]);
  const running = useMemo(() => runningTurns(turns, !!busy), [turns, busy]);
  // Marks whose turn is not shown yet: at the head until it is.
  const earlierMarks = useMemo(
    () => (marks?.size && start > 0
      ? turns.slice(0, start).flatMap((turn) => turn.map((m) => marks.get(m.id)).filter(Boolean))
      : []),
    [marks, turns, start],
  );
  const hasMore = start > 0 || hasEarlier;
  // Once shown, this slot stays the same height even at the beginning of the
  // record. A final page can contain only context, with no turns to provide
  // room to compensate for removing the control at scrollTop=0.
  const [historyRow, setHistoryRow] = useState({ id: conversationId, shown: hasMore });
  const showHistoryRow = hasMore || loadingEarlier || (historyRow.id === conversationId && historyRow.shown);
  if (historyRow.id !== conversationId || (showHistoryRow && !historyRow.shown)) {
    setHistoryRow({ id: conversationId, shown: showHistoryRow });
  }
  /** `orient`: the transcript has no real request in what it holds, so the
   *  page is read from the server even though the window could still widen
   *  over turns already loaded (they hold nothing to orient by). */
  const loadMore = async (pressed = false, orient = false) => {
    if (!hasMore || loadingEarlier || morePending.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const id = conversationId;
    const requestedAt = performance.now();
    const at = prependPlaceFrom(el.scrollTop, anchorsIn(el));
    prependAnchor.current = { id, first: visibleTurns[0]?.[0].id, at, server: !orient && start === 0, orient: orient ? { stuck: stick.current } : undefined };
    stopGlide();
    releasePlace();
    stick.current = false;
    morePending.current = true;
    // iOS ignores/fights scrollTop writes while a native flick is moving. The
    // download can run meanwhile, but neither path changes the DOM until the
    // finger is up and scroll events have been quiet for 120 ms.
    const ready = async () => {
      let quietFrames = 0;
      // A delivered button click has already ended the tap/drag that reached
      // it. Only scrolling AFTER that press needs another native quiet wait.
      while ((!pressed || lastScroll.current > requestedAt || touching.current) && conv.current === id && document.visibilityState !== "hidden") {
        // A timer can run ahead of a queued native animation frame after a
        // busy render. Require two quiet frames as well as the quiet interval.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (touching.current || performance.now() - lastScroll.current < 120) quietFrames = 0;
        else if (++quietFrames >= 2) break;
      }
      if (conv.current !== id || !prependAnchor.current) return;
      const latest = prependPlaceFrom(el.scrollTop, anchorsIn(el));
      prependAnchor.current.at = latest;
      gesture.current = false;
      holdPlace(latest);
    };
    try {
      if (start > 0 && !orient) {
        await ready();
        if (conv.current === id) setWindow({ id, readingState, ready: true, first: turns[Math.max(0, start - TURN_BATCH)][0].id, placed: true });
      } else await onLoadEarlier?.(ready);
    } catch (error) {
      if (conv.current === id) {
        if (prependAnchor.current?.orient) stick.current = prependAnchor.current.orient.stuck;
        prependAnchor.current = null;
        releasePlace();
      }
      throw error;
    } finally { morePending.current = false; }
  };
  loadMoreRef.current = () => { if (!earlierError) void loadMore(); };
  // The last request is not among the turns the chat holds (a long running turn
  // filled the page that was read): read one more page behind them, once, so the
  // transcript opens with something to reorient by.
  const reoriented = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!conversationId || reoriented.current === conversationId) return;
    // Only a read that can start spends the chance: one that finds a page
    // already coming, or no scroller yet, is asked again on the next render.
    if (!needsEarlierPage(turns, { hasEarlier, loading: loadingEarlier || morePending.current, failed: !!earlierError })) return;
    if (!scrollerRef.current) return;
    reoriented.current = conversationId;
    loadMore(false, true).catch(() => {});
  });
  useLayoutEffect(() => {
    const saved = prependAnchor.current;
    const el = scrollerRef.current;
    if (!saved || saved.id !== conversationId || !el || (saved.first === visibleTurns[0]?.[0].id && loadingEarlier)) return;
    prependAnchor.current = null;
    if (saved.orient) stick.current = saved.orient.stuck;
    holdPlace(saved.at);
    restorePlace(saved.at);
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM);
  }, [visibleTurns, conversationId, loadingEarlier]);
  useLayoutEffect(() => {
    // App reports a failed page on a prop instead of rejecting the callback.
    // It has no prepend to wait for, and the retry must remain usable.
    if (!earlierError || loadingEarlier || !prependAnchor.current) return;
    prependAnchor.current = null;
    releasePlace();
  }, [earlierError, loadingEarlier]);

  // Which colour each seat speaks in. Computed over the WHOLE conversation
  // rather than per turn, because the colours are handed out in order of first
  // appearance and a turn cannot see who came before it.
  const tints = useMemo(() => seatTints(messages), [messages]);

  const { fresh, nth } = useJustArrived(turns);
  // Whether the blocks this render mounts were just said. Asked of the turns
  // actually drawn, so an older page coming in above them is not an arrival,
  // and against what was last committed, so the render the window above
  // re-runs on a chat switch gets one answer and not two.
  const drawnIds = useMemo(() => visibleTurns.map((turn) => turn[0].id), [visibleTurns]);
  // Where the local day changes between two turns that have a time. "Today"
  // is read from a clock that moves when the local date does, so a chat left
  // open across midnight says what a reload would.
  const dividers = useMemo(() => dividerBefore(visibleTurns.map((turn) => turnTime(turn, turn[0].role))), [visibleTurns]);
  const dayNow = useLocalDay();
  const liveNow = useLiveAppend(conversationId ?? "", drawnIds);
  // A new box only when the answer changes: a delta re-renders no reader.
  const live = useMemo(() => ({ current: liveNow }), [liveNow]);
  const mapTurns = useMemo(() => conversationMapTurns(visibleTurns), [visibleTurns]);

  // Where each pending question is drawn: at the call that asked it, or at
  // the end when these turns do not hold that call. Asked of the turns
  // actually drawn, so a call behind "Load earlier messages" is not a place.
  const chatQuestions = useContext(ChatQuestionsContext);
  // Where each delivered question is drawn, from the host's own lines in
  // the record: at the call these turns hold for it, else where its line
  // stands. Worked out for every transcript, answerable or not.
  const answered = useMemo(() => placeAnswered(visibleTurns.flat()), [visibleTurns]);
  const places = useMemo<AskPlaces | null>(() => {
    if (!chatQuestions) return null;
    const drawn = visibleTurns.flat();
    // A question the record already holds the answer of is drawn from the
    // record: the host lists it a moment longer, and it is not drawn twice.
    const pending = answered.ids.size ? chatQuestions.questions.filter((q) => !answered.ids.has(q.id)) : chatQuestions.questions;
    return {
      placement: placeQuestions(drawn, pending),
      late: lateAnswers(drawn),
      onDone: chatQuestions.onDone,
    };
  }, [chatQuestions, visibleTurns, answered]);

  // A map point is another way of deliberately reading back. Its programmatic
  // scroll does not carry a wheel/touch gesture, so tell the transcript's own
  // follow logic about the intent before the first scroll event arrives.
  const mapJumped = () => {
    stopGlide();
    // A jump is a place of its own, and it wins over one being restored.
    releasePlace();
    stick.current = false;
    setAway(true);
  };

  // The row above the composer goes to a question out of view through here:
  // the same deliberate reading back as a map point, so the transcript stops
  // following the stream before it moves.
  const jumped = useRef(mapJumped);
  jumped.current = mapJumped;
  useEffect(() => {
    if (!chatQuestions) return;
    return setRevealer((el) => {
      jumped.current();
      el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    });
  }, [!!chatQuestions]);

  // A turn has arrived: take the conversation up to meet it.
  //
  // Before paint, and this is the whole reason it is a LAYOUT effect. The new
  // turn is in the DOM and measured by now, but the scroller still holds the
  // offset it had before — so `from` is genuinely where the reader was looking
  // and `to` is where the turn put the bottom. One frame later the observer
  // would already have pinned them together and there would be nothing to
  // travel.
  //
  // Only when they were at the bottom to begin with. Someone reading back
  // through a conversation did not ask to be taken anywhere, and an animated
  // yank is a worse one than an instant one — it is the same rudeness, drawn
  // out over a third of a second.
  useLayoutEffect(() => {
    if (nth && stick.current) glideToBottom();
  }, [nth]);

  // The short things the CLI has said lately, for the `/config` panel to find
  // its confirmations among — `Set Verbose output to true`.
  //
  // The LAST few messages only, and only the short ones. This is recomputed on
  // every streaming delta, so it must not be a walk of the whole transcript;
  // and a confirmation is one line, so an answer of any length is not one.
  const said = useMemo(() => {
    const out: string[] = [];
    for (const m of messages.slice(-CONFIRM_WINDOW)) {
      if (m.role !== "assistant") continue;
      for (const b of m.blocks) {
        if (b.kind !== "text") continue;
        const line = b.text.trim();
        if (line && line.length <= 120) out.push(line);
      }
    }
    return out;
  }, [messages]);

  const world = useMemo(
    () => ({ say: onSetting ?? (() => {}), said }),
    [onSetting, said],
  );

  return (
    <div className="msgs" ref={scrollerRef}>
      <ConversationMap turns={mapTurns} scrollerRef={scrollerRef} innerRef={innerRef} onJump={mapJumped} />
      <ConfigWorldProvider say={world.say} said={world.said} readOnly={!onSetting}>
      <LiveArrivals.Provider value={live}>
      {/* Which chat this transcript is: a reopened task's line offers its
          Stop only in the chat that coordinates its run. */}
      <ReopenedChatContext.Provider value={conversationId ? `chat:${conversationId}` : null}>
      {/* And whose players these are: one that is playing goes with the
          person when this chat leaves the screen (lib/nowPlaying). */}
      <MediaChatContext.Provider value={conversationId ?? null}>
      <AskPlacesContext.Provider value={places}>
      <AnsweredPlacesContext.Provider value={answered}>
      <div className="msgs-inner" ref={innerRef}>
        {showHistoryRow && (
          <div className="history-more">
            {hasMore || loadingEarlier || morePending.current ? (
            <button type="button" disabled={loadingEarlier || morePending.current} onClick={() => void loadMore(true)}>
              {loadingEarlier || morePending.current ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
            ) : <span className="history-start">Start of conversation</span>}
            {earlierError && <span role="alert">Could not load earlier messages. Try again.</span>}
          </div>
        )}
        {head}
        {earlierMarks}
        {visibleTurns.map((turn, turnIndex) => (
          <Fragment key={turn[0].id}>
          {dividers.has(turnIndex) && <DayDivider label={dayLabel(turnTime(turn, turn[0].role)!, dayNow)} full={fullLabel(turnTime(turn, turn[0].role)!)} />}
          <ReadingScope id={turn[0].id}>
            <TurnView
              messages={turn}
              stopped={!!stoppedAt && turn.some((m) => m.id === stoppedAt)}
              onWorkOpen={() => {
                stopGlide(); releasePlace(); stick.current = false;
                const el = scrollerRef.current;
                const inner = innerRef.current;
                const held = parseFloat(inner?.style.getPropertyValue("--fold-space") ?? "") || 0;
                inner?.style.removeProperty("--fold-space");
                if (el) el.scrollTop = Math.max(0, el.scrollTop - held);
                setAway(true);
              }}
              kids={kids}
              agentByTool={agentByTool}
              onOpenAgent={onOpenAgent}
              last={running.has(turn[0].id)}
              busy={busy}
              tints={tints}
              fresh={fresh.has(turn[0].id)}
              mapTurnId={turn[0].role === "user" && !isAnswerTurn(turn[0].turnId) && !isNoticeTurn(turn[0].turnId) ? turn[0].id : undefined}
              hostName={hostName}
              hostPersona={hostPersona}
              onCancelQueued={onCancelQueued}
              onStartQueued={onStartQueued}
              onRestoreUnsent={onRestoreUnsent}
              onDismissUnsent={onDismissUnsent}
            />
            {/* Under the turn, not inside it: what it marks is where the answer
                ENDS, and the reader's own next message reads differently once
                they can see the one above it never finished. */}
            {!!stoppedAt && turn.some((m) => m.id === stoppedAt) && <StopMark />}
            {!!marks?.size && turn.map((m) => marks.get(m.id)).filter(Boolean)}
          </ReadingScope>
          </Fragment>
        ))}
        {compactingSince !== undefined && <Compacting since={compactingSince} />}
        {/* A pending question whose call these turns do not hold. */}
        <LooseQuestions />
        {tail}
        {/* There were working dots here, in a slot held open so the transcript
            did not step up and down as they came and went several times a
            minute. They are gone, and the slot with them — not because the
            motion was wrong but because it was the SECOND thing saying it. The
            status line above the composer sits about forty pixels below this
            point and says the same "still going" with the time, the token
            count and the effort attached, and the two pulsed at each other for
            the length of every turn.

            The dots inside a streaming bubble stay (see `Blocks`): those fill a
            bubble that has arrived with nothing in it yet, and they never draw
            at the same moment as this did — this one required that NO message
            was streaming. */}
        <div ref={endRef} />
      </div>
      </AnsweredPlacesContext.Provider>
      </AskPlacesContext.Provider>
      </MediaChatContext.Provider>
      </ReopenedChatContext.Provider>
      </LiveArrivals.Provider>
      {/* Outside `.msgs-inner` and after it: it takes no height and must not
          take the column's 18px gap either, and it sticks to the bottom of the
          SCROLLER, which is this element rather than that one. */}
      <div className="jump-slot" aria-hidden={!jumpVisible}>
        <button
          key={onLoadLatest ? "latest" : "bottom"}
          type="button"
          className={`jump ${jumpVisible ? "is-on" : ""} ${onLoadLatest ? "jump-latest" : ""}`}
          disabled={!!onLoadLatest && loadingEarlier}
          onKeyDown={dropHeld}
          onClick={(event) => {
            if (repeatsAnother(event)) return;
            if (onLoadLatest) {
              if (latestRequested.current?.pending) return;
              const requested = { id: conversationId, pending: true };
              latestRequested.current = requested;
              // Release re-entry on settlement even if React batches away the
              // loading transition. Keep the intent for the commit/follow effect.
              void onLoadLatest().finally(() => { requested.pending = false; });
            } else jumpToBottom();
          }}
          // Not just hidden — a button under a reader's tab key that they
          // cannot see is worse than no button.
          tabIndex={jumpVisible ? 0 : -1}
          title={onLoadLatest ? undefined : "Jump to the end"}
          aria-label={onLoadLatest ? "Return to latest messages" : "Jump to the end"}
        >
          <ChevronDownIcon />
          {onLoadLatest && <span>Newer messages · Return to latest</span>}
        </button>
      </div>
      </ConfigWorldProvider>
    </div>
  );
};

export const MessageList = memo(function MessageList(props: React.ComponentProps<typeof MessageListBody>) {
  return <ChatReadingProvider id={props.conversationId} scope="transcript"><MessageListBody {...props} /></ChatReadingProvider>;
});

function ChevronDownIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** One subagent's whole transcript, on its own.
 *
 *  The agent rail's focus view: the same blocks the Task card nests, lifted out
 *  and shown alone so several long runs can be read one at a time. It reuses
 *  `SubAgent` rather than re-rendering blocks itself — a second block renderer
 *  is a second place for prose, thinking and tool cards to drift apart.
 *
 *  `parent` is the `tool_use` id of the Task call. Returns null when that call
 *  produced no transcript, which happens: a subagent's messages are not
 *  guaranteed to reach this stream at all. */
export function AgentTranscript({ messages, parent }: { messages: Message[]; parent: string }) {
  const kids: Kids = new Map();
  for (const m of messages) {
    if (!m.parent) continue;
    const own = kids.get(m.parent);
    if (own) own.push(m);
    else kids.set(m.parent, [m]);
  }
  const own = kids.get(parent);
  if (!own?.length) return null;
  return <SubAgent messages={own} kids={kids} />;
}
