import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  Mutate,
  SecretaryBlueprint,
  World,
} from "./types";

function Mode({ exists }: { exists: boolean }) {
  return <span className={`ow-tag ${exists ? "warm" : "good"}`}>{exists ? "UPDATE" : "CREATE"}</span>;
}

function BlueprintView({
  blueprint,
  world,
  orgId,
  previous,
}: {
  blueprint: SecretaryBlueprint;
  world: World;
  orgId: string;
  previous?: SecretaryBlueprint | null;
}) {
  const exists = (collection: { name: string; orgId: string }[], name: string) =>
    collection.some(
      (item) => item.orgId === orgId && item.name.toLowerCase() === name.toLowerCase(),
    );
  const changed = (kind: "projects" | "professions" | "agents" | "workflows", item: { name: string }) =>
    previous && JSON.stringify(previous[kind].find((old) => old.name === item.name)) !== JSON.stringify(item)
      ? "ow-blueprint-changed" : undefined;
  return (
    <section className="ow-blueprint" aria-label="Secretary blueprint">
      <div className="ow-blueprint-summary">
        <span className="ow-eyebrow">PROPOSED BLUEPRINT</span>
        <h3>{blueprint.summary}</h3>
        <p>Nothing changes until you confirm this blueprint.</p>
      </div>
      {!!blueprint.warnings.length && (
        <div className="ow-blueprint-warnings">
          <strong>Setup checks</strong>
          {blueprint.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}
      <div className="ow-blueprint-grid">
        {blueprint.projects.map((project) => (
          <article key={`project:${project.name}`} className={changed("projects", project)}>
            <header><Mode exists={exists(world.projects, project.name)} /><small>PROJECT</small></header>
            <strong>{project.name}</strong>
            <p>{project.context || "No shared context proposed."}</p>
          </article>
        ))}
        {blueprint.professions.map((profession) => (
          <article key={`profession:${profession.name}`} className={changed("professions", profession)}>
            <header><Mode exists={exists(world.professions, profession.name)} /><small>{profession.kind.toUpperCase()}</small></header>
            <strong>{profession.name}</strong>
            <p>{profession.guidance}</p>
          </article>
        ))}
        {blueprint.agents.map((agent) => (
          <article key={`agent:${agent.name}`} className={changed("agents", agent)}>
            <header><Mode exists={exists(world.agents, agent.name)} /><small>{(agent.memberType ?? "worker").toUpperCase()}</small></header>
            <strong>{agent.name}</strong>
            <p>{agent.profession} · {agent.provider ?? "current/default"}/{agent.model ?? "current/default"}</p>
            <small>{agent.allProjects ? "All projects in this org" : agent.projects?.join(", ") || "Project access unchanged or not yet assigned"}</small>
          </article>
        ))}
        {blueprint.workflows.map((workflow) => (
          <article key={`workflow:${workflow.name}`} className={changed("workflows", workflow)}>
            <header><Mode exists={exists(world.workflows, workflow.name)} /><small>WORKFLOW</small></header>
            <strong>{workflow.name}</strong>
            <p>{workflow.professions.join(" → ")}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function SecretaryDesk({
  world,
  orgId,
  secretary,
  mutate,
  busy,
  error,
}: {
  world: World;
  orgId: string;
  secretary: Agent;
  mutate: Mutate;
  busy: boolean;
  error?: string;
}) {
  // The backend already treats the org's drafts as ordered conversation turns.
  const drafts = (world.secretaryDrafts ?? []).filter((draft) => draft.orgId === orgId);
  const latest = drafts.at(-1);
  const active = drafts.find((draft) => ["queued", "generating"].includes(draft.status));
  const previews = drafts.filter((draft) => draft.blueprint);
  const preview = previews.at(-1);
  const previous = previews.at(-2);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<{ message: string; id?: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [panel, setPanel] = useState<"conversation" | "blueprint">("conversation");
  const [errorPanel, setErrorPanel] = useState<"conversation" | "blueprint">("conversation");
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const sending = useRef(false);
  const pendingSaved = !!pending?.id && drafts.some((draft) => draft.id === pending.id);
  const pendingVisible = !!pending && !pendingSaved;
  const running = starting || pendingVisible || !!active;
  const questions = latest?.blueprint?.questions ?? [];
  const canApply = !!preview && preview.id === latest?.id && latest.status === "ready"
    && !questions.length && !running && !busy && !applying;

  useEffect(() => {
    if (pendingSaved) setPending(null);
  }, [pendingSaved]);

  useEffect(() => {
    if (follow.current && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [drafts.length, latest?.status, latest?.blueprint, pendingVisible, panel]);

  const send = () => {
    if (sending.current || busy || running || applying || !message.trim()) return;
    const submitted = message.trim();
    sending.current = true;
    follow.current = true;
    setErrorPanel("conversation");
    setStarting(true);
    setPending({ message: submitted });
    void mutate("create_secretary_request", { orgId, message: submitted })
      .then((result) => {
        setPending({ message: submitted, id: result.id });
        setMessage("");
      })
      .catch(() => setPending(null))
      .finally(() => {
        sending.current = false;
        setStarting(false);
        composer.current?.focus();
      });
  };

  const status = running ? "Updating…" : latest?.status === "failed" ? "Reply failed"
    : latest?.status === "cancelled" ? "Stopped" : preview?.status === "applied" ? "Applied"
    : questions.length ? "Awaiting your reply" : preview ? "Ready to review" : "Draft";

  return (
    <div className="ow-secretary-desk" data-panel={panel}>
      <nav className="ow-secretary-panel-switch" aria-label="Secretary panels">
        <button type="button" aria-pressed={panel === "conversation"} onClick={() => setPanel("conversation")}>Conversation</button>
        <button type="button" aria-pressed={panel === "blueprint"} onClick={() => setPanel("blueprint")}>Blueprint{preview ? ` · v${previews.length}` : ""}</button>
      </nav>
      <section className="ow-secretary-conversation" aria-label="Secretary conversation">
        <header className="ow-secretary-pane-header">
          <div><span className="ow-eyebrow">RECEPTION</span><h3>Conversation</h3></div>
          <span className="ow-muted">{secretary.provider}/{secretary.model}</span>
        </header>
        <div
          className="ow-secretary-transcript"
          role="log"
          aria-label="Conversation messages"
          aria-live="polite"
          ref={transcript}
          onScroll={(event) => {
            const el = event.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <article className="ow-secretary-message">
            <span className="ow-eyebrow">{secretary.name}</span>
            <p>Tell me how this organization should work.</p>
            <p>I can help set up projects, roles, agents and workflows. Reply here whenever I ask a question; your blueprint updates alongside our conversation.</p>
          </article>
          {drafts.map((draft) => (
            <div className="ow-secretary-turn" key={draft.id}>
              <article className="ow-secretary-message ow-secretary-message-user">
                <span className="ow-eyebrow">YOU</span>
                <p>{draft.message}</p>
              </article>
              {(draft.blueprint || draft.error || ["cancelled", "failed"].includes(draft.status)) && (
                <article className="ow-secretary-message">
                  <span className="ow-eyebrow">{secretary.name}</span>
                  {draft.blueprint && <>
                    <p>{draft.blueprint.summary}</p>
                    {draft.blueprint.questions.map((question, index) => <p className="ow-secretary-question" key={index}>{question}</p>)}
                    {!draft.blueprint.questions.length && draft.status === "ready" && <p className="ow-muted">The blueprint is ready to review. Tell me what to change, or confirm it when you're happy.</p>}
                  </>}
                  {(draft.error || draft.status === "failed") && <p className="ow-blueprint-error">{draft.error || "I couldn't prepare this reply. Please send your message again."}</p>}
                  {draft.status === "cancelled" && <p>Stopped. You can send another message to continue.</p>}
                  {draft.status === "applied" && <p className="ow-blueprint-applied">Blueprint applied to this organization.</p>}
                </article>
              )}
            </div>
          ))}
          {pendingVisible && <article className="ow-secretary-message ow-secretary-message-user"><span className="ow-eyebrow">YOU</span><p>{pending!.message}</p></article>}
          {running && <article className="ow-secretary-message ow-secretary-thinking" role="status"><span className="ow-eyebrow">{secretary.name}</span><p>Thinking through your request…</p></article>}
        </div>
        <form className="ow-secretary-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          {error && errorPanel === "conversation" && <p className="ow-blueprint-error" role="alert">{error}</p>}
          <label className="ow-field">
            <span>Message your Secretary</span>
            <textarea
              ref={composer}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={3}
              maxLength={12000}
              disabled={starting}
              placeholder={questions.length ? "Reply to your Secretary…" : "Describe what you need, or ask for a change…"}
            />
          </label>
          <div className="ow-secretary-actions">
            <span className="ow-muted">{running ? "You can close this window and come back later." : "Enter to send · Shift+Enter for a new line"}</span>
            {active
              ? <button type="button" disabled={busy || applying} onClick={() => {
                  setErrorPanel("conversation");
                  void mutate("cancel_secretary_request", { draftId: active.id }).catch(() => {});
                }}>Stop</button>
              : <button type="submit" className="ow-primary" disabled={busy || running || applying || !message.trim()}>Send</button>}
          </div>
        </form>
      </section>
      <section className="ow-secretary-plan" aria-label="Blueprint preview">
        <header className="ow-secretary-pane-header">
          <div><span className="ow-eyebrow">LIVE PREVIEW{preview ? ` · v${previews.length}` : ""}</span><h3>Blueprint</h3></div>
          <span className="ow-tag" role="status">{status}</span>
        </header>
        <div className="ow-secretary-plan-scroll" aria-busy={running}>
          {preview?.blueprint
            ? <>
                {running && <p className="ow-muted">Showing the last blueprint while your Secretary updates it.</p>}
                {!running && previous && <p className="ow-muted">Highlighted cards changed in this version.</p>}
                <BlueprintView key={preview.id} blueprint={preview.blueprint} previous={previous?.blueprint} world={world} orgId={orgId} />
              </>
            : <div className="ow-secretary-empty"><span className="ow-eyebrow">YOUR PLAN TAKES SHAPE HERE</span><h3>Start with a conversation.</h3><p>Projects, roles, your team and workflows will appear here as we work out the details.</p><p>Nothing changes until you confirm.</p></div>}
        </div>
        <div className="ow-secretary-confirm">
          {error && errorPanel === "blueprint" && <p className="ow-blueprint-error" role="alert">{error}</p>}
          <p>{running ? "Your Secretary is updating the plan."
            : latest?.status === "failed" || latest?.status === "cancelled" ? "Send another message to continue working on the plan."
            : preview?.status === "applied" ? "Applied. Keep chatting to plan further changes."
            : questions.length ? "Your Secretary has a question. Reply in the conversation."
            : preview ? "Review the plan, then apply it to your organization." : "Chat with your Secretary to prepare a blueprint."}</p>
          {!!questions.length && !running && <button type="button" className="ow-secretary-reply-link" onClick={() => {
            follow.current = true;
            setPanel("conversation");
            requestAnimationFrame(() => {
              if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
              composer.current?.focus();
            });
          }}>Reply in conversation</button>}
          <button
            type="button"
            className="ow-primary"
            disabled={!canApply}
            onClick={() => {
              if (!canApply || !preview) return;
              setErrorPanel("blueprint");
              setApplying(true);
              void mutate("apply_secretary_blueprint", { draftId: preview.id })
                .catch(() => {})
                .finally(() => setApplying(false));
            }}
          >{applying ? "Applying…" : "Confirm and apply blueprint"}</button>
        </div>
      </section>
    </div>
  );
}
