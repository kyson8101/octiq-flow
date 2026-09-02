// What the board actually puts on screen.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkBoard } from "./WorkBoard";
import { buildBoard, QUIET_MAX, type BoardInput } from "../lib/board";

function chat(id: string, over: { title?: string; updatedAt?: number } = {}) {
  return {
    id,
    projectId: "p1",
    title: over.title ?? id,
    updatedAt: over.updatedAt ?? 0,
  };
}

function input(over: Partial<BoardInput> = {}): BoardInput {
  return {
    conversations: [],
    running: new Set(),
    busy: new Set(),
    asks: {},
    questions: {},
    ...over,
  };
}

function draw(over: Partial<BoardInput> = {}) {
  return renderToStaticMarkup(
    <WorkBoard
      board={buildBoard(input(over))}
      projectName={(id) => (id === "p1" ? "OctiqFlow" : undefined)}
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("WorkBoard", () => {
  it("names all four columns", () => {
    const html = draw({ conversations: [chat("a")] });
    for (const name of ["Needs you", "Working", "Idle", "Quiet"]) {
      expect(html).toContain(name);
    }
  });

  it("says what a chat wants when it is waiting on a permission", () => {
    const html = draw({
      conversations: [chat("a")],
      running: new Set(["a"]),
      asks: { a: [{ id: "ask1", toolName: "Bash" }] },
    });
    expect(html).toContain("wants to run Bash");
  });

  it("puts the question itself on the card", () => {
    const html = draw({
      conversations: [chat("a")],
      running: new Set(["a"]),
      questions: { a: [{ id: "q1", question: "Page or panel?" }] },
    });
    expect(html).toContain("Page or panel?");
  });

  it("counts what is waiting on you in the header", () => {
    const html = draw({
      conversations: [chat("a"), chat("b")],
      running: new Set(["a", "b"]),
      asks: { a: [{ id: "ask1", toolName: "Bash" }] },
      questions: { b: [{ id: "q1", question: "Which?" }] },
    });
    expect(html).toContain("2 waiting on you");
  });

  it("says so plainly when nothing is waiting", () => {
    const html = draw({ conversations: [chat("a")] });
    expect(html).toContain("nothing waiting on you");
  });

  it("draws the chat title as the card face", () => {
    const html = draw({
      conversations: [chat("a", { title: "Fix the top bar" })],
      running: new Set(["a"]),
    });
    expect(html).toContain("Fix the top bar");
  });

  it("says how many older chats the quiet cap left out", () => {
    const many = Array.from({ length: QUIET_MAX + 3 }, (_, i) =>
      chat(`c${i}`, { updatedAt: i }),
    );
    expect(draw({ conversations: many })).toContain("3 older chats not shown");
  });

  it("invites you to start one when there are no chats at all", () => {
    expect(draw()).toContain("No chats yet");
  });

  it("marks nothing with a left border", () => {
    // Global forbidden pattern: a coloured strip down the left edge is never
    // how a card or row is marked in this app.
    const html = draw({
      conversations: [chat("a")],
      running: new Set(["a"]),
      asks: { a: [{ id: "ask1", toolName: "Bash" }] },
    });
    expect(html).not.toMatch(/border-left/i);
  });
});
