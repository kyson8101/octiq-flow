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

/**
 * Codex's safety reviewer reads the conversation when it evaluates a later
 * call. A plain "always allow" is too broad to be useful there, so keep the
 * grant attached to the action class and destination the reviewer described,
 * and persist it only for the project where the person made the choice.
 */
export function allowForProjectReply(block: SafetyBlockNotice): string {
  const boundary = block.kind === "external-data"
    ? "the same kind of data, purpose, and external destination"
    : "the same kind of action, files or resources, scope, and intended effect";
  return (
    "I explicitly authorize one retry of the exact action that was just blocked, " +
    "and future actions matching it in this OctiqFlow project, including new chats and sessions. " +
    `The blocked action was described as: ${block.summary} ` +
    `This continuing authorization is limited to ${boundary}. ` +
    "It does not authorize a different destination, broader scope, or materially different action. " +
    "Do not ask again for a matching action. Ask again only if any of those boundaries change."
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
  const [sending, setSending] = useState<"local" | "allow" | "always" | null>(null);
  const [error, setError] = useState("");

  const choose = async (choice: "local" | "allow" | "always") => {
    setSending(choice);
    setError("");
    try {
      // The rejected command is already dead. A one-time choice removes its
      // card; the project choice first saves the exact boundary for future
      // Codex processes, then removes the card atomically on the backend.
      if (choice === "always") {
        await bridge.invoke("safety_block_authorize_project", { id: block.id });
      } else {
        await bridge.invoke("safety_block_dismiss", { id: block.id });
      }
      onAnswered(block.id);
      const message = choice === "local"
        ? saferReply(block)
        : choice === "always"
          ? allowForProjectReply(block)
          : allowOnceReply(block);
      await onContinue(message);
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
      setSending(null);
    }
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
          title="Remember this exact authorization for future chats and sessions in this project"
          onClick={() => void choose("always")}
        >
          {sending === "always" ? "Saving…" : "Always allow in this project"}
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

      {error && <p className="ask-card-note safety-card-error">Could not save authorization: {error}</p>}

      <p className="ask-card-note">
        “Always allow in this project” also applies to new chats and sessions in this project, only
        within the same stated boundaries. The rejected action cannot resume by itself, so either
        approval starts a new turn.
      </p>
    </div>
  );
}
