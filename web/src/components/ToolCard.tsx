// One tool call, as a card: what the agent ran, and what came back.
//
// Collapsed by default. A conversation is mostly reading — the interesting part
// is the agent's reasoning, with the tool calls as evidence you can open when
// you doubt it.
//
// A subagent's card is the exception. What it ran is another agent, and that
// agent's whole transcript hangs off this one card, so there is something to
// watch rather than something to check.
import { useState } from "react";
import type React from "react";
import type { Block } from "../lib/chat";

type Tool = Extract<Block, { kind: "tool" }>;

/** A subagent's own working, when this card started one. */
export type AgentRun = {
  /** How many messages it has written so far. On the collapsed row, so a folded
   *  card still shows that something is going on inside it. */
  steps: number;
  body: React.ReactNode;
};

/** The tools that run another agent.
 *
 *  The card would rather know a subagent by whether it HAS a transcript, but
 *  that only arrives with the subagent's first message — and the card has to
 *  decide whether to open itself before then. The name is what exists at that
 *  moment. */
const AGENT_TOOLS = new Set(["task", "agent"]);

/** The one detail worth showing on a collapsed row: which file, which pattern,
 *  which command. Falls back to nothing rather than dumping the whole object. */
function summarise(tool: Tool, isAgent: boolean): string {
  const args = tool.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  // A subagent is asked in a whole briefing. Ellipsised onto one line that says
  // nothing, so the row takes the short name the caller gave the job instead —
  // the briefing itself is one click away, under `arguments`.
  const keys = isAgent
    ? ["description", "subagent_type", "prompt"]
    : ["file_path", "path", "pattern", "command", "query", "url", "prompt"];
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function argsText(tool: Tool): string {
  if (tool.args !== undefined) {
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {
      /* fall through to the raw stream */
    }
  }
  return tool.argsJson || "";
}

export function ToolCard({ tool, agent }: { tool: Tool; agent?: AgentRun }) {
  const isAgent = !!agent || AGENT_TOOLS.has(tool.name.toLowerCase());
  // A subagent card opens itself while its agent is working: a run takes
  // minutes, and a folded card through all of it looks like nothing is
  // happening. It is NOT folded again when the run ends — a card closing itself
  // mid-read takes the paragraph out from under the reader.
  const [open, setOpen] = useState(() => isAgent && tool.state === "running");
  const detail = summarise(tool, isAgent);

  return (
    <div className={`tool tool-${tool.state} ${isAgent ? "tool-agent" : ""}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="tool-name">{tool.name || "tool"}</span>
        {detail && <span className="tool-detail">{detail}</span>}
        {agent && (
          <span className="tool-steps">
            {agent.steps} step{agent.steps === 1 ? "" : "s"}
          </span>
        )}
        <span className="tool-state">
          {tool.state === "running" ? "running…" : tool.state === "error" ? "failed" : "done"}
        </span>
      </button>

      {open && (
        <div className="tool-body">
          {/* First, because it is what the card was opened for. The briefing
              that started it and the report that ended it are both fixed text;
              this is the part that moves. */}
          {agent && (
            <>
              <div className="tool-label">working</div>
              {agent.body}
            </>
          )}
          {argsText(tool) && (
            <>
              <div className="tool-label">arguments</div>
              <pre className="tool-pre">{argsText(tool)}</pre>
            </>
          )}
          {tool.result !== undefined && (
            <>
              <div className="tool-label">{isAgent ? "report" : "result"}</div>
              <pre className="tool-pre">{tool.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
