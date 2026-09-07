import { useEffect, useRef, useState } from "react";
import { bridge } from "../../lib/bridge";
import { Field, ScopeFields, Select, Submit, formValues } from "./Forms";
import { RoleEditor } from "./RoleEditor";
import { RoleChat } from "./RoleChat";
import { AgentSettings } from "./AgentSettings";
import { AgentTasks } from "./AgentTasks";
import { Transcript } from "./Transcript";
export { Transcript } from "./Transcript";
export { TaskWorkspace as TaskInspector } from "./TaskWorkspace";
import {
  allowed,
  formatTokens,
  type Agent,
  type Meeting,
  type Mutate,
  type Snapshot,
  type World,
} from "./types";

const avatarCache = new Map<string, Promise<string | null>>();

export function Avatar({
  agent,
  large = false,
}: {
  agent: Agent;
  large?: boolean;
}) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setImage(null);
    if (agent.avatar) {
      const key = `${agent.id}:${agent.avatar}`;
      let pending = avatarCache.get(key);
      if (!pending) {
        pending = bridge
          .invoke<{ image: string | null }>("world_avatar", {
            agentId: agent.id,
          })
          .then((value) => value.image)
          .catch(() => {
            avatarCache.delete(key);
            return null;
          });
        avatarCache.set(key, pending);
        if (avatarCache.size > 100)
          avatarCache.delete(avatarCache.keys().next().value!);
      }
      void pending.then((value) => {
        if (active) setImage(value);
      });
    }
    return () => {
      active = false;
    };
  }, [agent.id, agent.avatar]);
  return (
    <span
      className={`ow-avatar ${large ? "large" : ""}`}
      style={
        {
          "--avatar-hue": String((agent.desk * 67 + 145) % 360),
        } as React.CSSProperties
      }
    >
      {image ? (
        <img src={image} alt={`${agent.name}'s avatar`} />
      ) : (
        <svg
          viewBox="0 0 32 40"
          aria-label={`${agent.name}'s starter avatar`}
          role="img"
          shapeRendering="crispEdges"
        >
          <path fill="#14262c" d="M8 2h16v4h4v14h-4v4H8v-4H4V6h4z" />
          <path fill="#efc69a" d="M8 8h16v12h-4v4h-8v-4H8z" />
          <path fill="#15262b" d="M10 11h3v3h-3zm9 0h3v3h-3z" />
          <path fill="#b27663" d="M14 18h5v2h-5z" />
          <path
            className="ow-shirt"
            d="M8 23h16v4h4v9h-6v-7h-2v7h-8v-7h-2v7H4v-9h4z"
          />
          <path fill="#15262b" d="M10 35h6v5H8v-3h2zm7 0h5v2h2v3h-7z" />
        </svg>
      )}
    </span>
  );
}

