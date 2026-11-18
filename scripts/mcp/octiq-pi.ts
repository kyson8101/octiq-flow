// OctiqFlow's extension for pi.dev (`pi -e <this file>`), written to
// ~/.octiqflow/mcp/pi/ by the host at every Pi launch. It does two things and
// nothing else:
//
//  1. It connects to OctiqFlow's MCP server (`octiq-ask.cjs`, next folder up)
//     ITSELF and registers its tools as `mcp__octiq__*` extension tools. It does
//     NOT go through Pi's MCP support (`pi.registerMcpServer`), because that
//     support merges in the person's `~/.pi/agent/mcp.json` and a trusted
//     project's `.pi/mcp.json`, and an entry there named `octiq` replaces a
//     registered server of that name. Nothing is written to the person's
//     ~/.pi or to the project's .pi.
//  2. It sends EVERY tool call to the host (`/hook/pi-tool`) before it runs, with
//     the launch's own capability, and blocks the call unless the host allows
//     it. The host decides from the chat's CURRENT access level (src-tauri/src/
//     pi_gate.rs), shows the normal approval card where Claude would, and
//     answers the card's decision. Any failure to get an answer blocks the call:
//     the gate fails closed. The call says whether the tool is one THIS
//     extension registered (`hostServer`): a tool named `mcp__octiq__*` that
//     came from anywhere else, such as a configured MCP server called `octiq`,
//     gets none of the host's trust.
//
// An extension that cannot load stops Pi (`Failed to load extension`), so a
// launch can never silently run without the gate.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASK_SCRIPT = path.join(here, "..", "octiq-ask.cjs");
const THIS_FILE = fileURLToPath(import.meta.url);

// Pi names a tool's extension by the path it was given; this file knows itself by
// the resolved one (/var and /private/var are one folder on macOS).
function sameFile(a: string, b: string): boolean {
  try {
    return a !== "" && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

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

/** A minimal MCP client over stdio (newline-delimited JSON-RPC) to the host's own server. */
class HostServer {
  private child: ReturnType<typeof spawn> | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private exited: string | undefined;

  start(): void {
    const child = spawn("node", [ASK_SCRIPT], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let cut; (cut = this.buffer.indexOf("\n")) >= 0; ) {
        const line = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (!waiting) continue;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(String(message.error.message || "The OctiqFlow server answered with an error.")));
        else waiting.resolve(message.result);
      }
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-400);
    });
    const ended = (why: string) => {
      this.exited = why;
      for (const [, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(why));
      }
      this.pending.clear();
    };
    child.on("error", (error) => ended(`could not start: ${error.message}`));
    child.on("exit", (code) => ended(`exited (${code})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child?.stdin?.writable) return reject(new Error(`OctiqFlow's MCP server ${this.exited ?? "is not running"}`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OctiqFlow's MCP server did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.notify("notifications/cancelled", { requestId: id, reason: "cancelled" });
        reject(new Error("The call was cancelled."));
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  stop(): void {
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      // already gone
    }
  }
}

// The server's tool calls can wait on the person (ask_user): as long as the server's
// own timeout was when Pi's MCP support carried them.
const CALL_TIMEOUT_MS = 1800 * 1000;

export default async function (pi: any) {
  const chatKey = process.env.OCTIQ_CHAT_KEY || "";
  const sessionKey = process.env.OCTIQ_SESSION_KEY || chatKey;
  const launchId = process.env.OCTIQ_LAUNCH_ID || "";
  const hostTools = new Set<string>();
  const server = new HostServer();
  let startupError: string | undefined;

  try {
    server.start();
    await server.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "octiq-pi", version: "1" } }, 20_000);
    server.notify("notifications/initialized");
    const listed = await server.request("tools/list", {}, 20_000);
    for (const tool of listed?.tools ?? []) {
      const name = `mcp__octiq__${String(tool.name).replace(/[^A-Za-z0-9_]/g, "_")}`;
      hostTools.add(name);
      pi.registerTool({
        name,
        label: String(tool.name),
        description: String(tool.description ?? ""),
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations,
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
          const result = await server.request("tools/call", { name: tool.name, arguments: params ?? {} }, CALL_TIMEOUT_MS, signal);
          const content = Array.isArray(result?.content) ? result.content : [{ type: "text", text: JSON.stringify(result ?? {}) }];
          // A failed MCP call stays a failure for Pi (`isError`, which the model sees as an
          // error result) and keeps everything a success keeps: the content as sent, the
          // result's `_meta` (the host's `octiq/outcome`, which the page reads in `details`)
          // and its structured content. Throwing kept only the text.
          const kept: Record<string, unknown> = { content, details: { _meta: result?._meta } };
          if (result?.structuredContent !== undefined) kept.structuredContent = result.structuredContent;
          if (result?.isError) {
            const hasWords = content.some((block: any) => block?.type === "text" && String(block.text ?? "").trim());
            kept.isError = true;
            if (!hasWords) kept.content = [...content, { type: "text", text: "The OctiqFlow tool failed." }];
          }
          return kept;
        },
      });
    }
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
  }

  const ours = (toolName: string): boolean => {
    if (!hostTools.has(toolName)) return false;
    try {
      const tool = pi.getAllTools().find((t: any) => t.name === toolName);
      const origin = String(tool?.sourceInfo?.path ?? "");
      return sameFile(origin, THIS_FILE) && tool?.sourceInfo?.source !== "builtin" && tool?.sourceInfo?.source !== "sdk";
    } catch {
      return false;
    }
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    const problems: string[] = [];
    if (startupError) problems.push(`octiq: failed: ${startupError}`);
    for (const name of hostTools) {
      if (!ours(name)) problems.push(`${name} is shadowed by another tool of the same name; OctiqFlow does not trust it and will not run it without asking`);
    }
    if (problems.length > 0) ctx?.ui?.notify?.(`MCP servers need attention:\n  ${problems.join("\n  ")}`, "warning");
  });
  pi.on("session_shutdown", async () => server.stop());

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
        hostServer: ours(event.toolName),
      },
      ctx?.signal,
    );
    if (answer.decision === "allow") return undefined;
    return { block: true, reason: answer.reason || "OctiqFlow did not allow this call." };
  });
}
