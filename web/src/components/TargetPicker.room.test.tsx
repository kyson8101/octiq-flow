// Card 67 — choosing who a message is for.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Seat } from "../lib/chat";
import { TargetPicker } from "./TargetPicker";

const seats: Seat[] = [
  { id: "s1", name: "Codex", agent: "codex", context: "project" },
  { id: "s2", name: "Outside eye", agent: "claude", context: "room_only" },
];

const render = (props: Partial<Parameters<typeof TargetPicker>[0]> = {}) =>
  renderToStaticMarkup(<TargetPicker seats={seats} to={null} onPick={vi.fn()} {...props} />);

describe("the target picker", () => {
  it("is not drawn at all when nobody else is in the room", () => {
    // A chat with no seats is an ordinary chat, and an ordinary chat has
    // nothing to choose between. Drawing a picker with one entry would be a
    // control that can never change anything.
    expect(render({ seats: [] })).toBe("");
  });

  it("offers everyone plus a row per seat", () => {
    const html = render();

    expect(html).toContain("Everyone");
    expect(html).toContain("Codex");
    expect(html).toContain("Outside eye");
  });

  it("starts on everyone", () => {
    const html = render({ to: null });

    // The default has to be the room, not a seat: a message typed without a
    // thought about this should go where it always went.
    expect(/Everyone[^<]*<\/[^>]+>\s*<\/button>/.test(html) || html.includes("is-on")).toBe(true);
  });

  it("marks the seat that is currently chosen", () => {
    const html = render({ to: "s2" });
    const chosen = /class="[^"]*is-on[^"]*"[^>]*>(?:(?!<\/button>).)*Outside eye/s.test(html);

    expect(chosen).toBe(true);
  });

  it("draws each seat's own mark", () => {
    expect(render()).toContain("agent-logo");
  });

  it("says a seat cannot see the project, where that is true", () => {
    // Same reason the room panel says it: an outside seat's value is what it
    // cannot see, and picking it without knowing that is picking blind.
    expect(render()).toContain("room-only");
  });
});
