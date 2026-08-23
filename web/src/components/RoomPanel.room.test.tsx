// Card 66 — the switch that turns a chat into a room.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Seat } from "../lib/chat";
import { RoomPanel } from "./RoomPanel";

const seats: Seat[] = [
  { id: "s1", name: "Codex", agent: "codex", context: "project" },
  { id: "s2", name: "Outside eye", agent: "codex", role: "read it as a newcomer", context: "room_only" },
];

const render = (props: Partial<Parameters<typeof RoomPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <RoomPanel
      room={false}
      seats={[]}
      onToggle={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      {...props}
    />,
  );

describe("room mode off, which is every chat by default", () => {
  it("shows the switch and nothing else", () => {
    const html = render();

    expect(html).toContain("Several agents");
    // No seat controls at all — the card's promise is that nothing about rooms
    // is reachable until the switch is on.
    expect(html).not.toContain("Add an agent");
    expect(html).not.toContain("room-seat");
  });

  it("does not show seats even if some are somehow still known", () => {
    // The backend empties a room when it closes. If a stale list ever reaches
    // this component, the switch still wins — what is drawn must match what the
    // user turned off.
    const html = render({ room: false, seats });

    expect(html).not.toContain("Codex");
    expect(html).not.toContain("room-seat");
  });
});

describe("room mode on", () => {
  it("offers a way to add an agent", () => {
    expect(render({ room: true })).toContain("Add an agent");
  });

  it("lists each seat by name", () => {
    const html = render({ room: true, seats });

    expect(html).toContain("Codex");
    expect(html).toContain("Outside eye");
    expect(html.match(/room-seat"/g) ?? []).toHaveLength(2);
  });

  it("says what a seat was added for, when it was given a reason", () => {
    const html = render({ room: true, seats });

    expect(html).toContain("read it as a newcomer");
  });

  it("marks the seat that cannot see the project", () => {
    // The whole value of an outside seat is what it CANNOT see. If the screen
    // does not say so, nobody can tell it apart from another copy of the host.
    const html = render({ room: true, seats });

    expect(html).toContain("room-only");
  });

  it("draws each seat's own mark", () => {
    expect(render({ room: true, seats })).toContain("agent-logo");
  });

  it("says the room is empty rather than showing a bare switch", () => {
    const html = render({ room: true, seats: [] });

    expect(html).toContain("Nobody else is here yet");
  });
});
