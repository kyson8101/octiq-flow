import { useState, type ReactNode } from "react";
import { Modal } from "./Forms";
import { label, stages, type Task, type World } from "./types";

export type WorldView = "attention" | "board" | "office" | "meetings" | "setup";
export const needsFounder = (task: Task) =>
  ["needs_input", "verifying", "paused"].includes(task.status);

export function mobileTasks(
  world: World,
  orgId: string | null,
  view: WorldView,
  status: string,
  project: string,
) {
  const priority = [
    "needs_input",
    "verifying",
    "paused",
    "working",
    "planning",
    "queued",
    "done",
    "cancelled",
  ];
  return world.tasks
    .filter(
      (t) =>
        (!orgId || t.orgId === orgId) &&
        (!project || t.projectId === project) &&
        (view === "attention"
          ? needsFounder(t)
          : status === "active"
            ? !["done", "cancelled"].includes(t.status)
            : !status || t.status === status),
    )
    .sort(
      (a, b) =>
        priority.indexOf(a.status) - priority.indexOf(b.status) ||
        b.createdAt - a.createdAt,
    );
}

export function MobileNavigation({
  view,
  count,
  change,
}: {
  view: WorldView;
  count: number;
  change: (view: WorldView) => void;
}) {
  return (
    <nav className="ow-mobile-nav" aria-label="OctiqOS navigation">
      {(
        [
          ["attention", "Inbox", "◉"],
          ["board", "Tasks", "▤"],
          ["office", "Office", "▦"],
          ["meetings", "Meetings", "◌"],
        ] as const
      ).map(([id, title, icon]) => (
        <button
          key={id}
          type="button"
          aria-current={view === id ? "page" : undefined}
          onClick={() => change(id)}
        >
          <span aria-hidden="true">{icon}</span>
          <strong>{title}</strong>
          {id === "attention" && count > 0 && (
            <small aria-label={`${count} tasks need attention`}>{count}</small>
          )}
        </button>
      ))}
    </nav>
  );
}

export function MobileWorkList({
  world,
  orgId,
  view,
  inspect,
  create,
}: {
  world: World;
  orgId: string | null;
  view: WorldView;
  inspect: (kind: "task" | "meeting", id: string) => void;
  create: (kind: "task" | "meeting" | "org") => void;
}) {
  const [status, setStatus] = useState("active");
  const [project, setProject] = useState("");
  const tasks = mobileTasks(world, orgId, view, status, project);
  const meetings = world.meetings.filter(
    (m) =>
      (!orgId || m.orgId === orgId) && (!project || m.projectId === project),
  );
  const projects = world.projects.filter((p) => !orgId || p.orgId === orgId);
  return (
    <section className="ow-mobile-work">
      <div className="ow-page-heading">
        <div>
          <span className="ow-eyebrow">
            {orgId
              ? world.orgs.find((o) => o.id === orgId)?.name
              : "ALL ORGANIZATIONS"}
          </span>
          <h1>
            {view === "attention"
              ? "Your attention"
              : view === "board"
                ? "Tasks"
                : "Meetings"}
          </h1>
          <p>
            {view === "attention"
              ? "Answer questions, review outcomes, and unblock your team."
              : view === "board"
                ? "Follow the work. Step in whenever you need."
                : "Think together. Discussion only; execution starts in a task."}
          </p>
        </div>
        <div className="ow-actions">
          <button
            className="ow-primary"
            onClick={() =>
              create(
                world.orgs.length
                  ? view === "meetings"
                    ? "meeting"
                    : "task"
                  : "org",
              )
            }
          >
            ＋{" "}
            {world.orgs.length
              ? view === "meetings"
                ? "New meeting"
                : "New task"
              : "Create organization"}
          </button>
          {view === "attention" && world.orgs.length > 0 && (
            <button onClick={() => create("meeting")}>New meeting</button>
          )}
        </div>
      </div>
      <div className="ow-mobile-filters">
        <label>
          Project
          <select
            aria-label="Project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {view === "board" && (
          <label>
            Status
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="active">Active tasks</option>
              <option value="">All statuses</option>
              {stages.map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ow-mobile-list">
        {view === "meetings"
          ? meetings.map((m) => (
              <button
                key={m.id}
                className="ow-mobile-item"
                onClick={() => inspect("meeting", m.id)}
              >
                <span className="ow-eyebrow">
                  {world.orgs.find((o) => o.id === m.orgId)?.name} ·{" "}
                  {projects.find((p) => p.id === m.projectId)?.name}
                </span>
                <strong>{m.title}</strong>
                <span>
                  {m.participantIds.length} participants · {m.status}
                </span>
                <small>Discussion only · Open meeting →</small>
              </button>
            ))
          : tasks.map((t) => (
              <button
                key={t.id}
                className="ow-mobile-item"
                onClick={() => inspect("task", t.id)}
              >
                <span className="ow-eyebrow">
                  {world.orgs.find((o) => o.id === t.orgId)?.name} ·{" "}
                  {projects.find((p) => p.id === t.projectId)?.name}
                </span>
                <span className={`ow-status ${t.status}`}>
                  {label(t.status)}
                </span>
                <strong>{t.title}</strong>
                <p>
                  {t.status === "needs_input"
                    ? t.messages.at(-1)?.body || "Your team needs more context."
                    : t.status === "verifying"
                      ? "Review the evidence and confirm the outcome."
                      : t.status === "paused"
                        ? "Paused. Resume or give your team a new direction."
                        : t.detail}
                </p>
                <small>
                  {world.agents.find((a) => a.id === t.agentId)?.name ||
                    (t.route === "auto" ? "Auto PM" : "Direct task")}{" "}
                  ·{" "}
                  {t.status === "needs_input"
                    ? "Reply"
                    : t.status === "verifying"
                      ? "Review"
                      : "Open task"}{" "}
                  →
                </small>
              </button>
            ))}
        {!(view === "meetings" ? meetings.length : tasks.length) && (
          <div className="ow-empty" role="status">
            <h2>
              {view === "attention"
                ? "You're all caught up"
                : view === "meetings"
                  ? "Room to think"
                  : "No matching tasks"}
            </h2>
            <p>
              {view === "attention"
                ? "Tasks needing your input or verification will appear here."
                : view === "meetings"
                  ? "Invite specialists to brainstorm together."
                  : "Change the filters or give your team a new task."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function InspectorPanel({
  mobile,
  kind,
  close,
  children,
  title,
}: {
  mobile: boolean;
  kind: string;
  close: () => void;
  children: ReactNode;
  title?: string;
}) {
  if (kind === "task") return (
    <Modal title={title ?? "Task conversation"} close={close} className="ow-secretary-modal ow-task-modal">
      {children}
    </Modal>
  );
  if (mobile)
    return (
      <Modal
        title={`${kind} details`}
        close={close}
        className="ow-detail-dialog"
      >
        <div className="ow-inspector ow-mobile-detail">{children}</div>
      </Modal>
    );
  return (
    <aside className="ow-inspector" aria-label={`${kind} details`}>
      <header>
        <span className="ow-eyebrow">{kind} DETAILS</span>
        <button onClick={close} aria-label="Close details">
          ×
        </button>
      </header>
      {children}
    </aside>
  );
}
