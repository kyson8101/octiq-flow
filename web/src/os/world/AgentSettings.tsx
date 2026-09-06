import { useState } from "react";
import { Field, Select, Submit, formValues } from "./Forms";
import type { Agent, Mutate, World } from "./types";

export function AgentSettings({
  agent,
  world,
  mutate,
  busy,
}: {
  agent: Agent;
  world: World;
  mutate: Mutate;
  busy: boolean;
}) {
  const [provider, setProvider] = useState(agent.provider);
  const [professionId, setProfession] = useState(agent.professionId);
  const [kind, setKind] = useState(agent.kind);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const waiting =
    world.runs.some(
      (r) =>
        r.agentId === agent.id &&
        (r.status === "running" ||
          (r.status === "interrupted" && r.finishedAt === null)),
    ) ||
    (world.roleRequests ?? []).some(
      (r) =>
        (r.agentId === agent.id || r.authorId === agent.id) &&
        ["queued", "generating"].includes(r.status),
    ) ||
    (world.recruitmentDrafts ?? []).some(
      (d) =>
        (d.targetAgentId === agent.id || d.recruiterId === agent.id) &&
        ["queued", "generating"].includes(d.status),
    ) ||
    (world.secretaryDrafts ?? []).some(
      (d) =>
        d.secretaryId === agent.id &&
        ["queued", "generating"].includes(d.status),
    ) ||
    agent.avatarGeneration?.status === "generating";
  return (
    <details className="ow-agent-settings">
      <summary>Advanced settings</summary>
      <p className="ow-note">
        Defaults are already set. Adjust these only when you need to.
      </p>
      <form
        onChange={() => setSaved(false)}
        onSubmit={(e) => {
          const values = formValues(e);
          if (sending || waiting) return;
          setSending(true);
          setError("");
          void mutate("update_agent_settings", {
            ...values,
            agentId: agent.id,
            provider,
            professionId,
            kind,
          })
            .then(() => setSaved(true))
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setSending(false));
        }}
      >
        <Field
          name="name"
          label="Agent name"
          value={agent.name}
          maxLength={80}
        />
        <div className="ow-two">
          <Select label="Provider" value={provider} onChange={setProvider}>
            <option value="codex">Codex · existing CLI login</option>
            <option value="claude">Claude · existing CLI login</option>
            <option value="claude_api">Claude API</option>
            <option value="deepseek">DeepSeek</option>
          </Select>
          <Field
            key={provider}
            name="model"
            label="Model ID"
            maxLength={100}
            value={
              provider === agent.provider
                ? agent.model
                : ["codex", "claude"].includes(provider)
                  ? "default"
                  : ""
            }
            placeholder="A model available to your account"
          />
        </div>
        <div className="ow-two">
          <Select
            label="Workflow profession"
            value={professionId}
            onChange={(id) => {
              setProfession(id);
              if (
                ["secretary", "recruiter"].includes(
                  world.professions.find((p) => p.id === id)?.kind ?? "",
                )
              )
                setKind("consultant");
            }}
          >
            {world.professions
              .filter(
                (p) =>
                  p.orgId === agent.orgId &&
                  (!["secretary", "recruiter"].includes(p.kind) ||
                    p.id === agent.professionId),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          <Select label="Member type" value={kind} onChange={setKind}>
            {!["secretary", "recruiter"].includes(
              world.professions.find((p) => p.id === professionId)?.kind ?? "",
            ) && <option value="worker">Worker</option>}
            <option value="consultant">Consultant</option>
          </Select>
        </div>
        <p className="ow-note">
          Profession helps the PM assign workflow steps. Shape individual
          responsibilities in Talk about role.
        </p>
        <Field
          name="appearance"
          label="Avatar preference"
          multiline
          required={false}
          maxLength={1000}
          value={agent.appearance}
          placeholder="A cheerful fox with round glasses and a green hoodie"
        />
        <p className="ow-note">
          Save a preference, then generate an avatar from the profile whenever
          you like.
        </p>
        {waiting && (
          <p role="status">
            Settings can be saved when the current response or avatar finishes.
          </p>
        )}
        <Submit busy={busy || sending || waiting}>Save settings</Submit>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">Settings saved.</p>}
      </form>
    </details>
  );
}