export function AgentInspector({
  agent,
  snapshot,
  mutate,
  busy,
  task,
  meeting,
  hire,
  openTask,
  initialTab = "tasks",
}: {
  agent: Agent;
  snapshot: Snapshot;
  mutate: Mutate;
  busy: boolean;
  task: () => void;
  meeting: () => void;
  hire?: () => void;
  openTask: (taskId: string) => void;
  initialTab?: "tasks" | "profile" | "role";
}) {
  const { world } = snapshot;
  const stats = snapshot.stats.find((s) => s.agentId === agent.id);
  const [projectId, setProject] = useState(
    world.projects.find((p) => allowed(agent, p))?.id ?? "",
  );
  const [all, setAll] = useState(agent.allProjects);
  const [tab, setTab] = useState(initialTab as string);
  const [generating, setGenerating] = useState(false);
  const [rolePrompt, setRolePrompt] = useState(agent.rolePrompt ?? "");
  const [roleSaved, setRoleSaved] = useState(false);
  const previousRole = useRef(agent.rolePrompt ?? "");
  useEffect(() => {
    const before = previousRole.current;
    const next = agent.rolePrompt ?? "";
    setRolePrompt((current) => (current === before ? next : current));
    previousRole.current = next;
    setRoleSaved(false);
  }, [agent.rolePrompt]);
  const profession = world.professions.find((p) => p.id === agent.professionId);
  const memories = world.memories.filter(
    (m) =>
      m.agentId === agent.id &&
      m.projectId === projectId &&
      world.projects.some((p) => p.id === projectId && allowed(agent, p)),
  );
  return (
    <>
      <div className="ow-profile-head">
        <Avatar agent={agent} large />
        <div>
          <span className="ow-tag">
            LEVEL {stats?.level ?? 1} · {agent.kind}
          </span>
          <h3>{agent.name}</h3>
          <p>{profession?.name}</p>
        </div>
      </div>
      {tab !== "tasks" && <><div className="ow-xp">
        <span>{stats?.xp ?? 0} XP</span>
        <progress max={stats?.next ?? 100} value={stats?.progress ?? 0} />
        <small>
          {stats?.progress ?? 0} / {stats?.next ?? 100} to next level
        </small>
      </div>
      <div className="ow-three ow-metrics">
        <div>
          <strong>{stats?.active ?? 0}</strong>
          <small>Active tasks</small>
        </div>
        <div>
          <strong>{stats?.queued ?? 0}</strong>
          <small>Queued</small>
        </div>
        <div>
          <strong>
            {stats?.usageSamples
              ? formatTokens(stats.inputTokens + stats.outputTokens)
              : "—"}
          </strong>
          <small>Recorded tokens</small>
        </div>
      </div>
      {!!stats?.recruiting && (
        <p className="ow-muted">Preparing an agent role.</p>
      )}
      {!!stats?.roleSetup && (
        <p className="ow-muted">Responding to a role conversation.</p>
      )}
      {!!stats?.discussing && (
        <p className="ow-muted">In a discussion-only meeting.</p>
      )}
      {!!stats?.stopping && (
        <p className="ow-muted">
          Paused. Waiting for the current response to finish before starting
          another task.
        </p>
      )}
      </>}
      <div className="ow-actions">
        <button
          className="ow-primary"
          disabled={agent.kind === "consultant"}
          onClick={task}
        >
          Give task
        </button>
        <button onClick={meeting}>Invite to meeting</button>
        <button onClick={() => setTab("role")}>Talk about role</button>
        {hire && ["pm", "secretary", "recruiter"].includes(profession?.kind ?? "") && (
          <button onClick={hire}>Hire a teammate</button>
        )}
      </div>
      <nav className="ow-tabs" aria-label="Agent details">
        {["tasks", "profile", "role", "memory", "scope", "progress"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "tasks" && <AgentTasks agent={agent} world={world} openTask={openTask} />}
      {tab === "profile" && (
        <>
          <h4>Role description</h4>
          <p className="ow-prose">
            {agent.roleDescription ||
              "Not defined yet. Talk about this role to shape the agent's responsibilities."}
          </p>
          {profession?.guidance && (
            <>
              <h4>Professional guidance</h4>
              <p className="ow-prose">{profession.guidance}</p>
            </>
          )}
          <p className="ow-note">
            {agent.allProjects
              ? "Works across all projects in this org."
              : `${agent.projectIds.length} selected projects.`}{" "}
            Each task has an independent context.
          </p>
          <h4>Avatar</h4>
          <p>
            {agent.appearance ||
              "Your starter avatar is ready. You can describe a favorite character in Advanced settings."}
          </p>
          <button
            disabled={
              generating ||
              agent.avatarGeneration?.status === "generating" ||
              !snapshot.providers.image
            }
            onClick={() => {
              setGenerating(true);
              void mutate("generate_avatar", { agentId: agent.id })
                .catch(() => {})
                .finally(() => setGenerating(false));
            }}
          >
            {generating || agent.avatarGeneration?.status === "generating"
              ? "Generating…"
              : snapshot.providers.higgsfield
                ? "Generate with Higgsfield"
                : "Generate avatar"}
          </button>
          {agent.avatarGeneration?.status === "generating" && (
            <p className="ow-muted">
              Creating with {agent.avatarGeneration.provider}. You can continue
              working; your avatar will appear when ready.
            </p>
          )}
          {agent.avatarGeneration?.error && (
            <p role="alert">{agent.avatarGeneration.error}</p>
          )}
          {!snapshot.providers.image && (
            <small className="ow-muted">Image provider is not connected.</small>
          )}
          <AgentSettings
            agent={agent}
            world={world}
            mutate={mutate}
            busy={busy}
          />
        </>
      )}
      {tab === "role" && (
        <>
          <RoleChat agent={agent} world={world} mutate={mutate} busy={busy} />
          <details className="ow-role-manual">
            <summary>Edit prompt manually or use Secretary drafts</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate("update_role_prompt", {
                  agentId: agent.id,
                  rolePrompt,
                })
                  .then(() => setRoleSaved(true))
                  .catch(() => {});
              }}
            >
              <RoleEditor
                world={world}
                orgId={agent.orgId}
                professionId={agent.professionId}
                targetAgentId={agent.id}
                value={rolePrompt}
                onChange={setRolePrompt}
                mutate={mutate}
                busy={busy}
              />
              <Submit
                busy={
                  busy ||
                  (world.roleRequests ?? []).some(
                    (r) =>
                      r.agentId === agent.id &&
                      ["queued", "generating"].includes(r.status),
                  ) ||
                  (world.recruitmentDrafts ?? []).some(
                    (d) =>
                      d.targetAgentId === agent.id &&
                      ["queued", "generating"].includes(d.status),
                  )
                }
              >
                Save role prompt
              </Submit>
              {roleSaved && (
                <p role="status">
                  Role prompt saved. New task and meeting turns will use it.
                </p>
              )}
            </form>
          </details>
        </>
      )}
      {tab === "memory" && (
        <>
          <Select
            label="Project memory"
            value={projectId}
            onChange={setProject}
          >
            <option value="">Choose a project</option>
            {world.projects
              .filter((p) => allowed(agent, p))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          {memories.map((m) => (
            <article className="ow-memory" key={m.id}>
              <span className={`ow-tag ${m.confirmed ? "good" : "warm"}`}>
                {m.confirmed ? "Confirmed" : "Unconfirmed lesson"}
              </span>
              <p>{m.body}</p>
              <div className="ow-actions">
                {!m.confirmed && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate("confirm_memory", { memoryId: m.id }).catch(
                        () => {},
                      )
                    }
                  >
                    Confirm
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate("remove_memory", { memoryId: m.id }).catch(
                      () => {},
                    )
                  }
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
          {!memories.length && (
            <p className="ow-empty">No memory for this project yet.</p>
          )}
          <form
            onSubmit={(e) => {
              const values = formValues(e);
              const form = e.currentTarget;
              void mutate("save_memory", {
                ...values,
                agentId: agent.id,
                projectId,
                confirmed: true,
              })
                .then(() => form.reset())
                .catch(() => {});
            }}
          >
            <Field name="body" label="Add a confirmed lesson" multiline />
            <Submit busy={busy || !projectId}>Save memory</Submit>
          </form>
        </>
      )}
      {tab === "scope" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void mutate("update_scope", {
              agentId: agent.id,
              allProjects: all,
              projectIds: new FormData(e.currentTarget)
                .getAll("projectId")
                .map(String),
            }).catch(() => {});
          }}
        >
          <ScopeFields
            world={world}
            orgId={agent.orgId}
            all={all}
            setAll={setAll}
            selected={agent.projectIds}
          />
          <p className="ow-note">
            Removing project access pauses affected active work. Project-derived
            memory remains outside that agent's context.
          </p>
          <Submit busy={busy}>Save project access</Submit>
        </form>
      )}
      {tab === "progress" && (
        <>
          <h4>Token usage</h4>
          <div className="ow-two ow-metrics">
            <div>
              <strong>
                {stats?.usageSamples ? formatTokens(stats.inputTokens) : "—"}
              </strong>
              <small>Input, including reported cache</small>
            </div>
            <div>
              <strong>
                {stats?.usageSamples ? formatTokens(stats.outputTokens) : "—"}
              </strong>
              <small>Output</small>
            </div>
          </div>
          <p className="ow-note">
            {stats?.unavailableUsage
              ? `${stats.unavailableUsage} responses have incomplete usage reporting. Totals include reported tokens only.`
              : stats?.usageSamples
                ? "Measured provider reports. Token usage does not award XP."
                : "No provider usage has been reported yet."}
          </p>
          <h4>Experience</h4>
          <p className="ow-note">
            100 XP for contributing to a founder-verified task. Level N starts
            at 100 × (N − 1)² XP.
          </p>
          {world.xp
            .filter((x) => x.agentId === agent.id)
            .map((x) => (
              <p key={x.id}>
                <strong>+{x.points} XP</strong> ·{" "}
                {world.tasks.find((t) => t.id === x.taskId)?.title}
                <small className="ow-muted">{x.reason}</small>
              </p>
            ))}
        </>
      )}
    </>
  );
}


