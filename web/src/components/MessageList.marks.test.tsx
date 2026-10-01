// History drawn at a place in the transcript rather than at its end: the head
// before the first turn, and a mark under the turn holding a given message.
// This is where a settled handover goes, so it no longer follows new messages.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import type { Message } from "../lib/chat";
import { handover } from "../lib/handover.fixture";
import { handoverAnchors, handoverLayout, handoverPlaces, handoversFor, type Handover } from "../lib/handover";
import { HandoverCards, handoverTranscript } from "./HandoverCards";
import { MessageList } from "./MessageList";

const say = (id: string, role: Message["role"], text: string): Message => ({
  id, role, blocks: [{ kind: "text", text }], streaming: false,
});

const messages = [
  say("u1", "user", "first question"),
  say("a1", "assistant", "first answer"),
  say("u2", "user", "second question"),
  say("a2", "assistant", "second answer"),
];

describe("history placed in the transcript", () => {
  it("draws the head before the first turn and a mark under its own turn, not at the end", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={messages}
        busy={false}
        head={<p>HEAD-LINE</p>}
        marks={new Map([["a1", <p key="a1">MARK-LINE</p>]])}
        tail={<p>TAIL-CARD</p>}
      />,
    );
    const at = (text: string) => html.indexOf(text);
    expect(at("HEAD-LINE")).toBeGreaterThan(-1);
    expect(at("HEAD-LINE")).toBeLessThan(at("first question"));
    expect(at("MARK-LINE")).toBeGreaterThan(at("first answer"));
    expect(at("MARK-LINE")).toBeLessThan(at("second question"));
    expect(at("TAIL-CARD")).toBeGreaterThan(at("second answer"));
  });

  it("draws a mark whose turn is behind Load earlier after the head, once", () => {
    // Twenty groups; the first page shows the last twelve.
    const long = Array.from({ length: 10 }, (_, i) => [
      say(`u${i}`, "user", `question ${i}`),
      say(`a${i}`, "assistant", `answer ${i}`),
    ]).flat();
    const html = renderToStaticMarkup(
      <MessageList
        messages={long}
        busy={false}
        head={<p>HEAD-LINE</p>}
        marks={new Map([["a1", <p key="a1">MARK-LINE</p>]])}
      />,
    );
    const at = (text: string) => html.indexOf(text);
    expect(html).not.toContain("answer 1<");
    expect(html.split("MARK-LINE").length - 1).toBe(1);
    expect(at("MARK-LINE")).toBeGreaterThan(at("HEAD-LINE"));
    expect(at("MARK-LINE")).toBeLessThan(at("question 4"));
  });

  it("draws nothing for a mark whose message is not in the transcript", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={messages} busy={false} marks={new Map([["gone", <p key="gone">MARK-LINE</p>]])} />,
    );
    expect(html).not.toContain("MARK-LINE");
  });
});

/** The person's phone case: Mango's chat was started by a handover from
 *  Potato, and Mango then handed the task on to Tofu. Drawn as App draws it. */
describe("a chat that was handed a task and handed it on", () => {
  const incoming = handover({ id: "handover_in", status: "confirmed", targetChatKey: "chat:mid" });
  const onward = (extra: Partial<Handover> = {}) => handover({
    id: "handover_out", sourceChatKey: "chat:mid", sourceTitle: "Finish the login fix",
    from: { name: "Mango" }, to: { name: "Tofu" }, status: "confirmed", targetChatKey: "chat:last", ...extra,
  });
  const asked: Message = {
    id: "a1", role: "assistant", streaming: false,
    blocks: [
      { kind: "text", text: "handing it on" },
      {
        kind: "tool", id: "tool_a1", name: "mcp__octiq__handover", argsJson: "{}", args: {}, state: "done",
        result: "The person confirmed handover handover_out. Tofu now continues the task.",
      },
    ],
  };
  const chat = [
    say("u0", "user", "the brief from Potato"),
    say("a0", "assistant", "working on it"),
    say("u1", "user", "pass it to Tofu"),
    asked,
    say("u2", "user", "a later question"),
    say("a2", "assistant", "a later answer"),
  ];
  const draw = (list: Handover[], loaded: Message[]) => {
    const places = handoverPlaces(handoversFor(list, "chat:mid"));
    const layout = handoverLayout(places, handoverAnchors(loaded, places.settled));
    const { head, marks } = handoverTranscript(layout, () => {});
    const tail = layout.tail.length ? <HandoverCards outgoing={layout.tail} onDecide={async () => undefined} /> : undefined;
    return renderToStaticMarkup(<MessageList messages={loaded} busy={false} head={head} marks={marks} tail={tail} />);
  };
  const count = (html: string, text: string) => html.split(text).length - 1;

  it("draws the incoming line at the head and the outgoing one under its turn, each once", () => {
    const html = draw([incoming, onward()], chat);
    const at = (text: string) => html.indexOf(text);
    expect(count(html, 'data-handover="handover_in"')).toBe(1);
    expect(count(html, 'data-handover="handover_out"')).toBe(1);
    expect(at("Handed over from Potato")).toBeLessThan(at("the brief from Potato"));
    expect(at("Handed over to Tofu")).toBeGreaterThan(at("handing it on"));
    expect(at("Handed over to Tofu")).toBeLessThan(at("a later question"));
    expect(html).not.toContain("handover-card");
    expect(html).not.toContain("data-pending");
  });

  it("draws both at the head, incoming first, when the call's turn is not loaded", () => {
    const later = chat.slice(4);
    const html = draw([incoming, onward()], later);
    const at = (text: string) => html.indexOf(text);
    expect(count(html, 'data-handover="handover_in"')).toBe(1);
    expect(count(html, 'data-handover="handover_out"')).toBe(1);
    expect(at("Handed over from Potato")).toBeLessThan(at("Handed over to Tofu"));
    expect(at("Handed over to Tofu")).toBeLessThan(at("a later question"));
    expect(html).not.toContain("handover-card");
  });

  it("holds the tail with only the waiting card, the incoming line staying at the head", () => {
    const html = draw([incoming, onward({ status: "pending", targetChatKey: undefined })], chat);
    const at = (text: string) => html.indexOf(text);
    expect(count(html, 'data-handover="handover_in"')).toBe(1);
    expect(count(html, 'data-handover="handover_out"')).toBe(1);
    expect(count(html, "handover-card ")).toBe(1);
    expect(at("Handed over from Potato")).toBeLessThan(at("the brief from Potato"));
    expect(at("Hand this task to Tofu?")).toBeGreaterThan(at("a later answer"));
    expect(html).toContain('data-pending-keys="handover:handover_out"');
    expect(html).not.toContain("Handed over to Tofu");
  });
});
