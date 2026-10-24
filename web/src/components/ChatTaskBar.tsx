// The one line above the chat that says where you are.
//
// It answers, in this order: is anything happening, what is this chat FOR, and
// which branch is it doing it on. Everything else — the plan, the commits, the
// merge, the release, the paths — is a click away in the panel, because a bar
// that explains is a bar nobody can read at a glance.
//
// The data half subscribes; it never polls. The backend verifies on request
// and caches for a few seconds, so several open tabs asking at once cost one
// `git status`. Refreshes are tied to things that actually change the answer:
// the chat opening, a turn ending, git moving under it, and the panel opening.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { singleFlight, withTrailingRun } from "../lib/singleFlight";
import {
  DELIVERY_LABELS,
  NOT_REPORTED,
  agoLabel,
  commitLine,
  gitStateOf,
  locationOf,
  mergeLine,
  phaseOf,
  prCompletionLine,
  recallTaskStatus,
  rememberTaskStatus,
  releaseBasis,
  releaseLine,
  stepProgress,
  type ReleaseCheck,
  type TaskStatus,
} from "../lib/chatTask";
import { EVIDENCE_LABEL, taskEnvironment, type EnvironmentInput } from "../lib/taskEnvironment";
import type { Persona } from "../lib/agentPersona";
import type { ChatHold } from "../lib/chatWait";
import { copyText } from "../lib/clipboard";
import { entryClass, useEntry } from "../lib/useArrival";
import { AgentAvatar } from "./AgentAvatar";
import "./ChatTaskBar.css";
import { AutoPlanSwitch } from "./AutoPlanSwitch";
import { setAutoPlan, useAutoPlan } from "../lib/autoPlan";
import { notePress } from "../lib/pressGuard";

/** `waiting` is the page's one reading of the chat (`lib/chatWait`): what it
 *  waits on the person for, `unknown` while the page cannot say, or nothing. */
type Live = { busy?: boolean; waiting?: ChatHold | boolean | null };

/** How long after the last `git-status-changed` the bar asks once more. It
 *  must outlast the backend's verification cache (`FRESH_FOR`, 4 s, in
 *  chat_task.rs), so that last ask is answered by a git read made after the
 *  change rather than one made before it. */
export const SETTLED_AFTER_MS = 5_000;

/** What the panel knows beyond `chat_task`: the plan the chat was started
 *  with, the orchestration task a worker runs, and who it is. */
export type PanelContext = Omit<EnvironmentInput, "status"> & {
  persona?: Persona | null;
  /** The agent's provider and model, for the details only. */
  runsOn?: string;
  canLead?: boolean;
};

