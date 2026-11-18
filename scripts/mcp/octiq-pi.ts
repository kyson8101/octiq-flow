// OctiqFlow's extension for pi.dev (`pi -e <this file>`), written to
// ~/.octiqflow/mcp/pi/ by the host at every Pi launch. It does two things and
// nothing else:
//
//  1. It registers OctiqFlow's MCP server (`octiq-ask.cjs`, next folder up) for
//     this session only, as `octiq`, with `direct` exposure so the model sees
//     `mcp__octiq__*` like a built-in tool. Nothing is written to the person's
//     ~/.pi or to the project's .pi.
//  2. It sends EVERY tool call to the host (`/hook/pi-tool`) before it runs, with
//     the launch's own capability, and blocks the call unless the host allows
//     it. The host decides from the chat's CURRENT access level (src-tauri/src/
//     pi_gate.rs), shows the normal approval card where Claude would, and
//     answers the card's decision. Any failure to get an answer blocks the call:
//     the gate fails closed.
//
// An extension that cannot load stops Pi (`Failed to load extension`), so a
// launch can never silently run without the gate.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASK_SCRIPT = path.join(here, "..", "octiq-ask.cjs");

// A host answer takes as long as a person takes to press a card (180 s) plus a
// margin; this only stops a wedged socket holding the turn open for good.
const GATE_TIMEOUT_MS = 6 * 60 * 1000;

function gateCall(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ decision: string; reason?: string }> {
  return new Promise((resolve) => {
    const port = Number(process.env.OCTIQ_HOOK_PORT || "");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return resolve({ decision: "deny", reason: "OctiqFlow is not reachable, so this call could not be approved." });
    }
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/hook/pi-tool",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-octiq-chat-capability": process.env.OCTIQ_CHAT_CAPABILITY || "",
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          try {
            const said = JSON.parse(out);
            if (said && typeof said.decision === "string") return resolve(said);
          } catch {
            // fall through
          }
          resolve({ decision: "deny", reason: "OctiqFlow gave no usable answer, so this call was not approved." });
        });
        res.on("aborted", () => resolve({ decision: "deny", reason: "OctiqFlow could not be reached, so this call was not approved." }));
      },
    );
    req.on("error", () => resolve({ decision: "deny", reason: "OctiqFlow could not be reached, so this call was not approved." }));
    req.setTimeout(GATE_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ decision: "deny", reason: "The approval timed out." });
    });
    signal?.addEventListener("abort", () => {
      req.destroy();
      resolve({ decision: "deny", reason: "The call was cancelled." });
    });
    req.write(payload);
    req.end();
  });
}

export default function (pi: any) {
  pi.registerMcpServer("octiq", {
    command: "node",
    args: [ASK_SCRIPT],
    exposure: "direct",
    description: "OctiqFlow's own tools: questions to the person, task status, orchestration, handover, memory vault.",
    timeout: 1800,
  });

  const chatKey = process.env.OCTIQ_CHAT_KEY || "";
  const sessionKey = process.env.OCTIQ_SESSION_KEY || chatKey;
  const launchId = process.env.OCTIQ_LAUNCH_ID || "";

  pi.on("tool_call", async (event: any, ctx: any) => {
    let readOnlyHint: boolean | undefined;
    try {
      const tool = pi.getAllTools().find((t: any) => t.name === event.toolName);
      readOnlyHint = tool?.annotations?.readOnlyHint;
    } catch {
      readOnlyHint = undefined;
    }
    const answer = await gateCall(
      {
        chatKey,
        sessionKey,
        launchId,
        toolName: event.toolName,
        toolInput: event.input ?? {},
        toolUseId: event.toolCallId,
        cwd: ctx?.cwd,
        readOnlyHint,
      },
      ctx?.signal,
    );
    if (answer.decision === "allow") return undefined;
    return { block: true, reason: answer.reason || "OctiqFlow did not allow this call." };
  });
}
