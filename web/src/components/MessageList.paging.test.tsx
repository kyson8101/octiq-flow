import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { MessageList } from "./MessageList";
import type { Message } from "../lib/chat";
import { initialTurn, turnWindowStart } from "../lib/messageWindow";

const messages: Message[] = Array.from({ length: 50 }, (_, i) => ({
  id: `u${i}`, role: "user", streaming: false, blocks: [{ kind: "text", text: `unique prompt ${i}.` }],
}));

it("renders only a recent window of a large cached conversation", () => {
  const html = renderToStaticMarkup(<MessageList messages={messages} busy={false} />);
  expect(html).not.toContain("unique prompt 0.");
  expect(html).toContain("unique prompt 49.");
  expect(html).toContain("Load earlier messages");
});

it("exposes loading and retry controls for a server page", () => {
  const html = renderToStaticMarkup(<MessageList messages={messages.slice(-1)} busy={false} hasEarlier loadingEarlier />);
  expect(html).toContain("Loading earlier messages");
  expect(html).toContain("disabled");
  const failed = renderToStaticMarkup(<MessageList messages={messages.slice(-1)} busy={false} hasEarlier earlierError="offline" />);
  expect(failed).toContain("Try again");
  expect(failed).toContain('role="alert"');
});

it("keeps a stable first turn as new messages arrive and includes a saved reading anchor", () => {
  const turns = messages.map((m) => [m]);
  const first = initialTurn(turns);
  expect(turnWindowStart(turns, first)).toBe(38);
  expect(turnWindowStart([...turns, [{ ...messages[0], id: "new" }]], first)).toBe(38);
  expect(turnWindowStart(turns, initialTurn(turns, "u20"))).toBe(19);
});


it("keeps the way back to newer messages outside the scrolling transcript", () => {
  const html = renderToStaticMarkup(<MessageList messages={messages.slice(-3)} busy={false} onLoadLatest={async () => {}} />);
  expect(html).toMatch(/class="jump-slot" aria-hidden="false"/);
  expect(html).toMatch(/class="jump[^"<>]*jump-latest/);
  expect(html).toContain("Newer messages · Return to latest");
  expect(html).toContain('aria-label="Return to latest messages"');
  expect(html).not.toContain('class="load-earlier"');
});


it("keeps the past-window cue visible but disabled during a history read", () => {
  const html = renderToStaticMarkup(<MessageList messages={messages.slice(-3)} busy={false} onLoadLatest={async () => {}} loadingEarlier />);
  expect(html).toMatch(/class="jump-slot" aria-hidden="false"/);
  expect(html).toMatch(/class="jump[^"<>]*jump-latest" disabled=""/);
  expect(html).toContain("Newer messages · Return to latest");
});

it("does not announce newer messages in a live window", () => {
  const html = renderToStaticMarkup(<MessageList messages={messages.slice(-3)} busy />);
  expect(html).not.toContain("Newer messages");
  expect(html).toContain('aria-label="Jump to the end"');
});
