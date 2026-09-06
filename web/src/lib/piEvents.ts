// What pi.dev emits in `--mode json`, reduced to the small vocabulary the
// conversation renderer needs. Pi deliberately remains a distinct harness:
// the model inside these events may be OpenAI Codex, but the session and tool
// protocol belong to Pi.

import type { ToolState } from "./chat";

export type PiContent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; args: unknown };

export type PiRead =
  | { kind: "session"; id: string; cwd: string }
  | { kind: "turn" }
  | { kind: "delta"; block: "text" | "thinking"; text: string }
  | {
      kind: "message";
      content: PiContent[];
      model: string;
      usage: Record<string, unknown>;
      error?: string;
      aborted: boolean;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      state: ToolState;
      result?: string;
      details?: unknown;
    }
  | { kind: "done" };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const block = obj(part);
        return str(block.text) || str(block.output);
      })
      .filter(Boolean)
      .join("\n");
  }
  const result = obj(value);
  return str(result.output) || str(result.text) || contentText(result.content);
}

/** Use the names the existing tool cards recognise. Extension tools keep their
 * own name, which still gives them a truthful generic card. */
function toolName(value: unknown): string {
  const raw = str(value);
  const known: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    write: "Write",
    read: "Read",
    grep: "Grep",
    find: "Find",
    ls: "Ls",
  };
  return known[raw.toLowerCase()] ?? raw;
}

function messageContent(raw: unknown): PiContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((part): PiContent[] => {
    const block = obj(part);
    switch (str(block.type)) {
      case "text":
        return str(block.text) ? [{ kind: "text", text: str(block.text) }] : [];
      case "thinking":
        return str(block.thinking) ? [{ kind: "thinking", text: str(block.thinking) }] : [];
      case "toolCall": {
        const id = str(block.id);
        if (!id) return [];
        return [{ kind: "tool", id, name: toolName(block.name), args: block.arguments }];
      }
      default:
        return [];
    }
  });
}

export function readPiEvent(raw: unknown): PiRead | null {
  const event = obj(raw);
  const type = str(event.type);

  if (type === "session") {
    const id = str(event.id);
    return id ? { kind: "session", id, cwd: str(event.cwd) } : null;
  }
  if (type === "turn_start") return { kind: "turn" };
  if (type === "agent_settled") return { kind: "done" };
  // Pi 0.85+ always follows an `agent_end` carrying `willRetry` with the
  // authoritative `agent_settled`. Bare legacy events ended here instead.
  if (type === "agent_end" && !("willRetry" in event)) return { kind: "done" };

  if (type === "message_update") {
    const update = obj(event.assistantMessageEvent);
    const delta = str(update.delta);
    if (!delta) return null;
    if (update.type === "text_delta") return { kind: "delta", block: "text", text: delta };
    if (update.type === "thinking_delta")
      return { kind: "delta", block: "thinking", text: delta };
    return null;
  }

  if (type === "message_end") {
    const message = obj(event.message);
    if (message.role !== "assistant") return null;
    const stop = str(message.stopReason);
    return {
      kind: "message",
      content: messageContent(message.content),
      model: str(message.responseModel) || str(message.model),
      usage: obj(message.usage),
      ...(stop === "error" ? { error: str(message.errorMessage) || "Provider request failed" } : {}),
      aborted: stop === "aborted",
    };
  }

  if (type === "tool_execution_start" || type === "tool_execution_end") {
    const id = str(event.toolCallId);
    if (!id) return null;
    const completed = type === "tool_execution_end";
    return {
      kind: "tool",
      id,
      name: toolName(event.toolName),
      args: event.args,
      state: completed ? (event.isError === true ? "error" : "done") : "running",
      ...(completed ? { result: contentText(event.result), details: obj(event.result).details } : {}),
    };
  }

  return null;
}
