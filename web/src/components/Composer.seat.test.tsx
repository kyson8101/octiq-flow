// Card 82 — the way another agent gets into a chat, in every chat.
// Card 90 — and it is its own panel now, not the fourth group of the settings
// sheet. So these render `RoomSheet`, and the last test holds the split: the
// settings sheet must carry none of this.
//
// Its own file: `Composer.lite.test.tsx` belongs to another piece of work in
// flight, and two chats editing one test file in a shared checkout is how you
// lose someone else's tests.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import type { Seat } from "../lib/chat";
import { ACCESS, MODELS, SettingsSheet } from "./Composer";
import { RoomSheet } from "./RoomPanel";

const seats: Seat[] = [{ id: "s1", name: "Codex", agent: "codex", context: "project" }];

const room = (over: { seats?: Seat[] } = {}) =>
  renderToStaticMarkup(
    <RoomSheet
      seats={over.seats ?? []}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onDone={() => {}}
    />,
  );

const settings = () =>
  renderToStaticMarkup(
    <SettingsSheet
      choice={MODELS[0]}
      onChoice={() => {}}
      missing={() => false}
      noAgents={false}
      started={false}
      accessList={ACCESS[MODELS[0].agent]}
      access="auto"
      onAccess={() => {}}
      effort="high"
      onEffort={() => {}}
      lite={false}
      onLite={() => {}}
      onDone={() => {}}
    />,
  );

describe("adding an agent", () => {
  it("is offered in a chat that has nobody else in it", () => {
    // The whole of card 82. There used to be a mode to turn on first, and the
    // list of who you could add was hidden behind it — so the first agent took
    // two steps and a confirmation to add.
    expect(room()).toContain("Add an agent");
  });

  it("names the ones you can add", () => {
    const html = room();

    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).toContain("DeepSeek");
  });

  it("warns that an outside service is sent what the room says, before you add one", () => {
    // Before, not after. It is the one thing about this decision that cannot be
    // undone, and reading it once a seat is already in the room is too late.
    expect(room().toLowerCase()).toContain("outside service is sent");
  });

  it("lists who is already here", () => {
    expect(room({ seats })).toContain("Codex");
  });

  it("has no mode to switch", () => {
    // Card 82 removed it. A chat is a group when somebody is in it.
    const html = room();

    expect(html).not.toContain("Single chat");
    expect(html).not.toContain("Group chat");
  });

  it("closes on its own Done, and shows nothing else", () => {
    // One thing in this sheet. The three settings that used to sit above the
    // room are the OTHER button's, and reaching the room past them was the
    // whole complaint card 90 answers.
    const html = room();

    expect(html).toContain("sheet-done");
    expect(html).not.toContain("Access");
    expect(html).not.toContain("Effort");
  });

  it("is nowhere in the settings sheet", () => {
    // The split, stated as a test: the person+ button opens the room, and the
    // settings button opens model, access and effort. Neither opens both.
    const html = settings();

    expect(html).not.toContain("Add an agent");
    expect(html).not.toContain("Nobody else is here yet");
  });
});
