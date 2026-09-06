// Codex's tool router has already refused this action. Unlike a live Claude
// permission ask, there is no suspended tool call for OctiqFlow to resume.
// These buttons therefore send the user's decision as a fresh, explicit turn.
import { useState } from "react";
import { bridge } from "../lib/bridge";

export type SafetyBlockNotice = {
  id: string;
  chatKey?: string;
  kind: "external-data";
  title: string;
  summary: string;
  detail: string;
};

export const LOCAL_ONLY_REPLY =
  "Continue without sending any local data to an external service. Use only local tools and local reasoning for this task.";

export function allowOnceReply(block: SafetyBlockNotice): string {
  return (
    "I explicitly authorize one retry of the exact external-data action that was just blocked. " +
    `The blocked action was described as: ${block.summary} ` +
    "This authorization applies to that single retry, with the same content and destination only. " +
    "Do not broaden it, and ask again before any later external transfer."
  );
}

export function SafetyBlock({
  block,
  onContinue,
  onAnswered,
  startOpen = false,
}: {
  block: SafetyBlockNotice;
  onContinue: (message: string) => Promise<void> | void;
  onAnswered: (id: string) => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [sending, setSending] = useState<"local" | "allow" | null>(null);

  const choose = async (choice: "local" | "allow") => {
    setSending(choice);
    // Remove the choice first, across every open browser. The original command
    // is already dead; the message below is the new instruction, not an answer
    // travelling back into a suspended call.
    await bridge.invoke("safety_block_dismiss", { id: block.id }).catch(() => undefined);
    onAnswered(block.id);
    await onContinue(choice === "local" ? LOCAL_ONLY_REPLY : allowOnceReply(block));
  };

  return (
    <div className="ask-card safety-card" role="alert" aria-label="External data sharing blocked">
      <div className="ask-card-head">
        <span className="ask-card-dot" aria-hidden="true" />
        <span className="safety-card-icon" aria-hidden="true">
          !
        </span>
        <span className="ask-card-title">
          <strong>{block.title}</strong>
        </span>
      </div>

      <p className="safety-card-summary">{block.summary}</p>
      <p className="safety-card-status">The command did not run. No data was sent.</p>

      {open && (
        <div className="ask-card-detail safety-card-detail">
          <div className="ask-card-label">Safety review details</div>
          <pre className="ask-card-body">{block.detail}</pre>
        </div>
      )}

      <div className="ask-card-buttons safety-card-buttons">
        <button
          className="ask-btn is-primary"
          type="button"
          disabled={!!sending}
          onClick={() => void choose("local")}
        >
          {sending === "local" ? "Continuing…" : "Keep it local"}
        </button>
        <button
          className="ask-btn"
          type="button"
          disabled={!!sending}
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "Hide details" : "View details"}
        </button>
        <button
          className="ask-btn safety-allow"
          type="button"
          disabled={!!sending}
          onClick={() => void choose("allow")}
        >
          {sending === "allow" ? "Authorizing…" : "Allow once"}
        </button>
      </div>

      <p className="ask-card-note">
        Your choice is sent to Codex as a new message; the rejected command cannot be resumed.
      </p>
    </div>
  );
}
