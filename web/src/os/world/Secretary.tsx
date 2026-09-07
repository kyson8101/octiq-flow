import { useEffect, useRef, useState } from "react";
import { suggestedWorkspacePath } from "./workspaceAccess";
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
            {project.workspacePath && <p className="ow-workspace-path">Workspace: {project.workspacePath}<br /><small>Workers with project access can use this folder after confirmation.</small></p>}
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
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderError, setFolderError] = useState("");
  const [accessPending, setAccessPending] = useState(false);
  const folders = (world.secretaryWorkspaces ?? []).filter((folder) => folder.orgId === orgId);
  const suggestedFolder = suggestedWorkspacePath(message || latest?.message || "");
  const nextFolder = folderPath ?? (folders.some((f) => f.path === suggestedFolder) ? "" : suggestedFolder);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const sending = useRef(false);
  const pendingSaved = !!pending?.id && drafts.some((draft) => draft.id === pending.id);
  const pendingVisible = !!pending && !pendingSaved;
  const running = starting || pendingVisible || !!active;
  const questions = latest?.blueprint?.questions ?? [];
  const canApply = !!preview && preview.id === latest?.id && latest.status === "ready"
    && !questions.length && !running && !busy && !applying && !accessPending;

  useEffect(() => {
    if (pendingSaved) setPending(null);
  }, [pendingSaved]);

  useEffect(() => {
    if (follow.current && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [drafts.length, latest?.status, latest?.blueprint, latest?.fileActivity?.length, pendingVisible, panel]);

  const send = () => {
    if (sending.current || busy || running || applying || accessPending || !message.trim()) return;
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

  const changeAccess = async (action: "authorize_secretary_workspace" | "revoke_secretary_workspace", args: Record<string, unknown>) => {
    if (accessPending || busy || applying) return;
    setAccessPending(true);
    setFolderError("");
    try {
      await mutate(action, { orgId, ...args });
      if (action === "authorize_secretary_workspace") setFolderPath("");
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error));
    } finally { setAccessPending(false); }
  };

  const status = running ? "Updating…" : latest?.status === "stale" ? "Access changed" : latest?.status === "failed" ? "Reply failed"
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
            <p>To understand local work, allow read-only folder access below. I can then inspect AGENTS.md and relevant workflow files without changing them.</p>
          </article>
          {drafts.map((draft) => (
            <div className="ow-secretary-turn" key={draft.id}>
              <article className="ow-secretary-message ow-secretary-message-user">
                <span className="ow-eyebrow">YOU</span>
                <p>{draft.message}</p>
              </article>
              {!!draft.fileActivity?.length && <details className="ow-secretary-file-activity">
                <summary>File inspection · {draft.fileActivity.length}</summary>
                <ul>{draft.fileActivity.map((file, index) => <li key={index}>
                  <span>{file.error ? "Blocked" : file.action === "read_file" ? "Read" : "Listed"}: {file.workspacePath}/{file.path}</span>
                  {file.error && <small>{file.error}</small>}
                </li>)}</ul>
              </details>}
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
        <form className="ow-secretary-composer ow-secretary-composer-with-access" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <details className="ow-secretary-folder-access">
            <summary>Folder access · {folders.length ? `${folders.length} read-only` : "not connected"}</summary>
            <p>Allow this org's Secretary to read a specific folder on the server. File contents are sent to its configured model. This does not create a project or allow writes. Removing access stops the current inspection; previous conversation remains.</p>
            {folders.map((folder) => <div className="ow-secretary-folder" key={folder.id}>
              <span className="ow-workspace-path">{folder.path}</span>
              <button type="button" aria-label={`Remove access to ${folder.path}`} disabled={busy || accessPending || applying} onClick={() => void changeAccess("revoke_secretary_workspace", { workspaceId: folder.id })}>Remove access</button>
            </div>)}
            <label className="ow-field"><span>Folder on the server</span>
              <input value={nextFolder} onChange={(event) => setFolderPath(event.target.value)} placeholder="/Users/you/projects/my-project" list={`secretary-folders-${orgId}`} disabled={accessPending}
                onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
              <datalist id={`secretary-folders-${orgId}`}>{world.projects.filter((p) => p.orgId === orgId && p.workspacePath).map((p) => <option key={p.id} value={p.workspacePath}>{p.name}</option>)}</datalist>
            </label>
            <button type="button" disabled={busy || accessPending || applying || running || !nextFolder.trim()} onClick={() => void changeAccess("authorize_secretary_workspace", { path: nextFolder.trim() })}>Allow read-only access</button>
            {folderError && <p role="alert" className="ow-blueprint-error">{folderError}</p>}
            {!!folders.length && <p className="ow-muted">Access saved. Send a message to inspect these folders and update your blueprint.</p>}
          </details>
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
              : <button type="submit" className="ow-primary" disabled={busy || running || applying || accessPending || !message.trim()}>Send</button>}
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
            : latest?.status === "failed" || latest?.status === "cancelled" || latest?.status === "stale" ? "Send another message to continue working on the plan."
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
