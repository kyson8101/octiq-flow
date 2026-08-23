// Card 76 — one tab strip instead of three stacked rows.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatModeTabs } from "./ChatModeTabs";

const render = (props: Partial<Parameters<typeof ChatModeTabs>[0]> = {}) =>
  renderToStaticMarkup(<ChatModeTabs room={false} onPick={vi.fn()} {...props} />);

describe("the mode strip", () => {
  it("is icons, not words", () => {
    // Card 78 — it sits in a toolbar that already holds seven controls. Two
    // words there is two words nothing else can have.
    const html = render();

    expect(html).not.toContain(">Single chat<");
    expect(html).not.toContain(">Group chat<");
    expect(html).toContain("<svg");
  });

  it("still names both modes for anyone who cannot see the icons", () => {
    // An icon with no name is a mystery to a screen reader and to anyone who
    // has not learned it yet.
    const html = render();

    expect(html).toContain("Single chat");
    expect(html).toContain("Group chat");
  });

  it("marks single chat as current in an ordinary chat", () => {
    const html = render({ room: false });

    expect(/aria-selected="true"[^>]*aria-label="Single chat"/.test(html)).toBe(true);
    expect(/aria-selected="false"[^>]*aria-label="Group chat"/.test(html)).toBe(true);
  });

  it("marks group chat as current in a room", () => {
    const html = render({ room: true });

    expect(/aria-selected="true"[^>]*aria-label="Group chat"/.test(html)).toBe(true);
    expect(/aria-selected="false"[^>]*aria-label="Single chat"/.test(html)).toBe(true);
  });

  it("is a real tablist, so it reads as one choice rather than two buttons", () => {
    expect(render()).toContain('role="tablist"');
  });
});
