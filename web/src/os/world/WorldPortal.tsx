import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type ConnectionState } from "../../lib/bridge";
import { useMedia } from "../../lib/media";
import {
  InspectorPanel,
  MobileNavigation,
  MobileWorkList,
  needsFounder,
  type WorldView,
} from "./MobileViews";
import {
  AgentForm,
  Field,
  MeetingForm,
  Modal,
  Submit,
  TaskForm,
  WorkflowForm,
  formValues,
} from "./Forms";
import {
  AgentInspector,
  Avatar,
  MeetingInspector,
  TaskInspector,
} from "./Inspectors";
import { SecretaryDesk } from "./Secretary";
import { acceptSnapshot, stages, type Mutate, type Snapshot } from "./types";
import "./world.css";

type Dialog = {
  kind:
    | "org"
    | "project"
    | "profession"
    | "workflow"
    | "secretary"
    | "agent"
    | "task"
    | "meeting";
  agentId?: string;
  projectId?: string;
  meetingId?: string;
} | null;
type Inspector = {
  kind: "agent" | "task" | "meeting";
  id: string;
  talkAboutRole?: boolean;
} | null;

export function WorldPortal() {
  const mobile = useMedia("(max-width: 760px)");
  const [connection, setConnection] = useState<ConnectionState>(bridge.state);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [view, setView] = useState<WorldView>(() =>
    mobile ? "attention" : "office",
  );
  const [projectFilter, setProjectFilter] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [inspector, setInspector] = useState<Inspector>(null);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [view, orgId]);
  const refresh = useCallback(async () => {
    try {
      const next = await bridge.invoke<Snapshot>("world_snapshot");
      setSnapshot((p) => acceptSnapshot(p, next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => bridge.onState(setConnection), []);
  useEffect(() => {
    if (connection !== "open") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection, refresh]);
  useEffect(() => {
    document.title = "OctiqOS — Your agent world";
  }, []);
  const mutate: Mutate = async (action, args) => {
    const foreground = action !== "generate_avatar";
    if (foreground) setBusy(true);
    setError("");
    try {
      const result = await bridge.invoke<{
        result: { id: string };
        snapshot: Snapshot;
      }>(`world_${action}`, { ...args, requestId: crypto.randomUUID() });
      setSnapshot((p) => acceptSnapshot(p, result.snapshot));
      return result.result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      throw new Error(message);
    } finally {
      if (foreground) setBusy(false);
    }
  };
  const world = snapshot?.world;
  const org = world?.orgs.find((o) => o.id === orgId);
  const secretary = world?.agents.find(
    (agent) =>
      agent.orgId === orgId &&
      world.professions.some(
        (profession) =>
          profession.id === agent.professionId &&
          ["secretary", "recruiter"].includes(profession.kind),
      ),
  );
  const agents =
    world?.agents.filter(
      (agent) =>
        agent.orgId === orgId &&
        !world.professions.some(
          (profession) =>
            profession.id === agent.professionId &&
            ["secretary", "recruiter"].includes(profession.kind),
        ),
    ) ?? [];
  const projects = world?.projects.filter((p) => p.orgId === orgId) ?? [];
  const tasks =
    world?.tasks.filter(
      (t) =>
        t.orgId === orgId && (!projectFilter || t.projectId === projectFilter),
    ) ?? [];
  const meetings = world?.meetings.filter((m) => m.orgId === orgId) ?? [];
  const attention =
    world?.tasks.filter((t) => t.status === "needs_input") ?? [];
  const selectedAgent = world?.agents.find((a) => a.id === inspector?.id);
  const selectedTask = world?.tasks.find((t) => t.id === inspector?.id);
  const selectedMeeting = world?.meetings.find((m) => m.id === inspector?.id);
  const enter = (id: string) => {
    setOrgId(id);
    setView("office");
    setProjectFilter("");
    setInspector(null);
  };
  const inspectCreated =
    (kind: "agent" | "task" | "meeting") => (id: string) => {
      setDialog(null);
      setInspector({ kind, id, talkAboutRole: kind === "agent" });
    };
  const fromAgent = dialog?.agentId
    ? world?.agents.find((a) => a.id === dialog.agentId)
    : undefined;
  const fromMeeting = dialog?.meetingId
    ? world?.meetings.find((m) => m.id === dialog.meetingId)
    : undefined;
  const closeDialog = () => setDialog(null);
  const ready = connection === "open" && !!snapshot;
  const listView =
    (mobile || view === "attention") &&
    ["attention", "board", "meetings"].includes(view);
  const changeView = (next: WorldView) => {
    setView(next);
    setInspector(null);
  };
  const createMobile = (kind: "task" | "meeting" | "org") => {
    if (!orgId && world?.orgs.length === 1) setOrgId(world.orgs[0].id);
    setDialog({ kind });
  };

  return (
    <div className="ow">
      <header className="ow-topbar">
        <a className="ow-brand" href="/os">
          <span className="ow-brand-mark">◈</span> OCTIQ<span>OS</span>
          <small>AGENT WORLD</small>
        </a>
        <div className="ow-top-right">
          <span className={`ow-connection ${connection}`}>
            {connection === "open" ? "Connected" : connection}
          </span>
          <a href="/os?view=legacy">Mission archive ↗</a>
          <a href="/">OctiqFlow ↗</a>
        </div>
      </header>
      {mobile && world && (
        <div className="ow-mobile-scope">
          <label>
            Organization
            <select
              aria-label="Organization"
              value={orgId ?? ""}
              onChange={(e) => {
                setOrgId(e.target.value || null);
                setProjectFilter("");
                setInspector(null);
                if (view === "setup" && !e.target.value) setView("office");
              }}
            >
              <option value="">All organizations</option>
              {world.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              org ? changeView("setup") : setDialog({ kind: "org" })
            }
          >
            {org ? "Manage" : "New org"}
          </button>
          <a href="/">OctiqFlow ↗</a>
        </div>
      )}
      <div className="ow-shell">
        <aside className="ow-rail">
          <button
            className={!orgId ? "active" : ""}
            onClick={() => {
              setOrgId(null);
              setView("office");
              setInspector(null);
            }}
          >
            <span>⌘</span> World map
          </button>
          <p className="ow-eyebrow">ORGANIZATIONS</p>
          {world?.orgs.map((o) => (
            <button
              key={o.id}
              className={o.id === orgId ? "active" : ""}
              onClick={() => enter(o.id)}
            >
              <span>▦</span>
              {o.name}
              <small>
                {world.tasks.filter(
                  (t) => t.orgId === o.id && t.status === "needs_input",
                ).length || ""}
              </small>
            </button>
          ))}
          <button
            className="ow-add-link"
            disabled={!ready}
            onClick={() => setDialog({ kind: "org" })}
          >
            ＋ New organization
          </button>
          <div className="ow-rail-bottom">
            <span className="ow-eyebrow">YOUR ATTENTION</span>
            <strong>{attention.length}</strong>
            <p>tasks need your input</p>
            {attention.slice(0, 4).map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  enter(t.orgId);
                  setInspector({ kind: "task", id: t.id });
                }}
              >
                {t.title} ↗
              </button>
            ))}
          </div>
        </aside>
        <main className="ow-main" ref={main}>
          {error && (
            <div className="ow-error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {!world && (
            <div className="ow-welcome">
              <span className="ow-eyebrow">WELCOME TO OCTIQOS</span>
              <h1>Your team is a world of its own.</h1>
              <p>
                {connection === "open"
                  ? "Opening your saved organizations…"
                  : "Connecting to your OctiqFlow service…"}
              </p>
              <button
                onClick={() => void refresh()}
                disabled={connection !== "open"}
              >
                Retry
              </button>
            </div>
          )}
          {world && listView && (
            <MobileWorkList
              key={`${orgId ?? "all"}:${view}`}
              world={world}
              orgId={orgId}
              view={view}
              inspect={(kind, id) => setInspector({ kind, id })}
              create={createMobile}
            />
          )}
          {world && !org && !listView && (
            <>
              <div className="ow-page-heading">
                <div>
                  <span className="ow-eyebrow">A PLACE FOR EVERY TEAM</span>
                  <h1>Your world</h1>
                  <p>
                    Step into an office. See the work. Shape what comes next.
                  </p>
                </div>
                <button
                  className="ow-primary"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "org" })}
                >
                  ＋ Create organization
                </button>
              </div>
              <div className="ow-map">
                <div className="ow-map-label">
                  OCTIQ DISTRICT <span>01</span>
                </div>
                <div className="ow-road horizontal" />
                <div className="ow-road vertical" />
                <span className="ow-tree t1">♣</span>
                <span className="ow-tree t2">♣</span>
                <span className="ow-tree t3">♣</span>
                <div className="ow-buildings">
                  {world.orgs.map((o, i) => (
                    <button
                      className="ow-building"
                      key={o.id}
                      onClick={() => enter(o.id)}
                      style={
                        {
                          "--building-hue": String((i * 53 + 160) % 360),
                        } as React.CSSProperties
                      }
                    >
                      <div className="ow-building-roof">
                        <span>{o.name.slice(0, 2).toUpperCase()}</span>
                      </div>
                      <div className="ow-building-body">
                        <div className="ow-windows">
                          {Array.from({ length: 6 }, (_, n) => (
                            <i key={n} />
                          ))}
                        </div>
                        <div className="ow-door" />
                      </div>
                      <div className="ow-building-sign">
                        <strong>{o.name}</strong>
                        <small>
                          {world.agents.filter((a) => a.orgId === o.id).length}{" "}
                          members ·{" "}
                          {
                            world.projects.filter((p) => p.orgId === o.id)
                              .length
                          }{" "}
                          projects
                        </small>
                        {world.tasks.some(
                          (t) => t.orgId === o.id && t.status === "needs_input",
                        ) && (
                          <span className="ow-attention-dot">
                            Needs your input
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                  {!world.orgs.length && (
                    <button
                      className="ow-empty-plot"
                      onClick={() => setDialog({ kind: "org" })}
                    >
                      <span>＋</span>
                      <strong>Your first office starts here</strong>
                      <small>
                        Create an organization to bring your team together.
                      </small>
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {world && org && !listView && (
            <>
              <div className="ow-page-heading">
                <div>
                  <span className="ow-eyebrow">YOUR ORGANIZATION</span>
                  <h1>{org.name}</h1>
                  <p>
                    {org.description ||
                      "A focused team. A shared place to work."}
                  </p>
                </div>
                <button
                  className="ow-primary"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "task" })}
                >
                  ＋ New task
                </button>
              </div>
              <div className="ow-orgbar">
                <nav className="ow-tabs" aria-label="Organization views">
                  {(["office", "board", "meetings", "setup"] as const).map(
                    (v) => (
                      <button
                        key={v}
                        className={view === v ? "active" : ""}
                        onClick={() => setView(v)}
                      >
                        {v}
                      </button>
                    ),
                  )}
                </nav>
                <span>
                  {agents.length} team members · 1 secretary · {projects.length} projects ·{" "}
                  {
                    tasks.filter((t) =>
                      ["working", "planning"].includes(t.status),
                    ).length
                  }{" "}
                  active tasks
                </span>
              </div>
              {view === "office" && (
                <div className="ow-office">
                  <div className="ow-office-wall">
                    <span>{org.name.toUpperCase()} / STUDIO</span>
                    <div className="ow-wall-windows">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <div className="ow-office-floor">
                    <div className="ow-office-team">
                      {secretary && (
                        <button
                          className="ow-reception"
                          onClick={() => setDialog({ kind: "secretary" })}
                        >
                          <span className="ow-reception-sign">RECEPTION</span>
                          <Avatar agent={secretary} />
                          <span>
                            <strong>{secretary.name}</strong>
                            <small>
                              {snapshot.stats.find((s) => s.agentId === secretary.id)?.secretaryConfig
                                ? "Preparing your blueprint…"
                                : snapshot.stats.find((s) => s.agentId === secretary.id)?.recruiting
                                  ? "Recruiting a team member…"
                                  : "Tell me what you want to build"}
                            </small>
                          </span>
                          <b>Talk →</b>
                        </button>
                      )}
                      <div className="ow-desks">
                      {agents.map((a) => {
                        const stats = snapshot.stats.find(
                          (s) => s.agentId === a.id,
                        );
                        return (
                          <button
                            key={a.id}
                            className={`ow-desk ${stats?.active || stats?.discussing || stats?.recruiting || stats?.roleSetup ? "working" : ""}`}
                            onClick={() =>
                              setInspector({ kind: "agent", id: a.id })
                            }
                          >
                            <span className="ow-agent-bubble">
                              {stats?.active
                                ? `${stats.active} active task${stats.active === 1 ? "" : "s"}`
                                : stats?.roleSetup
                                  ? "Defining a role"
                                  : stats?.recruiting
                                    ? "Recruiting"
                                    : stats?.discussing
                                      ? "In meeting"
                                      : stats?.stopping
                                        ? "Stopping…"
                                        : stats?.queued
                                          ? `${stats.queued} queued`
                                          : "Available"}
                            </span>
                            <div className="ow-desk-surface">
                              <span className="ow-monitor">
                                <i />
                              </span>
                              <span className="ow-coffee" />
                            </div>
                            <Avatar agent={a} />
                            <div className="ow-desk-label">
                              <strong>{a.name}</strong>
                              <small>
                                {
                                  world.professions.find(
                                    (p) => p.id === a.professionId,
                                  )?.name
                                }{" "}
                                · Lv. {stats?.level ?? 1}
                              </small>
                            </div>
                          </button>
                        );
                      })}
                      <button
                        className="ow-empty-desk"
                        onClick={() => setDialog({ kind: "agent" })}
                      >
                        <span>＋</span>
                        <strong>Welcome a new member</strong>
                        <small>Join first. Shape the role together.</small>
                      </button>
                      </div>
                    </div>
                    <div className="ow-office-zones">
                      <button
                        className="ow-meeting-zone"
                        onClick={() => setView("meetings")}
                      >
                        <span className="ow-eyebrow">THINK TOGETHER</span>
                        <div className="ow-table-art">
                          <i />
                          <i />
                          <i />
                          <i />
                        </div>
                        <strong>Meeting Room</strong>
                        <small>
                          Discussion only · {meetings.length} meetings
                        </small>
                      </button>
                      <button
                        className="ow-board-zone"
                        onClick={() => setView("board")}
                      >
                        <div className="ow-board-art">
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                        </div>
                        <strong>Task board</strong>
                        <small>
                          {
                            tasks.filter((t) => t.status === "needs_input")
                              .length
                          }{" "}
                          need your input
                        </small>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {view === "board" && (
                <>
                  <div className="ow-board-tools">
                    <label>
                      Project{" "}
                      <select
                        value={projectFilter}
                        onChange={(e) => setProjectFilter(e.target.value)}
                      >
                        <option value="">All projects</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <small>
                      Office activity and this board share the same task
                      records.
                    </small>
                  </div>
                  <div className="ow-board">
                    {stages.map(([status, title]) => (
                      <section className="ow-lane" key={status}>
                        <h3>
                          <span className={`ow-status-dot ${status}`} />
                          {title}
                          <small>
                            {tasks.filter((t) => t.status === status).length}
                          </small>
                        </h3>
                        {tasks
                          .filter((t) => t.status === status)
                          .map((t) => (
                            <button
                              key={t.id}
                              className="ow-task-card"
                              onClick={() =>
                                setInspector({ kind: "task", id: t.id })
                              }
                            >
                              <span className="ow-eyebrow">
                                {
                                  projects.find((p) => p.id === t.projectId)
                                    ?.name
                                }
                              </span>
                              <strong>{t.title}</strong>
                              <p>
                                {t.status === "needs_input"
                                  ? t.messages.at(-1)?.body
                                  : t.detail || "Open task details"}
                              </p>
                              <footer>
                                <span className="ow-tag">
                                  {t.route === "auto" ? "Auto PM" : "Direct"}
                                </span>
                                <small>
                                  {world.agents.find((a) => a.id === t.agentId)
                                    ?.name ??
                                    (t.steps.length
                                      ? `${Math.min(t.step + 1, t.steps.length)} / ${t.steps.length}`
                                      : "")}
                                </small>
                              </footer>
                            </button>
                          ))}
                      </section>
                    ))}
                  </div>
                </>
              )}
              {view === "meetings" && (
                <>
                  <div className="ow-section-heading">
                    <div>
                      <h2>Room to think</h2>
                      <p>
                        Bring specialists together. Explore freely. Turn
                        outcomes into tasks when ready.
                      </p>
                    </div>
                    <button onClick={() => setDialog({ kind: "meeting" })}>
                      ＋ New meeting
                    </button>
                  </div>
                  <div className="ow-card-grid">
                    {meetings.map((m) => (
                      <button
                        key={m.id}
                        className="ow-meeting-card"
                        onClick={() =>
                          setInspector({ kind: "meeting", id: m.id })
                        }
                      >
                        <span className="ow-tag">DISCUSSION ONLY</span>
                        <h3>{m.title}</h3>
                        <div className="ow-mini-avatars">
                          {m.participantIds.map((id) => {
                            const a = world.agents.find((a) => a.id === id);
                            return a ? <Avatar key={id} agent={a} /> : null;
                          })}
                        </div>
                        <p>
                          {m.participantIds.length} participants ·{" "}
                          {m.messages.length} messages
                        </p>
                        <small>
                          {m.status === "discussing"
                            ? "Discussion in progress"
                            : m.status}
                        </small>
                      </button>
                    ))}
                    {!meetings.length && (
                      <div className="ow-empty">
                        <h3>Start a conversation</h3>
                        <p>
                          Invite one agent or a group of specialists to your
                          first meeting.
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
              {view === "setup" && (
                <div className="ow-setup">
                  <section>
                    <div className="ow-section-heading">
                      <h2>Projects</h2>
                      <button onClick={() => setDialog({ kind: "project" })}>
                        ＋ Add project
                      </button>
                    </div>
                    {projects.map((p) => (
                      <article className="ow-setup-row" key={p.id}>
                        <strong>{p.name}</strong>
                        <small>
                          {p.workspacePath || "Discussion context only"}
                        </small>
                        <p>{p.context || "No shared context yet."}</p>
                        <small>
                          Test runner: {p.runnerImage || "node:22-alpine"}
                        </small>
                        <button
                          onClick={() =>
                            setDialog({ kind: "project", projectId: p.id })
                          }
                        >
                          Edit project context
                        </button>
                      </article>
                    ))}
                    {!projects.length && (
                      <p className="ow-empty">
                        Add a project before assigning tasks or opening
                        meetings.
                      </p>
                    )}
                  </section>
                  <section>
                    <div className="ow-section-heading">
                      <h2>Professions</h2>
                      <button onClick={() => setDialog({ kind: "profession" })}>
                        ＋ Create profession
                      </button>
                    </div>
                    {world.professions
                      .filter((p) => p.orgId === orgId)
                      .map((p) => (
                        <article className="ow-setup-row" key={p.id}>
                          <strong>{p.name}</strong>
                          <p>{p.guidance}</p>
                        </article>
                      ))}
                  </section>
                  <section>
                    <div className="ow-section-heading">
                      <h2>Workflows</h2>
                      <button onClick={() => setDialog({ kind: "workflow" })}>
                        ＋ Create workflow
                      </button>
                    </div>
                    {world.workflows
                      .filter((w) => w.orgId === orgId)
                      .map((w) => (
                        <article className="ow-setup-row" key={w.id}>
                          <strong>{w.name}</strong>
                          <p>
                            {w.professionIds
                              .map(
                                (id) =>
                                  world.professions.find((p) => p.id === id)
                                    ?.name,
                              )
                              .join(" → ")}
                          </p>
                        </article>
                      ))}
                    <p className="ow-note">
                      Auto PM can plan steps when no workflow is selected.
                      Direct tasks skip PM orchestration.
                    </p>
                  </section>
                  <section>
                    <h2>Provider connections</h2>
                    {Object.entries(snapshot.providers)
                      .filter(([name]) => name !== "higgsfield")
                      .map(([name, ready]) => (
                        <p key={name}>
                          <span className={`ow-tag ${ready ? "good" : "warm"}`}>
                            {ready ? "Configured" : "Not configured"}
                          </span>{" "}
                          {name === "image"
                            ? snapshot.providers.higgsfield
                              ? "Avatar generation · Higgsfield"
                              : "Avatar generation"
                            : name}
                        </p>
                      ))}
                    <p className="ow-note">
                      Account credentials are configured privately on the
                      preview service. Register agents with model IDs available
                      to those accounts.
                    </p>
                  </section>
                </div>
              )}
            </>
          )}
        </main>
        {world && snapshot && inspector && (
          <InspectorPanel
            mobile={mobile}
            kind={inspector.kind}
            close={() => setInspector(null)}
          >
            {inspector.kind === "agent" && selectedAgent && (
              <AgentInspector
                key={selectedAgent.id}
                agent={selectedAgent}
                initialTab={inspector.talkAboutRole ? "role" : "profile"}
                snapshot={snapshot}
                mutate={mutate}
                busy={busy}
                hire={() => {
                  setOrgId(selectedAgent.orgId);
                  setDialog({ kind: "agent" });
                }}
                task={() => {
                  setOrgId(selectedAgent.orgId);
                  setDialog({ kind: "task", agentId: selectedAgent.id });
                }}
                meeting={() => {
                  setOrgId(selectedAgent.orgId);
                  setDialog({ kind: "meeting", agentId: selectedAgent.id });
                }}
              />
            )}
            {inspector.kind === "task" && selectedTask && (
              <TaskInspector
                key={selectedTask.id}
                task={selectedTask}
                world={world}
                mutate={mutate}
                busy={busy}
              />
            )}
            {inspector.kind === "meeting" && selectedMeeting && (
              <MeetingInspector
                key={selectedMeeting.id}
                meeting={selectedMeeting}
                world={world}
                mutate={mutate}
                busy={busy}
                convert={() => {
                  setOrgId(selectedMeeting.orgId);
                  setDialog({ kind: "task", meetingId: selectedMeeting.id });
                }}
              />
            )}
          </InspectorPanel>
        )}
      </div>
      {mobile && (
        <MobileNavigation
          view={view}
          count={
            world?.tasks.filter(
              (t) => (!orgId || t.orgId === orgId) && needsFounder(t),
            ).length ?? 0
          }
          change={changeView}
        />
      )}
      {dialog && world && (
        <Modal
          title={
            dialog.kind === "secretary"
              ? `${org?.name ?? "Organization"} Secretary`
              : dialog.kind === "agent"
              ? "Welcome a new agent"
              : dialog.kind === "task"
                ? "Give your team a task"
                : dialog.kind === "meeting"
                  ? "Open a meeting"
                  : `Create ${dialog.kind}`
          }
          close={closeDialog}
          className={dialog.kind === "secretary" ? "ow-secretary-modal" : ""}
        >
          {error && (
            <p className="ow-error" role="alert">
              {error}
            </p>
          )}
          {["task", "meeting"].includes(dialog.kind) && !orgId && (
            <label className="ow-field">
              <span>Choose an organization</span>
              <select
                value=""
                onChange={(e) => setOrgId(e.target.value || null)}
              >
                <option value="">Choose an organization</option>
                {world.orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {dialog.kind === "task" && orgId && (
            <TaskForm
              world={world}
              orgId={orgId}
              agent={fromAgent}
              projectId={fromMeeting?.projectId}
              title={fromMeeting?.title}
              meetingId={fromMeeting?.id}
              mutate={mutate}
              done={inspectCreated("task")}
              busy={busy}
            />
          )}
          {dialog.kind === "agent" && orgId && (
            <AgentForm
              key={orgId}
              world={world}
              orgId={orgId}
              projectId={projectFilter}
              mutate={mutate}
              done={inspectCreated("agent")}
              busy={busy}
            />
          )}
          {dialog.kind === "secretary" && orgId && secretary && (
            <SecretaryDesk
              world={world}
              orgId={orgId}
              secretary={secretary}
              mutate={mutate}
              busy={busy}
            />
          )}
          {dialog.kind === "meeting" && orgId && (
            <MeetingForm
              world={world}
              orgId={orgId}
              agent={fromAgent}
              mutate={mutate}
              done={inspectCreated("meeting")}
              busy={busy}
            />
          )}
          {dialog.kind === "org" && (
            <form
              onSubmit={(e) => {
                const values = formValues(e);
                void mutate("create_org", values)
                  .then((r) => {
                    closeDialog();
                    enter(r.id);
                  })
                  .catch(() => {});
              }}
            >
              <Field
                name="name"
                label="Organization name"
                placeholder="Studio North"
              />
              <Field
                name="description"
                label="What is this organization for?"
                multiline
                required={false}
              />
              <footer>
                <Submit busy={busy}>Build your office</Submit>
              </footer>
            </form>
          )}
          {dialog.kind === "project" && (
            <form
              onSubmit={(e) => {
                const values = formValues(e);
                void mutate(
                  dialog.projectId ? "update_project" : "create_project",
                  { ...values, orgId, projectId: dialog.projectId },
                )
                  .then(closeDialog)
                  .catch(() => {});
              }}
            >
              {!dialog.projectId && <Field name="name" label="Project name" />}
              {!dialog.projectId && (
                <Field
                  name="workspacePath"
                  label="Workspace folder"
                  required={false}
                  placeholder="Absolute path to this project's folder"
                />
              )}
              <Field
                name="runnerImage"
                label="Test runner image"
                required={false}
                value={
                  world.projects.find((p) => p.id === dialog.projectId)
                    ?.runnerImage || "node:22-alpine"
                }
              />
              <Field
                name="context"
                label="Shared project context"
                multiline
                required={false}
                value={
                  world.projects.find((p) => p.id === dialog.projectId)
                    ?.context || ""
                }
                placeholder="Goals, constraints, and confirmed decisions"
              />
              <footer>
                <Submit busy={busy}>
                  {dialog.projectId ? "Save project" : "Create project"}
                </Submit>
              </footer>
            </form>
          )}
          {dialog.kind === "profession" && (
            <form
              onSubmit={(e) => {
                const values = formValues(e);
                void mutate("create_profession", { ...values, orgId })
                  .then(closeDialog)
                  .catch(() => {});
              }}
            >
              <Field name="name" label="Profession name" />
              <label className="ow-field">
                <span>Responsibility</span>
                <select name="kind">
                  <option value="custom">Custom execution profession</option>
                  <option value="tester">Tester / read-only reviewer</option>
                  <option value="dev">Developer</option>
                  <option value="infra">Infrastructure</option>
                  <option value="pm">Project manager</option>
                </select>
              </label>
              <Field
                name="guidance"
                label="Responsibilities, methods, and standards"
                multiline
              />
              <footer>
                <Submit busy={busy}>Create profession</Submit>
              </footer>
            </form>
          )}
          {dialog.kind === "workflow" && orgId && (
            <WorkflowForm
              world={world}
              orgId={orgId}
              mutate={mutate}
              busy={busy}
              done={closeDialog}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
