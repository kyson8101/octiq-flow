// A mission's page, above its tasks: the goal and what done means, the crew
// and their roles, and where the work lives. Each is a quiet disclosure; the
// crew is open, because who is on it is the question asked most, and the goal
// and the branches are one click away. The board (MissionTrack) and the tasks
// stay where they were, and so do Close and Abandon, in the mission options.
// See lib/missionPage for where each line comes from.
import { useContext, useEffect, useId, useState } from "react";
import { bridge } from "../lib/bridge";
import { AgentRosterContext, ChatPersonaContext } from "../lib/agentRoster";
import { shortWorkspacePath } from "../lib/agentTaskBoard";
import { orchestrationFeed } from "../lib/orchestrationFeed";
import {
  CREW_ROLE_LABEL, missionAcceptance, missionCrew, missionWhere, placeStanding, reassignBlocker, reassignChoices,
  reassignRequest, type CrewMember, type Destinations, type ReassignChoice,
} from "../lib/missionPage";
import type { OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationTask } from "../lib/orchestration";
import type { PersonState } from "../lib/runPanel";
import { AgentAvatar } from "./AgentAvatar";
import "./MissionPage.css";

const STATE_LABEL: Record<PersonState, string> = {
  working: "working", blocked: "blocked", assigned: "assigned", done: "done", stopped: "stopped",
};

/** The crew, as the page and its task rows both need it. */
export function useMissionCrew(
  run: OrchestrationRun,
  tasks: readonly OrchestrationTask[],
  attempts: readonly OrchestrationAttempt[],
  gates: readonly OrchestrationGate[],
): CrewMember[] {
  const roster = useContext(AgentRosterContext);
  const personaOf = useContext(ChatPersonaContext);
  return missionCrew(run, tasks, attempts, gates, roster, personaOf(run.coordinatorChatKey));
}