export function ChatTaskBar({
  chatId,
  connected,
  busy,
  waiting,
  context,
  action = false,
}: { chatId: string; connected: boolean; context?: PanelContext; action?: boolean } & Live) {
  const autoPlan = useAutoPlan(context?.canLead ? `chat:${chatId}` : null, connected);
  const [status, setStatus] = useState<TaskStatus>();
  const [open, setOpen] = useState(false);
  /** True once the backend has said it does not know this command. The two
   *  halves of this app deploy separately, and a client built ahead of the
   *  server would otherwise leave a permanent "Unverified" chip in the bar
   *  with nothing behind it. Better absent than dead. */
  const [unsupported, setUnsupported] = useState(false);
  /** The chat whose first ask has come back, with an answer or without one.
   *  Until then the line holds its place unseen rather than saying
   *  "Unverified" and then something else; a failed ask lets it through, so
   *  the panel behind it is never out of reach. */
  const [asked, setAsked] = useState("");
  // What this chat said last time stands in until it answers again, so coming
  // back to a chat draws its line whole instead of in two steps.
  const shown = status?.chatId === chatId ? status : recallTaskStatus(chatId);
  useEffect(() => {
    if (status) rememberTaskStatus(status);
  }, [status]);

  const load = useCallback(
    (refresh: boolean): Promise<void> => {
      if (!chatId || !connected || document.hidden) return Promise.resolve();
      return bridge
        .invoke<TaskStatus>("chat_task", { chatId, refresh })
        .then(setStatus)
        // A chat that has never been verified has nothing to show, and an
        // older backend has no such command. Neither is worth a message over
        // the conversation; the second one takes the bar away with it.
        .catch((error: unknown) => {
          if (String(error).includes("not available on this backend")) setUnsupported(true);
        })
        .finally(() => setAsked(chatId));
    },
    [chatId, connected],
  );

  useEffect(() => {
    setOpen(false);
    load(false);
  }, [chatId, load]);

  // A turn that has just ended is the moment the answer most often changed —
  // the agent committed something, or moved its plan on.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) load(true);
    wasBusy.current = busy;
  }, [busy, load]);

  useEffect(() => {
    if (!chatId || !connected) return;
    const offStatus = bridge.on("chat-task", (payload) => {
      const next = payload as TaskStatus | undefined;
      if (next?.chatId === chatId) setStatus(next);
    });
    // A change ANYWHERE watched says nothing certain about this chat, and it
    // can arrive every second — so no forced refresh, which would run git
    // every time, and never more than one ask out at once. The backend's
    // own few-second cache decides whether git runs at all.
    //
    // That cache is also why one ask is not enough: a change inside its
    // lifetime (`git add`, then `git commit` two seconds later) is answered
    // with the verification from before it, and nothing would ask again. So a
    // burst of changes ends with ONE more ask, after the cache has lapsed.
    const git = withTrailingRun(singleFlight(() => load(false)), SETTLED_AFTER_MS);
    const offGit = bridge.on("git-status-changed", git.trigger);
    const onVisible = () => { if (!document.hidden) load(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offStatus();
      offGit();
      git.cancel();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [chatId, connected, load]);

  const setTarget = useCallback(
    (branch: string) => {
      bridge
        .invoke<TaskStatus>("chat_task_set_target", { chatId, branch, setBy: "user" })
        .then(setStatus)
        .catch(() => {});
    },
    [chatId],
  );

  const setReleaseCheck = useCallback(
    (check: ReleaseCheck) => {
      const projectId = shown?.projectId;
      if (!projectId) return;
      bridge
        .invoke("chat_task_set_release_check", {
          projectId,
          reference: check.reference ?? null,
          command: check.command ?? null,
        })
        .then(() => load(true))
        .catch(() => {});
    },
    [shown?.projectId, load],
  );

  if (!chatId || unsupported) return null;
  return (
    <ChatTaskBarView
      status={shown}
      scope={chatId}
      ready={!!shown || asked === chatId || !connected}
      busy={busy}
      waiting={waiting}
      open={open}
      now={Date.now()}
      onToggle={() => {
        const next = !open;
        setOpen(next);
        if (next) load(true);
      }}
      onTarget={setTarget}
      onReleaseCheck={setReleaseCheck}
      context={context}
      action={action}
      autoPlan={context?.canLead ? <AutoPlanSwitch enabled={autoPlan.setting?.enabled ?? false} busy={autoPlan.busy}
        ready={connected && !!autoPlan.setting} error={autoPlan.error}
        onChange={() => { void setAutoPlan(`chat:${chatId}`, !autoPlan.setting?.enabled).catch(() => {}); }} /> : undefined}
    />
  );
}

const PANEL_WIDTH = 380;
const PANEL_EDGE = 12;

/** Where the action's panel goes: under its button, and wholly inside a
 *  window `viewport` wide. Its width is the sheet's `min(380px, 100vw - 24px)`. */
export function panelPlace(button: { left: number; bottom: number }, viewport: number): { top: number; left: number } {
  const width = Math.min(PANEL_WIDTH, viewport - 2 * PANEL_EDGE);
  return {
    top: Math.round(button.bottom + 6),
    left: Math.round(Math.max(PANEL_EDGE, Math.min(button.left, viewport - width - PANEL_EDGE))),
  };
}

/** Pure view, so every state it can be in is a render and a string — there is
 *  no live chat, repository or release to arrange in a test. */
export function ChatTaskBarView({
  status,
  busy,
  waiting,
  open,
  now,
  onToggle,
  onTarget,
  onReleaseCheck,
  context,
  action = false,
  scope = "",
  ready = true,
  autoPlan,
}: {
  status?: TaskStatus;
  /** The chat this line is for, and whether its status has been answered.
   *  A line drawn before the answer holds its place and comes in once, whole
   *  (`lib/arrival`); one that already knew is drawn in place. */
  scope?: string;
  ready?: boolean;
  autoPlan?: React.ReactNode;
  context?: PanelContext;
  open: boolean;
  now: number;
  onToggle: () => void;
  onTarget?: (branch: string) => void;
  onReleaseCheck?: (check: ReleaseCheck) => void;
  /** Draw a stable overflow action instead of the old navbar status chip. */
  action?: boolean;
} & Live) {
  const phase = phaseOf(status, { busy, waiting });
  const progress = stepProgress(status?.report);
  const branch = status?.workspace?.branch ?? "";
  // The action button says nothing that is waited for: only the line does.
  const gate = entryClass(useEntry(action || ready, scope));
  // The action's panel is fixed to the window, because its button can sit
  // inside something that clips (More's list, a phone's scrolling row): it
  // opens just under the button and is kept inside the window's width.
  const root = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const at = panelPlace(element.getBoundingClientRect(), window.innerWidth);
    element.style.setProperty("--chat-task-top", `${at.top}px`);
    element.style.setProperty("--chat-task-left", `${at.left}px`);
  }, []);
  useLayoutEffect(() => {
    if (!open || !action) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, action, place]);
  return (
    <div ref={root} className={`chat-task${action ? " is-action" : ""}`}>
      <button
        type="button"
        className={`chat-task-trigger enter-gated${action ? " chat-task-action" : ""}${gate ? ` ${gate}` : ""}`}
        aria-expanded={open}
        aria-label={action ? "Task details" : `Task and workspace — ${phase.label}${branch ? ` on ${branch}` : ""}`}
        title={action ? "Task details" : `${phase.label}${branch ? ` · ${branch}` : ""} — ${locationOf(status?.workspace)}`}
        onClick={(event) => {
          notePress(event);
          // Placed at the press, before the panel exists: placed after it
          // is drawn, it would be seen for a frame where it is not.
          if (action && !open) place();
          onToggle();
        }}
      >
        {action ? (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
              <path d="M8 9h8M8 13h8M8 17h5" />
            </svg>
            <span className="topbar-action-label">Details</span>
          </>
        ) : (
          <>
            <span className="chat-task-dot" data-tone={phase.tone} aria-hidden="true" />
            <span className="chat-task-phase">{phase.label}</span>
            {progress && <span className="chat-task-count">{progress}</span>}
            {branch && (
              <>
                <span className="chat-task-sep" aria-hidden="true" />
                <span className="chat-task-branch">{branch}</span>
              </>
            )}
            <svg className="chat-task-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </>
        )}
      </button>
      {open && (
        <ChatTaskPanel
          status={status}
          now={now}
          onClose={onToggle}
          onTarget={onTarget}
          onReleaseCheck={onReleaseCheck}
          context={context}
          phase={phase.label}
          autoPlan={autoPlan}
        />
      )}
    </div>
  );
}

