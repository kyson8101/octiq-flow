import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionStatus } from "./ConnectionStatus";

describe("the compact connection status", () => {
  it("names the initial connection without rendering banner copy", () => {
    const html = renderToStaticMarkup(<ConnectionStatus state="connecting" />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Connecting to OctiqFlow"');
    expect(html).toContain("connection-status-link");
    expect(html).not.toContain(">Connecting to OctiqFlow<");
  });

  it("distinguishes a reconnect", () => {
    const html = renderToStaticMarkup(<ConnectionStatus state="closed" />);

    expect(html).toContain('aria-label="Reconnecting to OctiqFlow"');
  });

  it("takes no space once connected", () => {
    expect(renderToStaticMarkup(<ConnectionStatus state="open" />)).toBe("");
  });
});
