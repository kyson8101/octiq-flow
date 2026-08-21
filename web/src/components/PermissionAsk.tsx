// The agent is waiting on you.
//
// `claude -p` cannot prompt, so a permission it was not granted in advance is
// simply denied. A PreToolUse hook on the server holds the tool call open and
// asks here instead — which is why this is the one thing in the app that is
// worth interrupting for. Until it is answered, nothing else in that chat moves.
//
// It shows what the terminal's y/n cannot: the tool, the file, and the content
// it is about to write. The answer you would give depends on those, and having
// to guess is how people end up granting everything.
import { useState } from "react";
import { bridge } from "../lib/bridge";
import { fileDiff } from "../lib/diff";
import { toolLook } from "../lib/toolKind";
import { DiffView } from "./DiffView";
import { ToolIcon } from "./ToolIcon";

export type Ask = {
  id: string;
  chatKey?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown> | null;
  toolUseId?: string;
  cwd?: string;
};

/** The path a tool is about to touch, when it names one. */
function target(ask: Ask): string | null {
  const input = ask.toolInput ?? {};
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** The part of a tool call worth reading before deciding. A command in full —
 *  the whole point is what it runs — and the start of anything being written. */
function detail(ask: Ask): { label: string; body: string } | null {
  const input = ask.toolInput ?? {};
  if (typeof input.command === "string" && input.command) {
    return { label: "command", body: input.command };
  }
  if (typeof input.content === "string" && input.content) {
    return { label: "content", body: input.content };
  }
  if (typeof input.new_string === "string") {
    return { label: "replacing with", body: input.new_string };
  }
  return null;
}

export function PermissionAsk({ ask, onAnswered }: { ask: Ask; onAnswered: (id: string) => void }) {
  const [sending, setSending] = useState<"allow" | "deny" | "always" | null>(null);
  const path = target(ask);
  // The same drawing the card will show once the edit has run — asked BEFORE
  // it runs, so it has no line numbers to give. That is the honest half: what
  // is being decided here is the change, not where in the file it lands.
  const diff = fileDiff(ask.toolName ?? "", ask.toolInput);
  const extra = diff ? null : detail(ask);
  // The same icon and the same name the chat's own tool cards use. The question
  // is about a call that is one second away from appearing there, so it should
  // already look like it.
  const look = toolLook(ask.toolName ?? "", ask.toolInput);

  const answer = async (choice: "allow" | "deny" | "always") => {
    setSending(choice);
    try {
      await bridge.invoke("permission_decide", {
        id: ask.id,
        decision: choice === "always" ? "allow" : choice,
        // Kept for the rest of THIS chat, and keyed by the program rather than
        // the exact line: someone who allows `pnpm test` means pnpm, not that
        // string. The backend drops the lot when the chat stops.
        remember: choice === "always",
      });
    } catch {
      // The question expired while the tap was in flight. Either way it is no
      // longer ours to answer, so it leaves the screen.
    }
    onAnswered(ask.id);
  };

  return (
    <div className="ask-card" role="alertdialog" aria-label="Permission needed">
      <div className="ask-card-head">
        <span className="ask-card-dot" aria-hidden="true" />
        <span className="tool-icon" data-kind={look.kind} aria-hidden="true">
          <ToolIcon kind={look.kind} />
        </span>
        <span className="ask-card-title">
          Claude wants to use <strong>{ask.toolName ? look.label : "a tool"}</strong>
          {look.scope && <span className="tool-scope">{look.scope}</span>}
        </span>
      </div>

      {path && (
        <div className="ask-card-path" title={path}>
          <bdi>{path}</bdi>
        </div>
      )}

      {diff && (
        <div className="ask-card-detail">
          <div className="ask-card-label">{diff.kind === "create" ? "writing" : "changing"}</div>
          <DiffView diff={diff} />
        </div>
      )}

      {extra && (
        <div className="ask-card-detail">
          <div className="ask-card-label">{extra.label}</div>
          <pre className="ask-card-body">{extra.body.slice(0, 1200)}</pre>
        </div>
      )}

      <div className="ask-card-buttons">
        <button
          className="ask-btn"
          type="button"
          disabled={!!sending}
          onClick={() => void answer("deny")}
        >
          {sending === "deny" ? "Denying…" : "Deny"}
        </button>
        <button
          className="ask-btn"
          type="button"
          disabled={!!sending}
          title={
            ask.toolName?.toLowerCase() === "bash"
              ? "Stop asking about this program for the rest of this chat"
              : "Stop asking about this tool for the rest of this chat"
          }
          onClick={() => void answer("always")}
        >
          {sending === "always" ? "Allowing…" : "Always"}
        </button>
        <button
          className="ask-btn is-primary"
          type="button"
          disabled={!!sending}
          onClick={() => void answer("allow")}
        >
          {sending === "allow" ? "Allowing…" : "Allow once"}
        </button>
      </div>

      <p className="ask-card-note">
        The agent is paused until you answer. No answer within three minutes counts as Deny.
        “Always” lasts until this chat is stopped.
      </p>
    </div>
  );
}
