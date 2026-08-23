// Card 76 — one tab strip instead of three stacked rows.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatModeTabs } from "./ChatModeTabs";

const render = (props: Partial<Parameters<typeof ChatModeTabs>[0]> = {}) =>
  renderToStaticMarkup(<ChatModeTabs room={false} onPick={vi.fn()} {...props} />);

describe("the mode strip", () => {
  it("offers both modes", () => {
    const html = render();

    expect(html).toContain("Single chat");
    expect(html).toContain("Group chat");
  });

  it("marks single chat as current in an ordinary chat", () => {
    const html = render({ room: false });

    expect(/aria-selected="true"[^>]*>Single chat/.test(html)).toBe(true);
    expect(/aria-selected="false"[^>]*>Group chat/.test(html)).toBe(true);
  });

  it("marks group chat as current in a room", () => {
    const html = render({ room: true });

    expect(/aria-selected="true"[^>]*>Group chat/.test(html)).toBe(true);
    expect(/aria-selected="false"[^>]*>Single chat/.test(html)).toBe(true);
  });

  it("is a real tablist, so it reads as one choice rather than two buttons", () => {
    expect(render()).toContain('role="tablist"');
  });
});
