// The desktop inspector is furniture, while the smaller-screen Git panel is a
// dismissible sheet. Their headers and close affordances are the accessible
// contract that keeps those two layouts from drifting back together.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  bridge: {
    invoke: async () => null,
    on: () => () => {},
    onState: () => () => {},
  },
}));

import { GitPanel } from "./GitPanel";

beforeAll(() => {
  vi.stubGlobal("window", { innerWidth: 1440 });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
});

afterAll(() => vi.unstubAllGlobals());

const render = (persistent: boolean) =>
  renderToStaticMarkup(
    <GitPanel project={null} open persistent={persistent} onClose={() => {}} />,
  );

describe("the Git side panel", () => {
  it("is a permanent Changes column on desktop", () => {
    const html = render(true);

    expect(html).toContain("gitp-panel");
    expect(html).toContain("is-persistent");
    expect(html).toContain(">Changes<");
    expect(html).not.toContain('aria-label="Close"');
  });

  it("remains a dismissible Git sheet below desktop", () => {
    const html = render(false);

    expect(html).toContain(">Git<");
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain("is-persistent");
  });
});