function ChatTaskPanel({
  status,
  now,
  onClose,
  onTarget,
  onReleaseCheck,
  context,
  phase,
  autoPlan,
}: {
  status?: TaskStatus;
  context?: PanelContext;
  phase?: string;
  autoPlan?: React.ReactNode;
  now: number;
  onClose: () => void;
  onTarget?: (branch: string) => void;
  onReleaseCheck?: (check: ReleaseCheck) => void;
}) {
  const report = status?.report;
  const delivery = status?.delivery;
  const stage = phaseOf(status).stage;
  const environment = taskEnvironment({ ...context, status });
  const persona = context?.persona;
  return (
    <div className="chat-task-panel" role="dialog" aria-label="Task and workspace">
      <div className="chat-task-head">
        <strong>Task &amp; workspace</strong>
        <button type="button" className="chat-task-close" aria-label="Close" onClick={onClose}>×</button>
      </div>

      {persona && (
        <div className="chat-task-agent" title={[persona.role, context?.runsOn].filter(Boolean).join("\n") || undefined}>
          <AgentAvatar island name={persona.name} avatar={persona.avatar} id={persona.id} size={48} removed={persona.removed} decorative />
          <span className="chat-task-agent-copy">
            <strong>{persona.name}</strong>
            <span>{[persona.removed ? "No longer registered" : "", phase, context?.runsOn].filter(Boolean).join(" · ")}</span>
          </span>
        </div>
      )}

      {autoPlan}

      <p className={`chat-task-objective ${report ? "" : "is-missing"}`}>
        {report?.objective || NOT_REPORTED}
      </p>
      {report?.nextStep && <p className="chat-task-next">{report.nextStep}</p>}
      <p className="chat-task-source">
        {report
          ? `Reported by ${report.reportedBy || "the agent"} ${agoLabel(report.reportedAt, now)}.`
          : "The agent has not reported a task here. Progress is not inferred from the conversation."}
      </p>

      {report && report.steps.length > 0 && (
        <>
          <h2>Plan · {stepProgress(report)} done</h2>
          <ul className="chat-task-steps">
            {report.steps.map((step, index) => (
              <li key={`${index}-${step.title}`} data-state={step.state}>
                <span className="chat-task-step-mark" aria-hidden="true" />
                <span>{step.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {status?.prCompletion && (
        <section className="chat-task-pr-completion" aria-label="Pull request completion">
          <span className="chat-task-pr-mark" aria-hidden="true" />
          <div>
            <strong>{prCompletionLine(status.prCompletion)}</strong>
            <span>
              Head {status.prCompletion.headSha.slice(0, 8)} · confirmed {agoLabel(status.prCompletion.completedAt, now)}
            </span>
          </div>
          <a href={status.prCompletion.url} target="_blank" rel="noreferrer noopener">Open</a>
        </section>
      )}

      <div className="chat-task-section-head">
        <h2>Delivery</h2>
        <span className="chat-task-stage">{DELIVERY_LABELS[stage]}</span>
      </div>
      <dl className="chat-task-fields">
        <dt>Commit</dt>
        <dd>{commitLine(delivery)}</dd>
        <dt>Target</dt>
        <dd>
          {delivery?.target ? (
            <TargetField target={delivery.target} onTarget={onTarget} />
          ) : (
            "Unknown"
          )}
        </dd>
        <dt>Merge</dt>
        <dd>{mergeLine(delivery)}</dd>
        <dt>Release</dt>
        <dd>
          {releaseLine(delivery)}
          {delivery?.releaseNote && <span className="chat-task-note">{delivery.releaseNote}</span>}
          {status?.releaseCheck ? (
            <span className="chat-task-note">{releaseBasis(status.releaseCheck)}</span>
          ) : (
            onReleaseCheck && status?.projectId && <ReleaseCheckField onSave={onReleaseCheck} />
          )}
        </dd>
      </dl>
      {delivery && (
        <p className="chat-task-source">
          Checked {agoLabel(delivery.checkedAt, now)} with Git.
          {delivery.stale && " The chat's own directory is gone; this was read from the primary checkout."}
        </p>
      )}

      <div className="chat-task-section-head">
        <h2>Environment</h2>
        <span className="chat-task-stage">
          {environment.stale ? "Stale" : environment.checkedAt ? `Checked ${agoLabel(environment.checkedAt, now)}` : "Not verified yet"}
        </span>
      </div>
      <dl className="chat-task-fields chat-task-env">
        {environment.rows.map((row) => (
          <EnvField key={row.key} row={row} />
        ))}
        <dt>Git state</dt>
        <dd>{gitStateOf(status?.workspace)}</dd>
      </dl>
      {context?.launch && (
        <p className="chat-task-source">
          {context.launch.chosenBy === "auto" ? "Chosen automatically" : context.launch.chosenBy === "advanced" ? "Chosen under Advanced" : "Chosen when the chat started"}
          {context.launch.reason ? `: ${context.launch.reason}` : "."}
        </p>
      )}
    </div>
  );
}

function EnvField({ row }: { row: ReturnType<typeof taskEnvironment>["rows"][number] }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  return (
    <>
      <dt>{row.label}</dt>
      <dd className={row.path && row.value === row.path ? "chat-task-path" : undefined}>
        <span className="chat-task-env-value">
          <span>{row.value}</span>
          <span className="chat-task-evidence" data-evidence={row.evidence}>{EVIDENCE_LABEL[row.evidence]}</span>
          {row.path && (
            <button
              type="button"
              className="chat-task-copy"
              aria-label={`Copy ${row.label.toLowerCase()} path`}
              title={copied === "failed" ? "Could not copy" : copied === "done" ? "Copied" : `Copy ${row.path}`}
              onClick={async () => {
                setCopied((await copyText(row.path ?? "")) ? "done" : "failed");
                setTimeout(() => setCopied("idle"), 1600);
              }}
            >
              {copied === "done" ? "Copied" : "Copy"}
            </button>
          )}
        </span>
        {row.planned && <span className="chat-task-note">Planned: {row.planned}</span>}
      </dd>
    </>
  );
}

/** Teaching a project what "released" means.
 *
 *  Without this the release row is unverified for ever, which is honest and
 *  useless. It is asked here, in the row that is unverified, rather than in a
 *  settings screen nobody visits with the question in mind. */
function ReleaseCheckField({ onSave }: { onSave: (check: ReleaseCheck) => void }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<"reference" | "command">("reference");
  const [value, setValue] = useState("");
  if (!editing) {
    return (
      <button type="button" className="chat-task-setup" onClick={() => setEditing(true)}>
        Set up a release check
      </button>
    );
  }
  return (
    <form
      className="chat-task-release-form"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        setEditing(false);
        if (text) onSave(kind === "reference" ? { reference: text } : { command: text });
      }}
    >
      <select aria-label="How a release is recognised" value={kind} onChange={(event) => setKind(event.target.value as "reference" | "command")}>
        <option value="reference">Git ref</option>
        <option value="command">Command</option>
      </select>
      <input
        aria-label={kind === "reference" ? "Release ref" : "Release check command"}
        placeholder={kind === "reference" ? "origin/release" : "./scripts/octiq-check.sh"}
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
      />
      <button type="submit">Save</button>
      <span className="chat-task-note">
        {kind === "reference"
          ? "Released means the commit is an ancestor of this ref."
          : "The first commit hash this prints is taken as what is running."}
      </span>
    </form>
  );
}

/** The target is the one field a person may have to correct: everything the
 *  merge row says is asked against it, and the repository's default branch is
 *  only a guess at where THIS task is going. */
function TargetField({ target, onTarget }: { target: string; onTarget?: (branch: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(target);
  if (!onTarget) return <>{target}</>;
  if (!editing) {
    return (
      <button
        type="button"
        className="chat-task-target"
        onClick={() => {
          setDraft(target);
          setEditing(true);
        }}
      >
        {target}
        <span className="chat-task-note">change</span>
      </button>
    );
  }
  return (
    <form
      className="chat-task-target-form"
      onSubmit={(event) => {
        event.preventDefault();
        const branch = draft.trim();
        setEditing(false);
        if (branch && branch !== target) onTarget(branch);
      }}
    >
      <input
        aria-label="Target branch"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
      />
      <button type="submit">Set</button>
    </form>
  );
}
