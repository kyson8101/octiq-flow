import { describe, expect, it } from "vitest";

import { emptyChat, reduceChat, type ChatState } from "./chat";

// Real `pi --mode rpc` 1.5.2 streams from scripts/test-pi-harness.mjs (a fake
// Anthropic API, so no paid call), verbatim. Re-record them with
// `node scripts/test-pi-harness.mjs web/src/lib/__fixtures__`; never edit them.
// The Rust tests (`agent_provider::tests`) read the same files.
import turn from "./__fixtures__/pi-rpc-turn.jsonl?raw";
import abort from "./__fixtures__/pi-rpc-abort.jsonl?raw";
import noLogin from "./__fixtures__/pi-rpc-no-login.jsonl?raw";

type Json = Record<string, unknown>;

const lines = (stream: string): Json[] =>
  stream.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);

/** What the host does on the way through (`PiProvider::adapt_event` and
 *  `observe_event`): the `get_state` answer becomes a `session`, a refused
 *  prompt a failed message, and the answers, the system prompt's own messages
 *  and `turn_end`'s copy of a turn are not conversation. */
function asTheHostSendsIt(stream: string, prompt: string): Json[] {
  const out: Json[] = [];
  for (const event of lines(stream)) {
    const message = event.message as Json | undefined;
    if (event.type === "response") {
      if (event.command === "get_state" && event.success) {
        out.push({ type: "session", id: (event.data as Json).sessionId, octiq_synthetic: true });
      } else if (event.command === "prompt" && event.success === false) {
        out.push({
          type: "message_end",
          octiq_synthetic: true,
          octiq_rejected_prompt: true,
          message: { role: "assistant", content: [], stopReason: "error", errorMessage: event.error },
        });
      }
      continue;
    }
    if (event.type === "extension_ui_request" || event.type === "turn_end") continue;
    if ((event.type === "message_start" || event.type === "message_end") && message?.role === "system") continue;
    out.push(event);
  }
  return [
    { type: "user", uuid: "turn-1", octiq_user_turn: true, message: { role: "user", content: [{ type: "text", text: prompt }] } },
    ...out,
  ];
}

const replay = (events: Json[]): ChatState => events.reduce((state, event) => reduceChat(state, event), emptyChat());
const everything = (state: ChatState): string => JSON.stringify(state.messages);

describe("pi --mode rpc, recorded", () => {
  it("draws a turn with a refused shell call and an allowed read, and ends once", () => {
    const state = replay(asTheHostSendsIt(turn, "hello there"));
    expect(state.busy).toBe(false);
    expect(state.sessionId).toMatch(/[0-9a-f-]{8,}/);
    const shown = everything(state);
    expect(shown).toContain("fake says: hello there");
    expect(shown).toContain("No shell here (fake host)");
    expect(shown).not.toContain("OCTIQ-TEST-PROMPT-MARKER");
  });

  it("ends a stopped turn and goes on with the next", () => {
    const state = replay(asTheHostSendsIt(abort, "SLOW please keep going"));
    expect(state.busy).toBe(false);
    expect(everything(state)).toContain("fake says: hello again");
  });

  it("draws a prompt refused for no login as a failed turn with the reason", () => {
    const state = replay(asTheHostSendsIt(noLogin, "hello"));
    expect(state.busy).toBe(false);
    // The failure rides the chat's `failure`, which the page draws as a notice.
    expect(JSON.stringify(state.failure)).toContain("No API key found for anthropic");
  });
});
