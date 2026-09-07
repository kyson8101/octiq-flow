// Codex's tool router has already refused this action. Unlike a live Claude
// permission ask, there is no suspended tool call for OctiqFlow to resume.
// These buttons therefore send the user's decision as a fresh, explicit turn.
import { useState } from "react";
import { bridge } from "../lib/bridge";

export type SafetyBlockNotice = {
  id: string;
  chatKey?: string;
  kind: "external-data" | "high-risk-action";
  title: string;
  summary: string;
  detail: string;
};

export const LOCAL_ONLY_REPLY =
  "Continue without sending any local data to an external service. Use only local tools and local reasoning for this task.";
export const SAFER_APPROACH_REPLY =
  "Continue with a materially safer alternative. Do not retry, work around, or bypass the blocked action.";

export function saferReply(block: SafetyBlockNotice): string {
  return block.kind === "external-data" ? LOCAL_ONLY_REPLY : SAFER_APPROACH_REPLY;
}

export function allowOnceReply(block: SafetyBlockNotice): string {
  const boundary = block.kind === "external-data"
    ? "with the same content and destination only"
    : "with the same files, scope, and intended effect only";
  return (
    "I explicitly authorize one retry of the exact action that was just blocked. " +
    `The blocked action was described as: ${block.summary} ` +
    `This authorization applies to that single retry, ${boundary}. ` +
    "Do not broaden it, and ask again before any later high-risk action."
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
    await onContinue(choice === "local" ? saferReply(block) : allowOnceReply(block));
  };

  const external = block.kind === "external-data";

  return (
    <div className="ask-card safety-card" role="alert" aria-label={block.title}>
      <div className="safety-card-context">
        <span>Codex safety review</span>
        <span className="safety-card-ok">OctiqFlow is okay</span>
      </div>
      <div className="ask-card-head">
        <span className="safety-card-icon" aria-hidden="true">
          !
        </span>
        <span className="ask-card-title">
          <strong>{block.title}</strong>
        </span>
      </div>

      <div className="safety-card-label">Why it was blocked</div>
      <p className="safety-card-summary">{block.summary}</p>
      <p className="safety-card-status">
        {external
          ? "OctiqFlow is still running. The command did not run, and no data was sent."
          : "OctiqFlow is still running. The blocked action made no changes."}
      </p>

      {open && (
        <div className="ask-card-detail safety-card-detail">
          <div className="ask-card-label">Technical details</div>
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
          {sending === "local" ? "Continuing…" : external ? "Keep it local" : "Use safer approach"}
        </button>
        <button
          className="ask-btn"
          type="button"
          disabled={!!sending}
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "Hide technical details" : "Technical details"}
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
        Approve once applies only to this exact action. The rejected action cannot resume by itself.
      </p>
    </div>
  );
}
