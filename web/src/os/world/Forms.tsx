import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { allowed, type Agent, type Mutate, type World } from "./types";

export function WorkflowForm({
  world,
  orgId,
  mutate,
  busy,
  done,
}: {
  world: World;
  orgId: string;
  mutate: Mutate;
  busy: boolean;
  done: () => void;
}) {
  const professions = world.professions.filter(
    (p) => p.orgId === orgId && !["pm", "recruiter"].includes(p.kind),
  );
  const [steps, setSteps] = useState<string[]>(
    professions.slice(0, 2).map((p) => p.id),
  );
  const move = (index: number, offset: number) =>
    setSteps((previous) => {
      const next = [...previous];
      const target = index + offset;
      if (target >= 0 && target < next.length)
        [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  return (
    <form
      onSubmit={(e) => {
        const values = formValues(e);
        void mutate("create_workflow", {
          ...values,
          orgId,
          professionIds: steps,
        })
          .then(done)
          .catch(() => {});
      }}
    >
      <Field
        name="name"
        label="Workflow name"
        placeholder="Develop, review, refine"
      />
      <p className="ow-note">
        PM plans against this order. A profession can appear again for a later
        review or refinement step.
      </p>
      {steps.map((id, index) => (
        <div className="ow-workflow-step" key={index}>
          <Select
            label={`Step ${index + 1}`}
            value={id}
            onChange={(value) =>
              setSteps((previous) =>
                previous.map((p, i) => (i === index ? value : p)),
              )
            }
          >
            {professions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <div className="ow-actions">
            <button
              type="button"
              aria-label={`Move step ${index + 1} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move step ${index + 1} down`}
              disabled={index === steps.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Remove step ${index + 1}`}
              disabled={steps.length === 1}
              onClick={() =>
                setSteps((previous) => previous.filter((_, i) => i !== index))
              }
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={steps.length >= 8 || !professions.length}
        onClick={() => setSteps((previous) => [...previous, professions[0].id])}
      >
        ＋ Add step
      </button>
      <footer>
        <Submit busy={busy || !steps.length}>Create workflow</Submit>
      </footer>
    </form>
  );
}

export function Modal({
  title,
  children,
  close,
  className = "",
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className={`ow-dialog ${className}`}
      ref={ref}
      onCancel={close}
      aria-label={title}
    >
      <header>
        <div>
          <span className="ow-eyebrow">OCTIQOS</span>
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="ow-icon"
          onClick={close}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Field({
  name,
  label,
  required = true,
  value = "",
  multiline = false,
  placeholder = "",
  maxLength,
}: {
  name: string;
  label: string;
  required?: boolean;
  value?: string;
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <label className="ow-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          name={name}
          required={required}
          defaultValue={value}
          placeholder={placeholder}
          maxLength={maxLength ?? 16000}
          rows={4}
        />
      ) : (
        <input
          name={name}
          required={required}
          defaultValue={value}
          placeholder={placeholder}
          maxLength={maxLength ?? 2000}
        />
      )}
    </label>
  );
}
export function Select({
  label,
  value,
  onChange,
  children,
  name,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  name?: string;
}) {
  return (
    <label className="ow-field">
      <span>{label}</span>
      <select
        aria-label={label}
        required
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
export function Submit({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <button className="ow-primary" disabled={busy} type="submit">
      {busy ? "Saving…" : children}
    </button>
  );
}
export function formValues(
  event: FormEvent<HTMLFormElement>,
): Record<string, string> {
  event.preventDefault();
  return Object.fromEntries(
    [...new FormData(event.currentTarget).entries()].map(([k, v]) => [
      k,
      String(v),
    ]),
  );
}

export function TaskForm({
  world,
  orgId,
  agent,
  projectId: initialProject,
  title = "",
  meetingId,
  mutate,
  done,
  busy,
}: {
  world: World;
  orgId: string;
  agent?: Agent;
  projectId?: string;
  title?: string;
  meetingId?: string;
  mutate: Mutate;
  done: (id: string) => void;
  busy: boolean;
}) {
  const projects = world.projects.filter(
    (p) => p.orgId === orgId && (!agent || allowed(agent, p)),
  );
  const [projectId, setProjectId] = useState(
    initialProject ?? projects[0]?.id ?? "",
  );
  const [route, setRoute] = useState(agent ? "direct" : "auto");
  const [agentId, setAgentId] = useState(agent?.id ?? "");
  const [workflowId, setWorkflowId] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const agents = world.agents.filter(
    (a) => a.kind === "worker" && project && allowed(a, project),
  );
  return (
    <form
      onSubmit={(e) => {
        const values = formValues(e);
        void mutate(meetingId ? "convert_meeting" : "create_task", {
          ...values,
          projectId,
          route,
          agentId,
          workflowId,
          meetingId,
        })
          .then((r) => done(r.id))
          .catch(() => {});
      }}
    >
      {meetingId && (
        <p className="ow-note">
          Only the outcome you write here enters the task. The meeting stays
          discussion-only.
        </p>
      )}
      <Select
        label="Project"
        value={projectId}
        onChange={(id) => {
          setProjectId(id);
          setAgentId("");
        }}
      >
        <option value="">Choose a project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Field
        name="title"
        label="What needs to be done?"
        value={title}
        placeholder="Fix the login button on mobile"
      />
      <Field
        name="detail"
        label="Context and what done looks like"
        multiline
        required={false}
        placeholder="Expected behavior, useful details, and acceptance criteria"
      />
      <div className="ow-route" role="group" aria-label="Task route">
        <button
          type="button"
          className={route === "auto" ? "selected" : ""}
          onClick={() => setRoute("auto")}
        >
          <strong>Auto PM</strong>
          <small>Plan, assign and coordinate</small>
        </button>
        <button
          type="button"
          className={route === "direct" ? "selected" : ""}
          onClick={() => setRoute("direct")}
        >
          <strong>Direct assign</strong>
          <small>One agent, focused work</small>
        </button>
      </div>
      {route === "direct" ? (
        <Select label="Assign to" value={agentId} onChange={setAgentId}>
          <option value="">Choose an eligible agent</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      ) : (
        <label className="ow-field">
          <span>Workflow</span>
          <select
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
          >
            <option value="">Let PM plan the steps</option>
            {world.workflows
              .filter((w) => w.orgId === orgId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {!projects.length && (
        <p className="ow-note">
          Create an authorized project before assigning work.
        </p>
      )}
      <footer>
        <Submit busy={busy}>Create task</Submit>
      </footer>
    </form>
  );
}

export function AgentForm({
  world,
  orgId,
  projectId,
  mutate,
  done,
  busy,
}: {
  world: World;
  orgId: string;
  projectId?: string;
  mutate: Mutate;
  done: (id: string) => void;
  busy: boolean;
}) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<string[]>(() =>
    world.projects.some((p) => p.id === projectId && p.orgId === orgId)
      ? [projectId!]
      : [],
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scope = all
    ? "All current and future projects in this org"
    : selected.length
      ? world.projects
          .filter((p) => selected.includes(p.id))
          .map((p) => p.name)
          .join(", ")
      : "No projects yet";
  return (
    <form
      onSubmit={(e) => {
        const { name } = formValues(e);
        if (sending) return;
        setSending(true);
        setError("");
        void mutate("create_agent", {
          name,
          orgId,
          allProjects: all,
          projectIds: all ? [] : selected,
        })
          .then((r) => done(r.id))
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setSending(false));
      }}
    >
      <p className="ow-note">
        Welcome someone new. Tell them what you need in Talk about role after
        they join.
      </p>
      <Field
        name="name"
        label="Agent name (optional)"
        required={false}
        maxLength={80}
        placeholder="Leave blank for an automatic name"
      />
      <details className="ow-onboarding-scope">
        <summary>
          <span>Project access: {scope}</span>
          <small>Change</small>
        </summary>
        <ScopeFields
          world={world}
          orgId={orgId}
          all={all}
          setAll={setAll}
          selected={selected}
          onSelectedChange={setSelected}
        />
      </details>
      <p className="ow-note">
        A desk and starter avatar are ready for them. Everything else can wait.
      </p>
      {error && <p role="alert">{error}</p>}
      <footer>
        <Submit busy={busy || sending}>Join and talk about role</Submit>
      </footer>
    </form>
  );
}
export function ScopeFields({
  world,
  orgId,
  all,
  setAll,
  selected = [],
  onSelectedChange,
}: {
  world: World;
  orgId: string;
  all: boolean;
  setAll: (v: boolean) => void;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
}) {
  return (
    <fieldset className="ow-scope">
      <legend>Project access</legend>
      <label>
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />{" "}
        All current and future projects in this org
      </label>
      {!all &&
        world.projects
          .filter((p) => p.orgId === orgId)
          .map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                name="projectId"
                value={p.id}
                defaultChecked={
                  onSelectedChange ? undefined : selected.includes(p.id)
                }
                checked={onSelectedChange ? selected.includes(p.id) : undefined}
                onChange={
                  onSelectedChange
                    ? (e) =>
                        onSelectedChange(
                          e.target.checked
                            ? [...selected, p.id]
                            : selected.filter((id) => id !== p.id),
                        )
                    : undefined
                }
              />{" "}
              {p.name}
            </label>
          ))}
    </fieldset>
  );
}

export function MeetingForm({
  world,
  orgId,
  agent,
  mutate,
  done,
  busy,
}: {
  world: World;
  orgId: string;
  agent?: Agent;
  mutate: Mutate;
  done: (id: string) => void;
  busy: boolean;
}) {
  const projects = world.projects.filter(
    (p) => p.orgId === orgId && (!agent || allowed(agent, p)),
  );
  const [projectId, setProject] = useState(projects[0]?.id ?? "");
  const project = projects.find((p) => p.id === projectId);
  return (
    <form
      onSubmit={(e) => {
        const values = formValues(e);
        const ids = new FormData(e.currentTarget)
          .getAll("participantId")
          .map(String);
        void mutate("create_meeting", {
          ...values,
          projectId,
          participantIds: ids,
        })
          .then((r) => done(r.id))
          .catch(() => {});
      }}
    >
      <p className="ow-note">
        A space to think together. Nobody executes work here.
      </p>
      <Field
        name="title"
        label="What are we discussing?"
        placeholder="How should we test the new onboarding?"
      />
      <Select label="Project context" value={projectId} onChange={setProject}>
        <option value="">Choose a project</option>
        {projects.map((p) => (
          <option value={p.id} key={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <fieldset className="ow-scope" key={projectId}>
        <legend>Invite up to 8 participants</legend>
        {world.agents
          .filter((a) => project && allowed(a, project))
          .map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                name="participantId"
                value={a.id}
                defaultChecked={a.id === agent?.id}
              />{" "}
              {a.name}{" "}
              <small>
                {world.professions.find((p) => p.id === a.professionId)?.name} ·{" "}
                {a.kind}
              </small>
            </label>
          ))}
      </fieldset>
      <footer>
        <Submit busy={busy}>Open meeting</Submit>
      </footer>
    </form>
  );
}
