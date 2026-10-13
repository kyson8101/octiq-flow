// The Plan panel: a chat's plan beside the chat, and the person's Start.
//
// The agent writes the list (`plan_update`), the person reads it here and
// starts it, and the host counts how each item's tasks stand
// (`docs/chat-plan.md`). So the panel is read-only but for one control: no
// edit, no reorder, no delete. The person changes the plan by saying so in
// the chat.
//
// Everything the agent wrote is drawn as text: a title, a decision, a
// question and a note are never markdown, never a link, never markup.
//
// What each part says is `lib/planView`'s; this file draws it. On a desktop
// the panel is a column beside the chat; on a phone it is drawn in the
// chat's place (`App`'s `chatShown`).
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import type { ChatPlan, ChatPlanStartAnswer } from "../lib/chatPlan";
import {
  hasPlan, moreDecisionsLabel, openQuestions, planHeader, planItems, planStart, startNote, stampTitle, tasksLabel,
  type PlanItemView, type PlanStart, type PlanTaskView,
} from "../lib/planView";
import { dropHeld, lastPointerPress, notePress, strayAnswer } from "../lib/pressGuard";
import type { Press } from "../lib/cardFold";
import "./PlanPanel.css";

/** The action bar's Plan button. It carries the number of questions still
 *  open, in the decision colour, and nothing when there are none. Its press
 *  is remembered by the cards' guard: it brings Start on screen. */
