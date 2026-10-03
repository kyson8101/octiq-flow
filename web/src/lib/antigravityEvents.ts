// What Antigravity CLI (`agy`) emits with `--output-format stream-json`,
// reduced to the small vocabulary the conversation renderer needs.
//
// Three event names (agy 1.2.16), each carrying its payload under its own
// name: `{"event":"init","init":{…}}`, `{"event":"step_update",
// "step_update":{…}}` and `{"event":"result","result":{…}}`. No other provider
// puts an `event` field at the top of a line, so that field is what marks one
// as Antigravity's; its names are never read on their own.

import type { ToolState } from "./chat";

/** One refused call from a `result`'s `denied_actions`: the permission it
 *  needed (agy 1.2.16 names `command`, `mcp`, `read_file`, `write_file`,
 *  `read_url`, `execute_url` and `unsandboxed`) and the tool that asked, as
 *  Antigravity displays it (`WriteToFile`, `RunCommand`). */
export type AntigravityDenial = { action: string; displayName?: string };

/** One model call's tokens, as its own step reports them (not cumulative). */
export type AntigravityUsage = { input: number; output: number };

export type AntigravityRead =
  | { kind: "session"; id: string }
  /** The person's input taken up: Antigravity's acknowledgement of a turn. */
  | { kind: "turn" }
  | { kind: "delta"; text: string }
  /** A model call finished: the closing piece of its reply, if any, and its
   *  usage, when it reported one. */
  | { kind: "call"; text?: string; usage?: AntigravityUsage }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      state: ToolState;
      result?: string;
    }
  | {
      kind: "done";
      failed: boolean;
      /** The person's own stop, which is not a failure. */
      stopped: boolean;
      error?: string;
      /** What Antigravity refused because nobody could approve it. The turn
       *  ended there. */
      denied: AntigravityDenial[];
      /** The access level the host says the refusal happened at. */
      access?: string;
      durationMs?: number;
    };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** OctiqFlow's own MCP server, as Antigravity names it: a plugin's server is
 *  `<plugin>_<server>`, so ours is `octiqflow_octiq`. */
const OCTIQ_SERVER = "octiqflow_octiq";

/** An OctiqFlow tool is shown under the name the rest of the page knows it
 *  by (`mcp__octiq__ask_user`), whichever way Antigravity called it: by its
 *  own name, or through its generic `call_mcp_tool`. Every other tool keeps
 *  the exact name Antigravity reported. */
export function antigravityTool(name: string, args: unknown): { name: string; args: unknown } {
  const direct = /^mcp_octiqflow_octiq_(.+)$/.exec(name);
  if (direct) return { name: `mcp__octiq__${direct[1]}`, args };
  if (name === "call_mcp_tool") {
    const call = obj(args);
    const server = str(call.ServerName);
    const tool = str(call.ToolName);
    if (server === OCTIQ_SERVER && tool) {
      return { name: `mcp__octiq__${tool}`, args: call.Arguments ?? {} };
    }
  }
  return { name, args };
}

export function readAntigravityEvent(raw: unknown): AntigravityRead | null {
  const event = obj(raw);
  const name = str(event.event);
  if (!name) return null;

  if (name === "init") {
    const id = str(event.conversation_id);
    return id ? { kind: "session", id } : null;
  }

  if (name === "step_update") {
    const step = obj(event.step_update);
    const state = str(step.state);
    switch (str(step.step_type)) {
      case "user_input":
        return state === "DONE" ? { kind: "turn" } : null;
      case "agent_response": {
        const text = str(step.text_delta);
        if (text && state !== "DONE") return { kind: "delta", text };
        if (state !== "DONE") return null;
        const usage = obj(step.usage);
        // The closing piece of a reply comes on the step that ends it.
        return {
          kind: "call",
          ...(text ? { text } : {}),
          ...(Object.keys(usage).length
            ? { usage: { input: num(usage.input_tokens), output: num(usage.output_tokens) } }
            : {}),
        };
      }
      case "tool": {
        const info = obj(step.tool_info);
        const reported = str(info.name) || str(step.tool_name);
        const index = typeof step.step_index === "number" ? step.step_index : NaN;
        if (!reported || !Number.isFinite(index)) return null;
        const { name: shown, args } = antigravityTool(reported, info.parameters);
        const failed = state === "ERROR";
        const output = failed ? str(obj(info.error).message) : str(info.output);
        return {
          kind: "tool",
          id: String(index),
          name: shown,
          args,
          state: state === "ACTIVE" ? "running" : failed ? "error" : "done",
          ...(state === "ACTIVE" ? {} : { result: output }),
        };
      }
      default:
        return null;
    }
  }

  if (name === "result") {
    const result = obj(event.result);
    const status = str(result.status);
    const error = str(result.error);
    const stopped = error.trim() === "interrupted" || status === "CANCELED" || status === "INTERRUPTED";
    const denied = (Array.isArray(result.denied_actions) ? result.denied_actions : []).flatMap(
      (entry): AntigravityDenial[] => {
        const action = str(obj(entry).action);
        const displayName = str(obj(entry).display_name);
        if (!action && !displayName) return [];
        return [{ action, ...(displayName ? { displayName } : {}) }];
      },
    );
    const seconds = typeof result.duration_seconds === "number" ? result.duration_seconds : undefined;
    return {
      kind: "done",
      failed: !stopped && (status === "ERROR" || status === "INVALID"),
      stopped,
      ...(error ? { error } : {}),
      denied,
      ...(str(event.octiq_access) ? { access: str(event.octiq_access) } : {}),
      ...(seconds !== undefined ? { durationMs: Math.round(seconds * 1000) } : {}),
    };
  }

  return null;
}
