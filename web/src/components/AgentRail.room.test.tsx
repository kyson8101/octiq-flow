// Card 66 — the rail shows who is IN the room, not only what has run in it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Seat } from "../lib/chat";
import { AgentRail } from "./AgentRail";

const seats: Seat[] = [{ id: "s1", name: "Codex", agent: "codex", context: "project" }];

describe("the rail in a chat that is not a room", () => {
  it("stays hidden when nothing has ever run, exactly as before", () => {
    expect(renderToStaticMarkup(<AgentRail agents={[]} />)).toBe("");
  });
});

describe("the rail in a room", () => {
  it("appears for a seat alone, before anything has run", () => {
    // The rail's old rule was "nothing has run, so there is nothing to show".
    // A room with someone sitting in it has something to show whether or not a
    // single agent has started yet.
    const html = renderToStaticMarkup(<AgentRail agents={[]} seats={seats} />);

    expect(html).not.toBe("");
    expect(html).toContain("Codex");
  });

  it("names the seats as who is HERE, not as something that ran", () => {
    const html = renderToStaticMarkup(<AgentRail agents={[]} seats={seats} />);

    expect(html).toContain("In this room");
  });

  it("draws each seat's own mark", () => {
    expect(renderToStaticMarkup(<AgentRail agents={[]} seats={seats} />)).toContain("agent-logo");
  });
});
