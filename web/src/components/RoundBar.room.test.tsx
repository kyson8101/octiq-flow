// Card 68 — starting a round, and cutting into one.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Seat } from "../lib/chat";
import { RoundBar, type RoundState } from "./RoundBar";

const seats: Seat[] = [
  { id: "s1", name: "Codex", agent: "codex", context: "project" },
  { id: "s2", name: "Outside eye", agent: "claude", context: "room_only" },
];

const render = (props: Partial<Parameters<typeof RoundBar>[0]> = {}) =>
  renderToStaticMarkup(
    <RoundBar
      seats={seats}
      round={null}
      onAsk={vi.fn()}
      onStop={vi.fn()}
      onNewTopic={vi.fn()}
      {...props}
    />,
  );

describe("with no round running", () => {
  it("is not drawn at all when nobody is in the room", () => {
    // An ordinary chat has no round to start. A control that can never do
    // anything must not appear in every chat.
    expect(render({ seats: [] })).toBe("");
  });

  it("offers to put something to everyone, as an icon", () => {
    // Card 78 — words become icons in the toolbar. The NAME stays, for a screen
    // reader and for anyone who has not learned the icon.
    const html = render();

    expect(html).toContain("Ask the room");
    expect(html).not.toContain(">Ask the room<");
    expect(html).toContain("<svg");
  });

  it("does not offer to stop something that is not running", () => {
    expect(render()).not.toContain("Stop");
  });

  it("offers to draw a line under the topic, as an icon", () => {
    const html = render();

    expect(html).toContain("New topic");
    expect(html).not.toContain(">New topic<");
  });

  it("says a line has been drawn, once one has", () => {
    // The transcript used to carry a rule saying this. Every notice about the
    // room now lives in the composer, so the acknowledgement moved here — but
    // it must not simply vanish: what the seats can no longer see is a fact
    // worth being able to check.
    expect(render({ topicDrawn: true }).toLowerCase()).toContain("earlier");
  });

  it("says nothing about topics before one has been drawn", () => {
    expect(render().toLowerCase()).not.toContain("earlier");
  });
});

const running: RoundState = {
  running: true,
  hand: false,
  waiting: ["s2"],
  said: [{ name: "Codex", answered: true }],
};

describe("with a round running", () => {
  it("says who has spoken and who is still to come", () => {
    const html = render({ round: running });

    expect(html).toContain("Codex");
    expect(html).toContain("Outside eye");
  });

  it("offers a way to cut in", () => {
    // The point of the hand is that the seats still waiting never run, so this
    // has to be reachable WHILE it is going, not after.
    expect(render({ round: running })).toContain("Stop");
  });

  it("does not offer to start a second round on top of the first", () => {
    expect(render({ round: running })).not.toContain("Ask the room");
  });

  it("does not offer a new topic mid-round", () => {
    // Cutting the history out from under seats that are mid-discussion would
    // leave the ones still to speak answering a question they cannot see the
    // start of.
    expect(render({ round: running })).not.toContain("New topic");
  });

  it("marks a seat that failed rather than pretending it answered", () => {
    const html = render({
      round: { ...running, said: [{ name: "Codex", answered: false }], waiting: [] },
    });

    expect(html).toContain("Codex");
    expect(html).toContain("no answer");
  });

  it("says the round was cut short once the hand has gone up", () => {
    const html = render({ round: { ...running, hand: true, waiting: [] } });

    expect(html).toContain("stopped");
  });
});
