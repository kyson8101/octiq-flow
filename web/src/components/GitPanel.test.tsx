// The desktop panel is a column of the workspace, the smaller-screen one a
// sheet over the chat. Their headers are the accessible contract that keeps
// those two layouts from drifting back together — and BOTH of them close, which
// is the part that has been taken away once already.
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
  it("is the Changes column on desktop", () => {
    const html = render(true);

    expect(html).toContain("gitp-panel");
    expect(html).toContain("is-persistent");
    expect(html).toContain(">Changes<");
  });

  it("remains a Git sheet below desktop", () => {
    const html = render(false);

    expect(html).toContain(">Git<");
    expect(html).not.toContain("is-persistent");
  });

  it("can be closed in either shape", () => {
    expect(render(true)).toContain('aria-label="Close"');
    expect(render(false)).toContain('aria-label="Close"');
  });
});