export function PlanButton({ questions, open, onToggle }: { questions: number; open: boolean; onToggle: () => void }) {
  const label = `${open ? "Hide" : "Show"} the plan${questions > 0 ? `, ${questions} ${questions === 1 ? "question" : "questions"} still open` : ""}`;
  return (
    <button className={`icon-btn cplan-toggle${open ? " is-on" : ""}`} type="button" aria-expanded={open} aria-label={label} title={label}
      onClick={(event) => { notePress(event); onToggle(); }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1 1 1.8-2M3.5 12l1 1 1.8-2" /><circle cx="4.6" cy="18" r="1.1" />
      </svg>
      <span className="topbar-action-label">Plan</span>
      {questions > 0 && <span className="cplan-toggle-open" aria-hidden="true">{questions}</span>}
    </button>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className="cplan-chevron" data-open={open || undefined} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
);

/** One linked task: how the ledger says it stands, and the way to its row
 *  in the run panel. */
function PlanTask({ task, onOpen }: { task: PlanTaskView; onOpen?: (task: PlanTaskView) => void }) {
  const body = <>
    <span className="cplan-task-word" data-state={task.state} data-live={task.live || undefined}>{task.word}</span>
    <span className="cplan-task-title">{task.title}</span>
  </>;
  if (!onOpen) return <span className="cplan-task">{body}</span>;
  return (
    <button type="button" className="cplan-task" aria-label={`Open in the run panel: ${task.title}, ${task.word.toLowerCase()}`}
      title="Open in the run panel" onClick={() => onOpen(task)}>
      {body}
      <svg className="cplan-task-go" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
    </button>
  );
}

function PlanItem({ item, onOpenTask }: { item: PlanItemView; onOpenTask?: (task: PlanTaskView) => void }) {
  const [more, setMore] = useState(false);
  const [tasks, setTasks] = useState(false);
  const [note, setNote] = useState(false);
  const moreId = useId();
  const tasksId = useId();
  const noteId = useId();
  const progress = item.progress;
  return (
    <li className="cplan-item" data-status={item.status} data-mark={item.mark}>
      <span className="cplan-mark" data-status={item.status} data-mark={item.mark} aria-hidden="true" />
      <div className="cplan-item-main">
        <div className="cplan-item-head">
          <span className="cplan-item-title">{item.title}</span>
          <span className="cplan-item-word" data-mark={item.mark}>{item.word}</span>
        </div>

        {item.decisions.length > 0 && (
          <ul className="cplan-decisions" aria-label="Decisions">
            {item.decisions.map((line, at) => <li key={at}>{line}</li>)}
          </ul>
        )}
        {item.moreDecisions.length > 0 && (
          <>
            <button type="button" className="cplan-more" aria-expanded={more} aria-controls={moreId}
              onClick={(event) => { notePress(event); setMore(!more); }}>
              <Chevron open={more} />{moreDecisionsLabel(item.moreDecisions.length)}
            </button>
            <ul className="cplan-decisions" id={moreId} hidden={!more} aria-label="More decisions">
              {item.moreDecisions.map((line, at) => <li key={at}>{line}</li>)}
            </ul>
          </>
        )}

        {item.questions.length > 0 && (
          <ul className="cplan-questions" aria-label="Questions still open">
            {item.questions.map((line, at) => (
              <li key={at}><span className="cplan-question-mark" aria-hidden="true">?</span><span>{line}</span></li>
            ))}
          </ul>
        )}

        {progress && (
          <>
            <button type="button" className="cplan-progress" aria-expanded={tasks} aria-controls={tasksId}
              aria-label={`${tasksLabel(item.tasks.length)}: ${progress.spoken}`} title={progress.spoken}
              onClick={(event) => { notePress(event); setTasks(!tasks); }}>
              <Chevron open={tasks} />
              {progress.label && <span className="cplan-progress-count">{progress.label}</span>}
              {progress.percent !== null && (
                <span className="cplan-bar" data-full={progress.percent === 100 || undefined} aria-hidden="true">
                  <span style={{ width: `${progress.percent}%` }} />
                </span>
              )}
              <span className="cplan-progress-parts">{[...progress.parts, ...progress.apart].join(" · ")}</span>
            </button>
            <ul className="cplan-tasks" id={tasksId} hidden={!tasks} aria-label="Tasks">
              {item.tasks.map((task) => <li key={task.id}><PlanTask task={task} onOpen={onOpenTask} /></li>)}
            </ul>
          </>
        )}

        {item.note && (
          <>
            <button type="button" className="cplan-more" aria-expanded={note} aria-controls={noteId}
              onClick={(event) => { notePress(event); setNote(!note); }}>
              <Chevron open={note} />Note
            </button>
            <p className="cplan-note" id={noteId} hidden={!note}>{item.note}</p>
          </>
        )}
      </div>
    </li>
  );
}

/** The control at the foot of the panel. It starts work, so it is never
 *  fired by the press or the key that brought it on screen: a held key
 *  presses it once at most, and a pointer press that repeats the one the
 *  panel was opened with is dropped (`lib/pressGuard`). There is no confirm
 *  in front of it; the page's other Starts have none. */
function StartControl({ start, opener, onStart }: {
  start: PlanStart;
  opener: Press | null;
  onStart: (revision: number) => Promise<ChatPlanStartAnswer>;
}) {
  const [busy, setBusy] = useState(false);
  /** The host's words, and the revision they were said of: a plan the agent
   *  has changed since is another plan. */
  const [said, setSaid] = useState<{ revision: number; text: string } | null>(null);
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const alive = useRef(true);
  // Set on every mount, not only cleared on unmount: an effect that is run
  // twice (strict mode) would otherwise leave it cleared on a live control,
  // and a Start's answer would never switch the button back on.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const hintId = useId();

  if (start.kind === "none") return null;
  if (start.kind === "started" || start.kind === "nothing") {
    return <footer className="cplan-foot" data-kind={start.kind}><p className="cplan-started" role="status">{start.state}</p></footer>;
  }
  const off = busy ? "Sending…" : start.off;
  const reason = said && said.revision === start.revision ? said.text : null;
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    if (off) return;
    if (strayAnswer(opener, { x: event.clientX, y: event.clientY, at: performance.now(), detail: event.detail })) return;
    setBusy(true);
    setSaid(null);
    onStart(start.revision).then(
      (answer) => {
        if (!alive.current) return;
        const note = startNote(answer);
        setSaid(note ? { revision: answer.plan.revision, text: note } : null);
      },
      (error) => { if (alive.current) setSaid({ revision: start.revision, text: String((error as Error)?.message ?? error) }); },
    ).finally(() => { if (alive.current) setBusy(false); });
  };
  return (
    <footer className="cplan-foot" data-kind={start.kind}>
      {/* Both halves, apart: the Start is recorded, and the agent was not told. */}
      {start.kind === "tell" && <p className="cplan-started" role="status">{start.state}<span className="cplan-started-note"> · {start.note}</span></p>}
      <div className="cplan-foot-row">
        <button type="button" className="cplan-start" aria-disabled={off ? true : undefined} aria-describedby={hintId}
          onKeyDown={dropHeld} onClick={press}>{start.label}</button>
        <span className="cplan-foot-side" id={hintId}>
          {off ?? (start.kind === "start" ? start.questions : null)}
        </span>
      </div>
      {/* A Start that was refused recorded nothing: the host's words, under
          the button. Why a recorded Start's turn was not handed over is the
          host's sentence too, behind a disclosure: a button, never a tooltip. */}
      {reason && start.kind === "start" && <p className="cplan-refusal" role="alert">{reason}</p>}
      {reason && start.kind === "tell" && <>
        <button type="button" className="cplan-more cplan-why" aria-expanded={why} aria-controls={whyId}
          onClick={(event) => { notePress(event); setWhy(!why); }}><Chevron open={why} />Why</button>
        <p className="cplan-refusal" id={whyId} hidden={!why}>{reason}</p>
      </>}
    </footer>
  );
}

export function PlanPanel({ plan, error, unread = false, flying, connected, page = false, onClose, onStart, onOpenTask }: {
  /** The chat's plan as the host last answered, or `null` before it has. */
  plan: ChatPlan | null;
  /** Why the last read failed, in the host's words. */
  error?: string | null;
  /** Nothing has been heard yet for this chat. */
  unread?: boolean;
  /** The linked tasks whose worker has a turn in flight (`planView.tasksInFlight`). */
  flying?: ReadonlySet<string>;
  connected: boolean;
  /** Drawn in the chat's place (a phone), not beside it. */
  page?: boolean;
  onClose: () => void;
  onStart: (revision: number) => Promise<ChatPlanStartAnswer>;
  onOpenTask?: (task: PlanTaskView) => void;
}) {
  // The press that opened the panel, as the page last saw one: Start drops
  // a repeat of it. Read once, as the panel mounts.
  const opener = useRef<Press | null>(lastPointerPress());
  const now = Date.now();
  const has = hasPlan(plan);
  const header = has ? planHeader(plan, now) : null;
  const items = has ? planItems(plan, flying) : [];
  const open = openQuestions(plan);
  const start = planStart(has ? plan : null, now, { connected });
  return (
    <aside className={`cplan-panel${page ? " is-page" : ""}`} aria-label="Plan">
      <header className="cplan-head">
        <strong>Plan</strong>
        {header && <span className="cplan-head-state" data-started={header.started || undefined}
          title={header.startedAt ? stampTitle(header.startedAt) : undefined}>{header.state}</span>}
        <button type="button" className="cplan-close" onClick={onClose} aria-label={page ? "Back to the chat" : "Close the plan"}
          title={page ? "Back to the chat" : "Close the plan"}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      {error && <p className="cplan-error" role="status">The plan could not be read: {error}</p>}
      {header ? (
        <>
          <p className="cplan-meta">
            <span>{header.items}</span>
            {open > 0 && <span className="cplan-meta-open">{open} open {open === 1 ? "question" : "questions"}</span>}
            {header.updated && <span title={header.updatedAt ? stampTitle(header.updatedAt) : undefined}>{header.updated}</span>}
          </p>
          <ol className="cplan-items" aria-label="Plan items">
            {items.map((item) => <PlanItem key={item.id} item={item} onOpenTask={onOpenTask} />)}
          </ol>
        </>
      ) : unread && !error ? (
        <p className="cplan-none" role="status">Reading the plan…</p>
      ) : !error && (
        <div className="cplan-none">
          <p>No plan yet</p>
          <p className="cplan-none-hint">The agent keeps one when you ask it to plan. You read it here and press Start when it is right.</p>
        </div>
      )}
      <StartControl key={plan?.chatId ?? "none"} start={start} opener={opener.current} onStart={onStart} />
    </aside>
  );
}
