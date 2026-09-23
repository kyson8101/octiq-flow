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
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import {
  DELIVERY_LABELS,
  NOT_REPORTED,
  agoLabel,
  commitLine,
  gitStateOf,
  locationOf,
  mergeLine,
  phaseOf,
  releaseBasis,
  releaseLine,
  stepProgress,
  type ReleaseCheck,
  type TaskStatus,
} from "../lib/chatTask";
import "./ChatTaskBar.css";

type Live = { busy?: boolean; waiting?: boolean };

export function ChatTaskBar({
  chatId,
  connected,
  busy,
  waiting,
}: { chatId: string; connected: boolean } & Live) {
  const [status, setStatus] = useState<TaskStatus>();
  const [open, setOpen] = useState(false);
  /** True once the backend has said it does not know this command. The two
   *  halves of this app deploy separately, and a client built ahead of the
   *  server would otherwise leave a permanent "Unverified" chip in the bar
   *  with nothing behind it. Better absent than dead. */
  const [unsupported, setUnsupported] = useState(false);
  const shown = status?.chatId === chatId ? status : undefined;

  const load = useCallback(
    (refresh: boolean) => {
      if (!chatId || !connected || document.hidden) return;
      bridge
        .invoke<TaskStatus>("chat_task", { chatId, refresh })
        .then(setStatus)
        // A chat that has never been verified has nothing to show, and an
        // older backend has no such command. Neither is worth a message over
        // the conversation; the second one takes the bar away with it.
        .catch((error: unknown) => {
          if (String(error).includes("not available on this backend")) setUnsupported(true);
        });
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
    const offGit = bridge.on("git-status-changed", () => load(true));
    const onVisible = () => { if (!document.hidden) load(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offStatus();
      offGit();
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
    />
  );
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
}: {
  status?: TaskStatus;
  open: boolean;
  now: number;
  onToggle: () => void;
  onTarget?: (branch: string) => void;
  onReleaseCheck?: (check: ReleaseCheck) => void;
} & Live) {
  const phase = phaseOf(status, { busy, waiting });
  const progress = stepProgress(status?.report);
  const branch = status?.workspace?.branch ?? "";
  return (
    <div className="chat-task">
      <button
        type="button"
        className="chat-task-trigger"
        aria-expanded={open}
        aria-label={`Task and workspace — ${phase.label}${branch ? ` on ${branch}` : ""}`}
        title={`${phase.label}${branch ? ` · ${branch}` : ""} — ${locationOf(status?.workspace)}`}
        onClick={onToggle}
      >
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
      </button>
      {open && (
        <ChatTaskPanel
          status={status}
          now={now}
          onClose={onToggle}
          onTarget={onTarget}
          onReleaseCheck={onReleaseCheck}
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
}: {
  status?: TaskStatus;
  now: number;
  onClose: () => void;
  onTarget?: (branch: string) => void;
  onReleaseCheck?: (check: ReleaseCheck) => void;
}) {
  const report = status?.report;
  const delivery = status?.delivery;
  const workspace = status?.workspace;
  const stage = phaseOf(status).stage;
  return (
    <div className="chat-task-panel" role="dialog" aria-label="Task and workspace">
      <div className="chat-task-head">
        <strong>Task &amp; workspace</strong>
        <button type="button" className="chat-task-close" aria-label="Close" onClick={onClose}>×</button>
      </div>

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

      <h2>Workspace</h2>
      <dl className="chat-task-fields">
        <dt>Branch</dt>
        <dd>{workspace?.branch || "Unknown"}</dd>
        <dt>Location</dt>
        <dd>{locationOf(workspace)}</dd>
        <dt>Git state</dt>
        <dd>{gitStateOf(workspace)}</dd>
        <dt>Chat path</dt>
        <dd className="chat-task-path">{workspace?.cwd || "Not recorded"}</dd>
        {workspace?.primaryRoot && workspace.primaryRoot !== workspace.repoRoot && (
          <>
            <dt>Repository</dt>
            <dd className="chat-task-path">{workspace.primaryRoot}</dd>
          </>
        )}
      </dl>
    </div>
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
