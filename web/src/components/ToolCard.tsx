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
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block } from "../lib/chat";
import { fileDiff } from "../lib/diff";
import { parseSkillBrief } from "../lib/skillRun";
import { askAnswer } from "../lib/askAnswer";
import { toolDetail, toolLook } from "../lib/toolKind";
import { DiffStat, DiffView } from "./DiffView";
import { ToolIcon, ToolState } from "./ToolIcon";

type Tool = Extract<Block, { kind: "tool" }>;

import type { Note } from "../lib/toolGroups";

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

export function ToolCard({
  tool,
  agent,
  note,
  open: openFrom,
}: {
  tool: Tool;
  agent?: AgentRun;
  /** Card 73 — a fenced block the reply wrote straight after this call.
   *
   *  The AGENT'S prose, not the tool's output. It is drawn under its own label
   *  for exactly that reason: a code block after a Bash call can be a snippet
   *  being proposed or an unrelated example, and calling it `result` would make
   *  the card claim the command produced it. */
  note?: Note;
  /** Force the card open. Tests only; the card decides for itself otherwise. */
  open?: boolean;
}) {
  const isAgent = !!agent || AGENT_TOOLS.has(tool.name.toLowerCase());
  const look = toolLook(tool.name, tool.args);
  const isSkill = look.kind === "skill";
  // A subagent card opens itself while its agent is working: a run takes
  // minutes, and a folded card through all of it looks like nothing is
  // happening. It is NOT folded again when the run ends — a card closing itself
  // mid-read takes the paragraph out from under the reader.
  const [open, setOpen] = useState(() => openFrom ?? (isAgent && tool.state === "running"));
  // A skill's card is the skill, not the call. The prompt it put in front of
  // the agent arrives a moment after the call answers (see `brief` on the
  // block); once it has, the row says what the skill is FOR in its own words,
  // and what it was called with moves into a chip beside the name.
  const brief = isSkill && tool.brief ? parseSkillBrief(tool.brief) : null;
  // Card 79 — a question put to the person, and what they decided. The live
  // card that asked is long gone by the time anyone reads this, so the decision
  // has to live on the call that made it.
  const ask = askAnswer(tool.name, tool.args, tool.result);
  const called = toolDetail(tool.name, tool.args, isAgent);
  // A question takes no share of the row. `tool-detail` ellipsises from the
  // LEFT so a long path keeps its useful end — and a question's useful end is
  // its start, so half a question would be the half nobody needs. It gets a line
  // of its own below instead.
  const detail = isSkill ? (brief?.summary ?? "") : ask ? "" : called;
  const skillArgs = isSkill ? called : "";
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
        {skillArgs && <span className="tool-args">{skillArgs}</span>}
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
        {/* Beside the state, and not instead of it, because the two answer
            different questions: the tick says the call went through, this says
            how the work it started actually ended. */}
        {tool.finish?.status && (
          <span className="tool-finish" data-status={tool.finish.status}>
            {tool.finish.status}
          </span>
        )}
        <ToolState state={tool.state} />
        <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          <Chevron />
        </span>
      </button>

      {/* Outside the fold, on purpose. Everything else on a card is detail you
          go looking for; this is a decision that was made, and a decision you
          have to open a card to find is one you will not find. */}
      {ask && (
        <div className="tool-answer">
          <div className="tool-answer-q">{ask.question}</div>
          {(ask.answer || ask.unanswered) && (
            <div className="tool-answer-row">
              <span className="tool-answer-mark" aria-hidden="true">
                &#8627;
              </span>
              {ask.answer ? (
                <span className="tool-answer-said">{ask.answer}</span>
              ) : (
                // Never the machine's own sentence. "The question timed out" put
                // on this line reads as a decision to time out.
                <span className="tool-answer-none">{ask.unanswered}</span>
              )}
            </div>
          )}
        </div>
      )}

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
          {/* What the skill asked of the agent, as the markdown it was written
              in. This is the card's whole reason to open: the arguments are
              one word (the skill's name, already on the row) and the result is
              one line ("Launching skill: …"), so neither is shown beside it. */}
          {brief && (
            <>
              <div className="tool-label">
                instructions
                {/* Absent for a skill bundled with the agent: there is no
                    folder it was read from to name. */}
                {brief.dir && <span className="tool-note">{brief.dir}</span>}
              </div>
              <div className="tool-brief prose">
                <Markdown remarkPlugins={[remarkGfm]}>{brief.body}</Markdown>
              </div>
            </>
          )}
          {/* The arguments of a file edit ARE the diff above, said twice as
              long, so they go only when there is no diff to say it better. */}
          {!diff && !brief && argsText(tool) && (
            <>
              <div className="tool-label">arguments</div>
              <pre className="tool-pre">{argsText(tool)}</pre>
            </>
          )}
          {/* "The file has been updated successfully" under a drawing of the
              update is noise. A FAILED edit is the opposite: the reason it
              failed is the only thing on the card worth reading. A skill's
              "Launching skill: x" is the same noise, and kept the same way:
              only when the launch failed. */}
          {tool.result !== undefined && (!diff || tool.state === "error") && (!isSkill || tool.state === "error") && !ask && (
            <>
              <div className="tool-label">{isAgent ? "report" : "result"}</div>
              <pre className="tool-pre">{tool.result}</pre>
            </>
          )}
          {/* The reply's own words, kept with the call they followed. Its own
              label, never "result": see the `note` prop. */}
          {note && (
            <>
              <div className="tool-label">note</div>
              <pre className="tool-pre tool-note-body">{note.body}</pre>
            </>
          )}
          {/* Last, because it is what happened last. The result above is the
              answer the call gave the moment it started — "running in
              background", an id — and this is the same work minutes later,
              reported by the task itself. */}
          {tool.finish && (
            <>
              <div className="tool-label">
                finished
                {tool.finish.outputFile && (
                  <span className="tool-note">{tool.finish.outputFile}</span>
                )}
              </div>
              <pre className="tool-pre">{tool.finish.summary}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
