// One tool call, as a card: what the agent ran, and what came back.
//
// Collapsed by default. A conversation is mostly reading — the interesting part
// is the agent's reasoning, with the tool calls as evidence you can open when
// you doubt it.
//
// So a collapsed row has to be readable at a glance, and it is built to be
// read in that order: an icon that says what KIND of thing this was, the name
// of the thing that actually ran, then the one detail worth carrying — the
// file, the pattern, the command. State sits at the far end, where the eye
// goes only when it is looking for it.
//
// A subagent's card is the exception. What it ran is another agent, and that
// agent's whole transcript hangs off this one card, so there is something to
// watch rather than something to check.
import { useState } from "react";
import type React from "react";
import type { Block } from "../lib/chat";
import { fileDiff } from "../lib/diff";
import { toolDetail, toolLook } from "../lib/toolKind";
import { DiffStat, DiffView } from "./DiffView";
import { ToolIcon, ToolState } from "./ToolIcon";

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

/** The disclosure arrow. Drawn rather than typed: the ▸ character renders at
 *  the mercy of whatever font has it, and at this size that came out as a
 *  speck. */
function Chevron() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function ToolCard({ tool, agent }: { tool: Tool; agent?: AgentRun }) {
  const isAgent = !!agent || AGENT_TOOLS.has(tool.name.toLowerCase());
  const look = toolLook(tool.name, tool.args);
  const isSkill = look.kind === "skill";
  // A subagent card opens itself while its agent is working: a run takes
  // minutes, and a folded card through all of it looks like nothing is
  // happening. It is NOT folded again when the run ends — a card closing itself
  // mid-read takes the paragraph out from under the reader.
  const [open, setOpen] = useState(() => isAgent && tool.state === "running");
  const detail = toolDetail(tool.name, tool.args, isAgent);
  // Edit, Write and MultiEdit are the calls a reader actually wants to SEE,
  // and the only ones whose arguments are unreadable as arguments: two long
  // strings, one of which is the other with something changed. The card draws
  // them as the change they are, and stops quoting the JSON they arrived in.
  const diff = fileDiff(tool.name, tool.args, tool.details);

  return (
    <div
      className={`tool tool-${tool.state} ${isAgent ? "tool-agent" : ""} ${isSkill ? "tool-skill" : ""}`}
    >
      <button
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        type="button"
        // The name on the row is the thing that ran, which for a skill or an
        // MCP call is not the name the agent used. The real one stays here, for
        // the reader who needs it to search a log.
        title={tool.name}
      >
        <span className="tool-icon" data-kind={look.kind} aria-hidden="true">
          <ToolIcon kind={look.kind} />
        </span>
        <span className="tool-name">{look.label}</span>
        {look.scope && <span className="tool-scope">{look.scope}</span>}
        {detail && (
          <span className="tool-detail">
            {/* The span reads right-to-left so a long path keeps its useful
                end; the <bdi> keeps the characters themselves in order. */}
            <bdi>{detail}</bdi>
          </span>
        )}
        {/* Holds the right-hand end of the row open. Without it, a call with
            nothing to summarise — TodoWrite, a skill run bare — leaves its
            state and caret huddled against the name, and a column of rows
            stops lining up. */}
        <span className="tool-gap" />
        {diff && <DiffStat diff={diff} />}
        {agent && (
          <span className="tool-steps">
            {agent.steps} step{agent.steps === 1 ? "" : "s"}
          </span>
        )}
        <ToolState state={tool.state} />
        <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          <Chevron />
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
          {diff && (
            <>
              {/* A call still in flight has not changed anything yet, so it is
                  not shown as a change that happened. And a diff worked out
                  from the arguments says what was asked for, which is not
                  quite the same claim as what the file now holds. */}
              <div className="tool-label">
                {tool.state === "running" ? "writing" : diff.kind === "create" ? "new file" : "changes"}
                {tool.state !== "running" && !diff.numbered && (
                  <span className="tool-note">from the arguments</span>
                )}
              </div>
              <DiffView diff={diff} />
            </>
          )}
          {/* The arguments of a file edit ARE the diff above, said twice as
              long, so they go only when there is no diff to say it better. */}
          {!diff && argsText(tool) && (
            <>
              <div className="tool-label">arguments</div>
              <pre className="tool-pre">{argsText(tool)}</pre>
            </>
          )}
          {/* "The file has been updated successfully" under a drawing of the
              update is noise. A FAILED edit is the opposite: the reason it
              failed is the only thing on the card worth reading. */}
          {tool.result !== undefined && (!diff || tool.state === "error") && (
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
