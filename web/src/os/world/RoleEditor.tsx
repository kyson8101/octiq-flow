import { useEffect, useRef, useState } from "react";
import type { Mutate, World } from "./types";

export function RoleEditor({
  world,
  orgId,
  professionId,
  targetAgentId,
  value,
  onChange,
  mutate,
  busy,
}: {
  world: World;
  orgId: string;
  professionId: string;
  targetAgentId?: string;
  value: string;
  onChange: (value: string) => void;
  mutate: Mutate;
  busy: boolean;
}) {
  const drafts = (world.recruitmentDrafts ?? []).filter(
    (d) =>
      d.orgId === orgId &&
      d.professionId === professionId &&
      (d.targetAgentId ?? undefined) === targetAgentId,
  );
  const pending = drafts.find((d) =>
    ["queued", "generating"].includes(d.status),
  );
  const [draftId, setDraftId] = useState(pending?.id ?? "");
  const [brief, setBrief] = useState(pending?.brief ?? "");
  const [provider, setProvider] = useState("codex");
  const [model, setModel] = useState("default");
  const [starting, setStarting] = useState(false);
  const applied = useRef("");
  const draft = drafts.find((d) => d.id === draftId);
  const running =
    starting || (!!draft && ["queued", "generating"].includes(draft.status));
  useEffect(() => {
    if (draft?.status === "ready" && applied.current !== draft.id) {
      applied.current = draft.id;
      onChange(draft.prompt);
    }
  }, [draft?.id, draft?.status, draft?.prompt, onChange]);
  return (
    <section className="ow-role-editor">
      <h4>Recruiter</h4>
      <p className="ow-note">
        Describe the role in your own words. Your recruiter turns it into
        focused instructions for this agent. Only this brief and profession
        guidance are shared.
      </p>
      {!!drafts.length && (
        <label className="ow-field">
          <span>Saved recruiter drafts</span>
          <select
            aria-label="Saved recruiter drafts"
            value={draftId}
            onChange={(e) => {
              const selected = drafts.find((d) => d.id === e.target.value);
              setDraftId(e.target.value);
              if (selected) setBrief(selected.brief);
              applied.current = "";
            }}
          >
            <option value="">New role brief</option>
            {[...drafts].reverse().map((d) => (
              <option key={d.id} value={d.id}>
                {d.status} · {d.brief.slice(0, 65)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="ow-field">
        <span>Describe the role</span>
        <textarea
          aria-label="Describe the role"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={8000}
          rows={4}
          disabled={running}
          placeholder="A tester who focuses on mobile flows, edge cases and regression strategy. Ask me when product behavior is unclear."
        />
      </label>
      <div className="ow-two">
        <label className="ow-field">
          <span>Recruiter provider</span>
          <select
            aria-label="Recruiter provider"
            value={provider}
            disabled={running}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(
                e.target.value === "deepseek"
                  ? "deepseek-chat"
                  : ["codex", "claude"].includes(e.target.value)
                    ? "default"
                    : "",
              );
            }}
          >
            <option value="codex">Codex · existing CLI login</option>
            <option value="claude">Claude · existing CLI login</option>
            <option value="claude_api">Claude API</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </label>
        <label className="ow-field">
          <span>Recruiter model</span>
          <input
            aria-label="Recruiter model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            maxLength={100}
            disabled={running}
            placeholder="Model available to your account"
          />
        </label>
      </div>
      <div className="ow-actions">
        <button
          type="button"
          disabled={
            busy || running || !brief.trim() || !model.trim() || !professionId
          }
          onClick={() => {
            setStarting(true);
            void mutate("create_recruitment", {
              orgId,
              professionId,
              targetAgentId,
              brief,
              provider,
              model,
            })
              .then((result) => setDraftId(result.id))
              .catch(() => {})
              .finally(() => setStarting(false));
          }}
        >
          {running ? "Recruiter is polishing…" : "Polish with Recruiter"}
        </button>
        {running && draft && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void mutate("cancel_recruitment", { draftId: draft.id }).catch(
                () => {},
              );
            }}
          >
            Cancel polishing
          </button>
        )}
      </div>
      {running && (
        <p role="status">
          You can close this window; the draft is saved while the recruiter
          works.
        </p>
      )}
      {draft?.error && <p role="alert">{draft.error}</p>}
      {draft?.status === "cancelled" && (
        <p role="status">
          Polishing cancelled. Your existing prompt is unchanged.
        </p>
      )}
      <label className="ow-field">
        <span>Agent role prompt</span>
        <textarea
          name="rolePrompt"
          aria-label="Agent role prompt"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={16000}
          rows={10}
          disabled={running}
          placeholder="Write instructions yourself, or let the recruiter polish your role description above."
        />
      </label>
      <p className="ow-muted">
        You can edit this prompt before saving. It supplements the profession
        guidance; project access stays in Project access settings.
      </p>
    </section>
  );
}
