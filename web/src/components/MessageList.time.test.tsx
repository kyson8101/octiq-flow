// A time on every message and a divider where the day changes.
// The zone the divider reads is the machine's, so pin it before any Date is made.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Asia/Kuala_Lumpur";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import type { Message } from "../lib/chat";
import { MessageList } from "./MessageList";

// 2026-11-19 23:50 and 2026-11-20 00:20 in Kuala Lumpur; "now" is 10:00 on the 20th.
const BEFORE = Date.UTC(2026, 10, 19, 15, 50, 0);
const AFTER = Date.UTC(2026, 10, 19, 16, 20, 0);
const NOW = Date.UTC(2026, 10, 20, 2, 0, 0);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const user = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "user", blocks: [{ kind: "text", text }], streaming: false, echo: `e-${id}`, ...extra });
const reply = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "assistant", blocks: [{ kind: "text", text }], streaming: false, ...extra });
const render = (...messages: Message[]) => renderToStaticMarkup(<MessageList messages={messages} busy={false} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("a time on each message", () => {
  it("draws one under the person's message and at the foot of a reply", () => {
    const html = render(user("u1", "hello", { at: BEFORE }), reply("a1", "hi there", { at: BEFORE + 60_000 }));
    expect(count(html, 'class="message-time')).toBe(2);
    // Locale variants: 23:50 / 11:50 PM / 11:50 pm.
    expect(html).toMatch(/(?:\b23:50|\b11:50\s?[ap]m)/i);
    expect(html).toMatch(/(?:\b23:51|\b11:51\s?[ap]m)/i);
  });

  it("puts the full date and time in the title and the accessible name, and makes it a button", () => {
    const html = render(user("u1", "hello", { at: BEFORE }));
    const button = /<button[^>]*class="message-time[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toMatch(/title="[^"]*2026[^"]*"/);
    expect(button).toMatch(/aria-label="[^"]*2026[^"]*"/);
    expect(button).toContain('aria-expanded="false"');
    expect(html).toContain('dateTime="2026-11-19T15:50:00.000Z"');
  });

  it("draws nothing for a message with no time", () => {
    const html = render(user("u1", "hello"), reply("a1", "hi"));
    expect(html).not.toContain("message-time");
    expect(html).not.toContain("day-divider");
  });

  it("gives a queued message its time and keeps its own controls", () => {
    const queued = user("u1", "later", { at: BEFORE, echo: undefined, turnId: "t1", delivery: "queued" });
    const html = renderToStaticMarkup(<MessageList messages={[queued]} busy onCancelQueued={() => {}} onStartQueued={() => {}} />);
    expect(html).toContain("message-time");
    expect(html).toContain("Take this queued message back to edit");
    expect(html).toContain("Send this queued message now");
    expect(html).toContain("Queued");
  });

  it("gives the host's wrap-up turn a time too, with no new control", () => {
    const wrap = user("u1", "Wrapping up", { at: BEFORE, echo: undefined, turnId: "octiq-complete-1", delivery: "sent" as never });
    const html = render(wrap);
    expect(html).toContain("message-time");
    expect(html).not.toMatch(/Retry|Resend/);
  });

  it("is never the accent", () => {
    const html = render(user("u1", "hello", { at: BEFORE }));
    expect(html).not.toContain("accent");
  });
});

describe("the day divider", () => {
  it("is drawn where the local day changes and says Today", () => {
    const html = render(user("u1", "late", { at: BEFORE }), reply("a1", "ok", { at: BEFORE + 60_000 }),
      user("u2", "early", { at: AFTER }), reply("a2", "morning", { at: AFTER + 60_000 }));
    expect(count(html, 'class="day-divider"')).toBe(1);
    expect(html).toMatch(/class="day-divider"[^>]*role="separator"[^>]*><span>Today<\/span>/);
    // Before the second person's message, after the first reply.
    expect(html.indexOf("day-divider")).toBeGreaterThan(html.indexOf("ok"));
    expect(html.indexOf("day-divider")).toBeLessThan(html.indexOf("early"));
  });

  it("is not a turn: the conversation map never sees it", () => {
    const withTimes = render(user("u1", "late", { at: BEFORE }), user("u2", "early", { at: AFTER }));
    const without = render(user("u1", "late"), user("u2", "early"));
    expect(count(withTimes, "data-map-turn")).toBe(count(without, "data-map-turn"));
    expect(count(withTimes, "<article")).toBe(count(without, "<article"));
  });

  it("is not drawn for two messages on one day", () => {
    const html = render(user("u1", "a", { at: AFTER }), reply("a1", "b", { at: AFTER + 600_000 }));
    expect(html).not.toContain("day-divider");
  });

  it("says Yesterday for the day before", () => {
    const html = render(user("u1", "old", { at: BEFORE - 3 * 86_400_000 }), reply("a1", "ok", { at: BEFORE }));
    expect(html).toMatch(/<span>Yesterday<\/span>/);
  });
});
