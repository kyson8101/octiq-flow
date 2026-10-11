// The agent is waiting on you.
//
// `claude -p` cannot prompt, so a permission it was not granted in advance is
// simply denied. The agent asks the server over its own control channel
// instead, and the server asks here — which is why this is the one thing in the
// app that is worth interrupting for. Until it is answered, nothing else in
// that chat moves.
//
// It shows what the terminal's y/n cannot: the tool, the file, and the content
// it is about to write. The answer you would give depends on those, and having
// to guess is how people end up granting everything. The plan `ExitPlanMode`
// asks you to approve arrives here too, and is the clearest case of it: there
// is nothing else on the card to judge it by.
import { useEffect, useState } from "react";
import { askDeadline, askRemaining, clockText } from "../lib/askClock";
import { askDetail, changeFacts } from "../lib/askDetail";
import { bridge } from "../lib/bridge";
import { fileDiff } from "../lib/diff";
import { mcpParts, toolLook, toolWords } from "../lib/toolKind";
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
  /** A question the host raised about one change: answered once, never with
   *  "Always" (a new or changed registered agent). */
  once?: boolean;
  /** Its deadline, when it is not the usual three minutes. */
  answerWithinSecs?: number;
  /** When this page saw it arrive, in ms. The page's own stamp, never the
   *  host's: absent on a question read back after a reload, whose age is
   *  unknown (`lib/askClock`). */
  receivedAt?: number;
};

/** The line beside the buttons, in the three parts the card draws: what holds
 *  the agent, the time left when the page knows it, and what follows. */
export function askNoteParts(ask: Ask, remaining?: number | null): [string, string | null, string] {
  const always = ask.once ? "" : " “Always” lasts until this chat is stopped.";
  if (typeof remaining === "number") {
    return ["Paused until you answer. No answer in ", clockText(remaining), ` counts as Deny.${always}`];
  }
  const secs = ask.answerWithinSecs;
  const within = secs && secs < 180 ? `${secs} seconds` : "three minutes";
  return [`Paused until you answer. No answer within ${within} counts as Deny.${always}`, null, ""];
}

/** The line beside the buttons: what holds the agent, and for how long.
 *  `remaining` is the seconds left, for a question this page saw arrive. */
export function askNote(ask: Ask, remaining?: number | null): string {
  const [before, clock, after] = askNoteParts(ask, remaining);
  return `${before}${clock ?? ""}${after}`;
}

/** The time, once a second, while a card has a clock to draw. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The path a tool is about to touch, when it names one. */
function target(ask: Ask): string | null {
  const input = ask.toolInput ?? {};
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** One line naming what is being asked for: the tool, and the path when it
 *  names one. Written for the desktop notification, which gets one line and no
 *  diff — but it is the same question this card draws in full. */
export function askSummary(ask: Ask): string {
  const path = target(ask);
  const tool = ask.toolName || "A tool";
  return path ? `${tool} — ${path}` : tool;
}

export function PermissionAsk({ ask, onAnswered }: { ask: Ask; onAnswered: (id: string) => void }) {
  const [sending, setSending] = useState<"allow" | "deny" | "always" | null>(null);
  const path = target(ask);
  // The same drawing the card will show once the edit has run — asked BEFORE
  // it runs, so it has no line numbers to give. That is the honest half: what
  // is being decided here is the change, not where in the file it lands.
  const diff = fileDiff(ask.toolName ?? "", ask.toolInput);
  const extra = diff ? null : askDetail(ask.toolInput);
  // A change to the registered agents, when it is a sentence and its fields.
  const facts = extra?.label === "change" ? changeFacts(extra.body) : null;
  // The same icon and the same name the chat's own tool cards use. The question
  // is about a call that is one second away from appearing there, so it should
  // already look like it.
  const look = toolLook(ask.toolName ?? "", ask.toolInput);
  // An MCP tool is the exception: it is asked about in words, with its server
  // and its id beside them. The chat's cards keep `mcp(server:tool)`.
  const mcp = mcpParts(ask.toolName ?? "");
  const now = useNow(askDeadline(ask) !== null);
  const [before, clock, after] = askNoteParts(ask, askRemaining(ask, now));

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
    <div className="ask-card permission-card" role="alertdialog" aria-label="Permission needed">
      <div className="ask-card-head">
        <span className="ask-card-dot" aria-hidden="true" />
        <span className="tool-icon" data-kind={look.kind} aria-hidden="true">
          <ToolIcon kind={look.kind} />
        </span>
        {mcp ? (
          <span className="ask-card-title">
            {/* The whole name stays a hover away: it is what "Always" grants. */}
            Claude wants to use <strong title={ask.toolName}>{toolWords(mcp.tool)}</strong>
            <span className="ask-card-chips">
              <span className="label-pill">{mcp.serverLabel}</span>
              <span className="label-pill is-mono">{mcp.tool}</span>
            </span>
          </span>
        ) : (
          <span className="ask-card-title">
            Claude wants to use <strong>{ask.toolName ? look.label : "a tool"}</strong>
            {look.scope && <span className="tool-scope">{look.scope}</span>}
          </span>
        )}
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

      {facts && (
        <div className="ask-card-detail ask-change">
          <p className="ask-change-lead">{facts.lead}</p>
          <dl className="ask-change-rows">
            {facts.rows.map((row, i) => (
              <div key={i}>
                <dt>{row.label}</dt>
                {row.before !== undefined ? (
                  <dd>
                    <span className="ask-change-was">{row.before}</span>
                    <span className="ask-change-arrow"> → </span>
                    <span className="ask-change-now">{row.after}</span>
                  </dd>
                ) : (
                  <dd>{row.value}</dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      )}

      {extra && !facts && (
        <div className="ask-card-detail">
          <div className="ask-card-label">{extra.label}</div>
          <pre className="ask-card-body">{extra.body.slice(0, extra.limit)}</pre>
        </div>
      )}

      <div className="ask-card-foot">
        {/* Plain text, not a live region: a clock read out every second would
            bury the question the card is asking. */}
        {clock === null ? (
          <p className="ask-card-wait">{before}</p>
        ) : (
          <p className="ask-card-wait">
            {before}
            <span className="ask-card-clock">{clock}</span>
            {after}
          </p>
        )}
        <div className="ask-card-actions">
          <button
            className="ask-btn is-quiet"
            type="button"
            disabled={!!sending}
            onClick={() => void answer("deny")}
          >
            {sending === "deny" ? "Denying…" : "Deny"}
          </button>
          {!ask.once && (
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
          )}
          <button
            className="ask-btn is-primary"
            type="button"
            disabled={!!sending}
            onClick={() => void answer("allow")}
          >
            {sending === "allow" ? "Allowing…" : ask.once ? "Allow" : "Allow once"}
          </button>
        </div>
      </div>
    </div>
  );
}
