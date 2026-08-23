// Card 82 — the way another agent gets into a chat, in every chat.
//
// Its own file: `Composer.lite.test.tsx` belongs to another piece of work in
// flight, and two chats editing one test file in a shared checkout is how you
// lose someone else's tests.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import type { Seat } from "../lib/chat";
import { ACCESS, MODELS, SettingsSheet } from "./Composer";

const seats: Seat[] = [{ id: "s1", name: "Codex", agent: "codex", context: "project" }];

const sheet = (over: { seats?: Seat[]; withRoom?: boolean } = {}) =>
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
      {...(over.withRoom === false
        ? {}
        : { seats: over.seats ?? [], onAddSeat: vi.fn(), onRemoveSeat: vi.fn() })}
    />,
  );

describe("adding an agent", () => {
  it("is offered in a chat that has nobody else in it", () => {
    // The whole of card 82. There used to be a mode to turn on first, and the
    // list of who you could add was hidden behind it — so the first agent took
    // two steps and a confirmation to add.
    expect(sheet()).toContain("Add an agent");
  });

  it("names the ones you can add", () => {
    const html = sheet();

    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).toContain("DeepSeek");
  });

  it("warns that an outside service is sent what the room says, before you add one", () => {
    // Before, not after. It is the one thing about this decision that cannot be
    // undone, and reading it once a seat is already in the room is too late.
    expect(sheet().toLowerCase()).toContain("outside service is sent");
  });

  it("lists who is already here", () => {
    expect(sheet({ seats })).toContain("Codex");
  });

  it("has no mode to switch", () => {
    // Card 82 removed it. A chat is a group when somebody is in it.
    const html = sheet();

    expect(html).not.toContain("Single chat");
    expect(html).not.toContain("Group chat");
  });

  it("is absent altogether from a sheet given no room callbacks", () => {
    // The desktop settings sheet is drawn from the same component in places
    // that have no seat list to offer.
    expect(sheet({ withRoom: false })).not.toContain("Add an agent");
  });
});