export function MissionSections({ run, tasks, crew }: {
  run: OrchestrationRun;
  tasks: readonly OrchestrationTask[];
  crew: readonly CrewMember[];
}) {
  const criteria = missionAcceptance(tasks);
  const places = missionWhere(run, tasks);
  const total = criteria.reduce((sum, item) => sum + item.criteria.length, 0);
  return <div className="mission-page" aria-label="Mission">
    <details className="mission-section">
      <summary><span>Goal</span><small>{total ? `${total} acceptance ${total === 1 ? "criterion" : "criteria"}` : "No acceptance criteria"}</small></summary>
      <div className="mission-section-body">
        <p className="mission-goal">{run.objective}</p>
        {criteria.length > 0 && <ul className="mission-criteria" aria-label="Acceptance criteria">
          {criteria.map((item) => <li key={item.taskId}>
            <span className="mission-criteria-task">{item.title}</span>
            <ul>{item.criteria.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </li>)}
        </ul>}
      </div>
    </details>
    <details className="mission-section" open>
      <summary><span>Crew</span><small>{crew.length ? `${crew.length} ${crew.length === 1 ? "member" : "members"}` : "Nobody yet"}</small></summary>
      <div className="mission-section-body">
        {crew.length === 0
          ? <p className="mission-none">No task has been handed to a registered agent yet.</p>
          : <ul className="mission-crew" aria-label="Crew">
            {crew.map((member) => <li key={member.id} data-state={member.state}>
              <AgentAvatar name={member.name} avatar={member.avatar} id={member.id} size={22} removed={member.removed} decorative />
              <span className="mission-crew-name">{member.name}{member.removed && <small> · no longer registered</small>}</span>
              <span className="mission-crew-roles">{member.roles.map((role) => <span key={role} className="mission-role" data-role={role}>{CREW_ROLE_LABEL[role]}</span>)}</span>
              <span className="mission-crew-state">{member.state
                ? `${member.tasks} ${member.tasks === 1 ? "task" : "tasks"} · ${STATE_LABEL[member.state]}`
                : "Coordinates"}</span>
            </li>)}
          </ul>}
      </div>
    </details>
    <details className="mission-section">
      <summary><span>Where</span><small>{places.length ? `${places.length} ${places.length === 1 ? "repository" : "repositories"}` : "No worktree yet"}</small></summary>
      <div className="mission-section-body">
        {places.length === 0
          ? <p className="mission-none">The mission's worktree is planned when its first writing task is.</p>
          : <ul className="mission-where" aria-label="Mission worktrees">
            {places.map((place) => <li key={place.repositoryRoot}>
              <span className="mission-where-repo" title={place.repositoryRoot}>{shortWorkspacePath(place.repositoryRoot)}</span>
              <dl>
                <dt>Branch</dt><dd><code>{place.branch}</code> → <code>{place.baseBranch}</code></dd>
                <dt>Worktree</dt><dd><code title={place.checkoutRoot}>{shortWorkspacePath(place.checkoutRoot)}</code>{place.planned && " · planned"}</dd>
                <dt>Git</dt><dd data-tone={place.delivery?.merged ? "ok" : undefined}>{placeStanding(place)}</dd>
              </dl>
            </li>)}
          </ul>}
      </div>
    </details>
  </div>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Hand the task over through the lead's own reassignment, then re-read the
 *  ledger. Answers the host's refusal as an Error so the form can say it. */
export async function submitReassign(
  invoke: Invoke,
  run: Pick<OrchestrationRun, "coordinatorChatKey">,
  task: Pick<OrchestrationTask, "id">,
  assignee: string,
  words: string,
  refresh: () => Promise<unknown> = () => orchestrationFeed.refresh(),
): Promise<void> {
  if (!assignee) throw new Error("Choose who takes the task over.");
  if (!words.trim()) throw new Error("Say why it changes hands; the record keeps it.");
  await invoke("orchestration_task_reassign", reassignRequest(run, task, assignee, words));
  await refresh().catch(() => {});
}

/** The row's reassign control: a quiet button beside the row's disclosure.
 *  Pressed, the row opens `ReassignForm` under its heading. Disabled, its
 *  tooltip says why the host would refuse. */
export function ReassignButton({ run, task, attempts, open, onToggle }: {
  run: OrchestrationRun;
  task: OrchestrationTask;
  attempts: readonly OrchestrationAttempt[];
  open: boolean;
  onToggle: () => void;
}) {
  const blocker = reassignBlocker(run, task, attempts);
  return <button type="button" className="orch-task-reassign" aria-expanded={open}
    disabled={!!blocker && !open}
    aria-label={`Reassign task: ${task.title}`}
    title={blocker ?? `Hand "${task.title}" to another crew member`}
    onClick={onToggle}>
    <ReassignIcon />
  </button>;
}

/** Who, why, confirm. Who may take it is asked of the host when the form
 *  opens, so it is the lead's reports as they are now. */
export function ReassignForm({ run, task, crew, onDone }: {
  run: OrchestrationRun;
  task: OrchestrationTask;
  crew: readonly CrewMember[];
  onDone: () => void;
}) {
  const [choices, setChoices] = useState<ReassignChoice[] | null>(null);
  const [assignee, setAssignee] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const crewKey = crew.map((member) => member.id).join(",");
  useEffect(() => {
    let live = true;
    bridge.invoke<Destinations>("orchestration_destinations", { actorChatKey: run.coordinatorChatKey })
      .then((directory) => { if (live) setChoices(reassignChoices(directory, run, task, crew)); })
      .catch((problem) => { if (live) { setChoices([]); setError(messageOf(problem)); } });
    return () => { live = false; };
    // The crew's ids, not its identity: a ledger refresh must not re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.coordinatorChatKey, run.workspaceId, task.id, task.assignee?.id, task.destination?.projectId, crewKey]);
  const onCrew = choices?.filter((choice) => choice.inCrew) ?? [];
  const others = choices?.filter((choice) => !choice.inCrew) ?? [];
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await submitReassign((command, args) => bridge.invoke(command, args), run, task, assignee, why);
      onDone();
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };
  return <div className="mission-reassign" role="group" aria-labelledby={`${id}-title`}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDone(); } }}>
    <p id={`${id}-title`}>Reassign from {task.assignee?.name}. The task waits for your approval again before anyone starts it.</p>
    {choices === null ? <p className="mission-none">Asking who may take it…</p>
      : choices.length === 0 ? <p className="mission-none">None of the lead's direct reports may work on this task's project.</p>
      : <>
        <label>To<select value={assignee} disabled={busy} autoFocus onChange={(event) => setAssignee(event.target.value)}>
          <option value="">Choose a crew member</option>
          {onCrew.length > 0 && <optgroup label="Crew">
            {onCrew.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}{choice.role ? ` · ${choice.role}` : ""}</option>)}
          </optgroup>}
          {others.length > 0 && <optgroup label="Other direct reports">
            {others.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}{choice.role ? ` · ${choice.role}` : ""}</option>)}
          </optgroup>}
        </select></label>
        <label>Why<input value={why} disabled={busy} placeholder="Maya is out; Noah takes over" onChange={(event) => setWhy(event.target.value)} /></label>
      </>}
    {error && <p className="orch-run-error" role="alert">{error}</p>}
    <div className="mission-reassign-actions">
      <button type="button" className="orch-quiet" disabled={busy} onClick={onDone}>Cancel</button>
      {choices && choices.length > 0 && <button type="button" className="orch-quiet is-primary" disabled={busy || !assignee || !why.trim()}
        onClick={() => void submit()}>{busy ? "Reassigning…" : "Reassign"}</button>}
    </div>
  </div>;
}

function messageOf(problem: unknown): string {
  return String((problem as Error)?.message ?? problem);
}

function ReassignIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" /></svg>;
}
