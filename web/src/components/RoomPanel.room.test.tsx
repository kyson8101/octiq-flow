// Card 82 — a seat is what makes a room, so this is reachable in every chat.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Seat } from "../lib/chat";
import { RoomPanel } from "./RoomPanel";

const onDemand: Seat[] = [
  {
    id: "s9",
    name: "DeepSeek",
    agent: "codex",
    provider: "deepseek",
    context: "room_only",
    kind: "on_demand",
  },
];

const seats: Seat[] = [
  { id: "s1", name: "Codex", agent: "codex", context: "project" },
  { id: "s2", name: "Outside eye", agent: "codex", role: "read it as a newcomer", context: "room_only" },
];

const render = (props: Partial<Parameters<typeof RoomPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <RoomPanel
      seats={[]}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      {...props}
    />,
  );

describe("a chat nobody else has joined", () => {
  it("still offers a way to add an agent", () => {
    // Card 82. This used to draw NOTHING until a mode was switched on — two
    // steps to reach one action. Adding a seat is what makes a chat a group, so
    // the control that adds one has to work in a chat that is not one yet.
    expect(render()).toContain("Add an agent");
  });

  it("says there is nobody in it rather than pretending it is not a room", () => {
    expect(render()).toContain("Nobody else is here yet");
  });

  it("carries no switch of its own", () => {
    // Card 76 took the switch out of here; card 82 removed it entirely. Two
    // controls for one thing is two things that can disagree.
    expect(render()).not.toContain("Several agents");
  });
});

describe("a chat with people in it", () => {
  it("offers a way to add an agent", () => {
    expect(render()).toContain("Add an agent");
  });

  it("lists each seat by name", () => {
    const html = render({ seats });

    expect(html).toContain("Codex");
    expect(html).toContain("Outside eye");
    expect(html.match(/room-seat"/g) ?? []).toHaveLength(2);
  });

  it("says what a seat was added for, when it was given a reason", () => {
    const html = render({ seats });

    expect(html).toContain("read it as a newcomer");
  });

  it("marks the seat that cannot see the project", () => {
    // The whole value of an outside seat is what it CANNOT see. If the screen
    // does not say so, nobody can tell it apart from another copy of the host.
    const html = render({ seats });

    expect(html).toContain("room-only");
  });

  it("draws each seat's own mark", () => {
    expect(render({ seats })).toContain("agent-logo");
  });

  it("marks a seat that has no process behind it", () => {
    // It costs nothing while it sits there, and it has no memory of its own.
    // Both matter to whoever is deciding who to ask, so the list says which
    // seats are which.
    const html = render({ seats: onDemand });

    expect(html).toContain("DeepSeek");
    expect(html).toContain("on demand");
  });

  it("names the service answering for it", () => {
    // "on demand" says there is no process. WHICH service answers is a
    // different fact, and the one that decides whether the answer is worth
    // anything.
    expect(render({ seats: onDemand })).toContain("deepseek");
  });

  it("does not mark a resident seat as on demand", () => {
    expect(render({ seats })).not.toContain("on demand");
  });

  it("says plainly that an outside service is sent what the room says", () => {
    // "room-only" is true about FILES and false about what is transmitted: the
    // prompt a seat gets is the room's discussion, which routinely contains
    // code a resident agent pasted in. Someone reading "cannot see the project"
    // and concluding no code leaves the machine would be wrong.
    const html = render({ seats: [] });

    expect(html.toLowerCase()).toContain("sent");
    expect(html.toLowerCase()).toContain("outside");
  });

  it("says the room is empty rather than showing a bare switch", () => {
    const html = render({ seats: [] });

    expect(html).toContain("Nobody else is here yet");
  });
});
