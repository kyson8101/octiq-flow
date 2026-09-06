import { useState } from "react";
import type { Agent, Mutate, World } from "./types";

export function RoleChat({
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
  const requests = (world.roleRequests ?? []).filter(
    (r) => r.agentId === agent.id,
  );
  const pending = requests.find((r) =>
    ["queued", "generating"].includes(r.status),
  );
  const [body, setBody] = useState("");
  const [authorId, setAuthorId] = useState(pending?.authorId ?? agent.id);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const helpers = world.agents.filter(
    (a) =>
      a.orgId === agent.orgId &&
      (a.id === agent.id ||
        world.professions.some(
          (p) =>
            p.id === a.professionId &&
            ["pm", "secretary", "recruiter"].includes(p.kind),
        )),
  );
  const disabled = busy || sending || !!pending;
  const send = (mode: "discuss" | "update") => {
    if (disabled || !body.trim()) return;
    setSending(true);
    setError("");
    void mutate("role_message", { agentId: agent.id, authorId, body, mode })
      .then(() => setBody(""))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false));
  };
  return (
    <section className="ow-role-chat" aria-label="Role conversation">
      <h4>Shape this role together</h4>
      <p className="ow-note">
        Start with your own words. Discuss first, or ask for an update that
        saves this agent's description and prompt automatically. Each update
        applies only to that message; project access stays separate.
      </p>
      <div className="ow-role-current">
        <strong>Current role</strong>
        <p>
          {agent.roleDescription ||
            (agent.rolePrompt
              ? "Custom instructions are set."
              : "Not defined yet. Tell your agent what you want it to do.")}
        </p>
        {agent.rolePrompt && (
          <details>
            <summary>View saved prompt</summary>
            <p className="ow-prose">{agent.rolePrompt}</p>
          </details>
        )}
      </div>
      <div
        className="ow-transcript"
        role="log"
        aria-label="Role conversation history"
        aria-live="polite"
      >
        {requests.slice(-20).map((r) => (
          <div key={r.id}>
            <article className="founder">
              <header>
                <strong>You</strong>
                <small>
                  {r.mode === "update"
                    ? "Requested role update"
                    : "Discussion only"}
                </small>
              </header>
              <p>{r.body}</p>
            </article>
            <article>
              <header>
                <strong>
                  {world.agents.find((a) => a.id === r.authorId)?.name ??
                    "Agent"}
                </strong>
                <small>
                  {r.status === "applied" ? "Role updated" : r.status}
                </small>
              </header>
              {r.reply && <p>{r.reply}</p>}
              {r.error && <p role="alert">{r.error}</p>}
              {r.status === "cancelled" && (
                <p>Cancelled. This request did not change the role.</p>
              )}
              {r.status === "applied" && (
                <details>
                  <summary>Saved role from this request</summary>
                  <p>{r.description}</p>
                  <p className="ow-prose">{r.prompt}</p>
                </details>
              )}
            </article>
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send("discuss");
        }}
      >
        <label className="ow-field">
          <span>Talk with</span>
          <select
            aria-label="Role helper"
            value={authorId}
            disabled={disabled}
            onChange={(e) => setAuthorId(e.target.value)}
          >
            {helpers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.id === agent.id
                  ? " · this agent"
                  : ` · ${world.professions.find((p) => p.id === a.professionId)?.name}`}
              </option>
            ))}
          </select>
        </label>
        <label className="ow-field">
          <span>Your role instructions or question</span>
          <textarea
            aria-label="Role message"
            rows={4}
            maxLength={8000}
            value={body}
            disabled={disabled}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Focus on mobile testing. Suggest edge cases and ask me when expected behavior is unclear."
          />
        </label>
        <div className="ow-actions">
          <button type="submit" disabled={disabled || !body.trim()}>
            Discuss only
          </button>
          <button
            type="button"
            className="ow-primary"
            disabled={disabled || !body.trim()}
            onClick={() => send("update")}
          >
            Update role from this message
          </button>
        </div>
        {pending && (
          <>
            <p role="status">
              {pending.status === "queued"
                ? "Waiting for the role helper to be available."
                : "Preparing a response. You can close this panel."}
            </p>
            <button
              type="button"
              disabled={busy || sending}
              onClick={() => {
                setSending(true);
                setError("");
                void mutate("cancel_role_message", {
                  roleRequestId: pending.id,
                })
                  .catch((e) => setError(String(e)))
                  .finally(() => setSending(false));
              }}
            >
              Cancel role response
            </button>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
