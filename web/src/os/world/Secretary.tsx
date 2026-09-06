import { useState } from "react";
import type {
  Agent,
  Mutate,
  SecretaryBlueprint,
  SecretaryDraft,
  World,
} from "./types";

function Mode({ exists }: { exists: boolean }) {
  return <span className={`ow-tag ${exists ? "warm" : "good"}`}>{exists ? "UPDATE" : "CREATE"}</span>;
}

function BlueprintView({
  blueprint,
  world,
  orgId,
}: {
  blueprint: SecretaryBlueprint;
  world: World;
  orgId: string;
}) {
  const exists = (collection: { name: string; orgId: string }[], name: string) =>
    collection.some(
      (item) => item.orgId === orgId && item.name.toLowerCase() === name.toLowerCase(),
    );
  return (
    <section className="ow-blueprint" aria-label="Secretary blueprint">
      <div className="ow-blueprint-summary">
        <span className="ow-eyebrow">PROPOSED BLUEPRINT</span>
        <h3>{blueprint.summary}</h3>
        <p>Nothing changes until you confirm this blueprint.</p>
      </div>
      {!!blueprint.questions.length && (
        <div className="ow-blueprint-questions" role="status">
          <strong>Your Secretary needs a decision</strong>
          {blueprint.questions.map((question) => <p key={question}>{question}</p>)}
        </div>
      )}
      {!!blueprint.warnings.length && (
        <div className="ow-blueprint-warnings">
          <strong>Setup checks</strong>
          {blueprint.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}
      <div className="ow-blueprint-grid">
        {blueprint.projects.map((project) => (
          <article key={`project:${project.name}`}>
            <header><Mode exists={exists(world.projects, project.name)} /><small>PROJECT</small></header>
            <strong>{project.name}</strong>
            <p>{project.context || "No shared context proposed."}</p>
          </article>
        ))}
        {blueprint.professions.map((profession) => (
          <article key={`profession:${profession.name}`}>
            <header><Mode exists={exists(world.professions, profession.name)} /><small>{profession.kind.toUpperCase()}</small></header>
            <strong>{profession.name}</strong>
            <p>{profession.guidance}</p>
          </article>
        ))}
        {blueprint.agents.map((agent) => (
          <article key={`agent:${agent.name}`}>
            <header><Mode exists={exists(world.agents, agent.name)} /><small>{(agent.memberType ?? "worker").toUpperCase()}</small></header>
            <strong>{agent.name}</strong>
            <p>{agent.profession} · {agent.provider ?? "current/default"}/{agent.model ?? "current/default"}</p>
            <small>{agent.allProjects ? "All projects in this org" : agent.projects?.join(", ") || "Project access unchanged or not yet assigned"}</small>
          </article>
        ))}
        {blueprint.workflows.map((workflow) => (
          <article key={`workflow:${workflow.name}`}>
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
}: {
  world: World;
  orgId: string;
  secretary: Agent;
  mutate: Mutate;
  busy: boolean;
}) {
  const drafts = (world.secretaryDrafts ?? []).filter((draft) => draft.orgId === orgId);
  const [draftId, setDraftId] = useState(drafts.at(-1)?.id ?? "");
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const draft: SecretaryDraft | undefined = drafts.find((item) => item.id === draftId);
  const running = starting || !!draft && ["queued", "generating"].includes(draft.status);
  const send = () => {
    setStarting(true);
    void mutate("create_secretary_request", { orgId, message })
      .then((result) => {
        setDraftId(result.id);
        setMessage("");
      })
      .catch(() => {})
      .finally(() => setStarting(false));
  };
  return (
    <div className="ow-secretary-desk">
      <section className="ow-secretary-intro">
        <div>
          <span className="ow-eyebrow">RECEPTION · {secretary.provider}/{secretary.model}</span>
          <h3>Tell me how this organization should work.</h3>
          <p>I can prepare projects, professions, agents, access scopes and workflows—and recruit the team. You review the blueprint before anything changes.</p>
        </div>
      </section>
      {!!drafts.length && (
        <label className="ow-field">
          <span>Secretary conversation</span>
          <select value={draftId} onChange={(event) => setDraftId(event.target.value)}>
            <option value="">Start a new request</option>
            {[...drafts].reverse().map((item) => (
              <option key={item.id} value={item.id}>{item.status} · {item.message.slice(0, 80)}</option>
            ))}
          </select>
        </label>
      )}
      <label className="ow-field">
        <span>What would you like to create or change?</span>
        <textarea
          aria-label="What would you like to create or change?"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={5}
          maxLength={12000}
          disabled={running}
          placeholder="Create a product project with a PM, two developers and QA. Large features use PM → Dev → QA; small fixes go straight to Dev. Ask me when a product decision is missing."
        />
      </label>
      <div className="ow-secretary-actions">
        <button type="button" className="ow-primary" disabled={busy || running || !message.trim()} onClick={send}>
          {running ? "Secretary is preparing…" : draft?.blueprint?.questions.length ? "Reply and revise blueprint" : "Prepare blueprint"}
        </button>
        {running && draft && (
          <button type="button" disabled={busy} onClick={() => void mutate("cancel_secretary_request", { draftId: draft.id }).catch(() => {})}>Cancel</button>
        )}
      </div>
      {running && <p className="ow-note" role="status">You may close reception. The saved blueprint will continue preparing.</p>}
      {draft?.error && <p className="ow-blueprint-error" role="alert">{draft.error}</p>}
      {draft?.status === "cancelled" && <p className="ow-note" role="status">Blueprint cancelled. No configuration changed.</p>}
      {draft?.blueprint && <BlueprintView blueprint={draft.blueprint} world={world} orgId={orgId} />}
      {draft?.status === "ready" && draft.blueprint && (
        <div className="ow-secretary-confirm">
          <p>{draft.blueprint.questions.length ? "Reply above so the Secretary can resolve these choices." : "This writes through the same canonical configuration used by manual setup."}</p>
          <button
            type="button"
            className="ow-primary"
            disabled={busy || applying || !!draft.blueprint.questions.length}
            onClick={() => {
              setApplying(true);
              void mutate("apply_secretary_blueprint", { draftId: draft.id })
                .catch(() => {})
                .finally(() => setApplying(false));
            }}
          >{applying ? "Applying…" : "Confirm and apply blueprint"}</button>
        </div>
      )}
      {draft?.status === "applied" && <p className="ow-blueprint-applied" role="status">Blueprint applied to this organization.</p>}
    </div>
  );
}
