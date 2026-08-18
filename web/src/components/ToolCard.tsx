// One tool call, as a card: what the agent ran, and what came back.
//
// Collapsed by default. A conversation is mostly reading — the interesting part
// is the agent's reasoning, with the tool calls as evidence you can open when
// you doubt it.
import { useState } from "react";
import type { Block } from "../lib/chat";

type Tool = Extract<Block, { kind: "tool" }>;

/** The one detail worth showing on a collapsed row: which file, which pattern,
 *  which command. Falls back to nothing rather than dumping the whole object. */
function summarise(tool: Tool): string {
  const args = tool.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  for (const key of ["file_path", "path", "pattern", "command", "query", "url", "prompt"]) {
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

export function ToolCard({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const detail = summarise(tool);

  return (
    <div className={`tool tool-${tool.state}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="tool-name">{tool.name || "tool"}</span>
        {detail && <span className="tool-detail">{detail}</span>}
        <span className="tool-state">
          {tool.state === "running" ? "running…" : tool.state === "error" ? "failed" : "done"}
        </span>
      </button>

      {open && (
        <div className="tool-body">
          {argsText(tool) && (
            <>
              <div className="tool-label">arguments</div>
              <pre className="tool-pre">{argsText(tool)}</pre>
            </>
          )}
          {tool.result !== undefined && (
            <>
              <div className="tool-label">result</div>
              <pre className="tool-pre">{tool.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
