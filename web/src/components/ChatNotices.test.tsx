import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatNotices } from "./ChatNotices";

describe("ChatNotices", () => {
  it("keeps raw diagnostics collapsed behind one quiet row", () => {
    const raw = "2026-09-14T18:14:29Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached";
    const markup = renderToStaticMarkup(
      <ChatNotices notices={[raw, raw]} onClear={vi.fn()} />,
    );

    expect(markup).toContain("2 background notices");
    expect(markup).toContain("1 kind, grouped quietly");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Clear all background notices"');
    expect(markup).not.toContain("codex_core::tools::router");
    expect(markup).not.toContain("Dismiss all");
  });
});