export function MeetingInspector({
  meeting,
  world,
  mutate,
  busy,
  convert,
}: {
  meeting: Meeting;
  world: World;
  mutate: Mutate;
  busy: boolean;
  convert: () => void;
}) {
  const [body, setBody] = useState("");
  return (
    <>
      <span className="ow-tag">DISCUSSION ONLY</span>
      <h3>{meeting.title}</h3>
      <div className="ow-participants">
        {meeting.participantIds.map((id) => {
          const a = world.agents.find((a) => a.id === id);
          return a ? (
            <div key={id}>
              <Avatar agent={a} />
              <strong>{a.name}</strong>
              <small>
                {world.professions.find((p) => p.id === a.professionId)?.name}
              </small>
            </div>
          ) : null;
        })}
      </div>
      <p className="ow-note">
        Participants respond in order with their own professional context. No
        project actions run in this room.
      </p>
      <Transcript messages={meeting.messages} world={world} />
      {["queued", "discussing"].includes(meeting.status) && (
        <p className="ow-live">
          {meeting.status === "queued"
            ? "Waiting for the next available participant…"
            : `${world.agents.find((a) => a.id === meeting.participantIds[meeting.cursor])?.name ?? "Agent"} is considering the discussion…`}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void mutate("meeting_message", { meetingId: meeting.id, body })
            .then(() => setBody(""))
            .catch(() => {});
        }}
      >
        <label className="ow-field">
          <span>Join the discussion</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            maxLength={8000}
            rows={3}
            placeholder="Ask the group, add a constraint, or change the topic…"
          />
        </label>
        <div className="ow-actions">
          <Submit busy={busy}>Discuss</Submit>
          <button
            type="button"
            disabled={busy || meeting.status === "paused"}
            onClick={() =>
              void mutate("pause_meeting", { meetingId: meeting.id }).catch(
                () => {},
              )
            }
          >
            Pause discussion
          </button>
        </div>
      </form>
      <div className="ow-meeting-handoff">
        <p>Ready to turn an outcome into work?</p>
        <button onClick={convert}>Convert to task ↗</button>
        <small>Your explicit action creates a task outside this room.</small>
      </div>
    </>
  );
}
