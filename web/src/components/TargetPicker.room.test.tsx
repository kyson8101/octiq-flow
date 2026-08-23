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

  it("shows only the current target, not one pill per seat", () => {
    // Card 78 — a room with four seats cannot spend four pills of a row that
    // already holds seven controls.
    const html = render({ to: null });

    expect(html).toContain("Everyone");
    expect(html).not.toContain("Outside eye");
  });

  it("names the seat it is currently pointed at", () => {
    const html = render({ to: "s2" });

    expect(html).toContain("Outside eye");
    expect(html).not.toContain("Everyone");
  });

  it("opens the full list on demand", () => {
    const html = render({ open: true });

    expect(html).toContain("Everyone");
    expect(html).toContain("Codex");
    expect(html).toContain("Outside eye");
  });

  it("starts on everyone", () => {
    // The default has to be the room, not a seat: a message typed without a
    // thought about this should go where it always went.
    expect(render({ to: null })).toContain("Everyone");
  });

  it("marks the seat that is currently chosen, in the open list", () => {
    const html = render({ to: "s2", open: true });
    const chosen = /aria-selected="true"[^>]*>(?:(?!<\/button>).)*Outside eye/s.test(html);

    expect(chosen).toBe(true);
  });

  it("draws the chosen seat's own mark on the control", () => {
    // Only when a SEAT is chosen — "Everyone" is not an agent and has no mark.
    expect(render({ to: "s1" })).toContain("agent-logo");
    expect(render({ to: null })).not.toContain("agent-logo");
  });

  it("says a seat cannot see the project, where that is true", () => {
    // Same reason the room panel says it: an outside seat's value is what it
    // cannot see, and picking it without knowing that is picking blind. In the
    // open list, which is where the choice is actually made.
    expect(render({ open: true })).toContain("room-only");
  });
});
