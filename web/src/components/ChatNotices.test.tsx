import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatNotices } from "./ChatNotices";

const INTERRUPTED = "1 background task(s) interrupted when the provider process ended: bz8nya9u6. Retained output may contain partial work; verify it before retrying.";

describe("ChatNotices", () => {
  it("keeps raw diagnostics collapsed behind one quiet row", () => {
    const raw = "2026-09-14T18:14:29Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached";
    const markup = renderToStaticMarkup(
      <ChatNotices notices={[raw, raw]} onClear={vi.fn()} />,
    );

    expect(markup).toContain(">2 notices</span>");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Clear all background notices"');
    expect(markup).not.toContain("codex_core::tools::router");
    expect(markup).not.toContain("Dismiss all");
  });

  it("says a short title and nothing else while folded", () => {
    const markup = renderToStaticMarkup(<ChatNotices notices={[INTERRUPTED]} onClear={vi.fn()} />);
    expect(markup).toContain(">1 background task interrupted</span>");
    // Not the host's sentence, not the task's id, and no hint about grouping.
    expect(markup).not.toContain("provider process");
    expect(markup).not.toContain("bz8nya9u6");
    expect(markup).not.toMatch(/kinds?, grouped/);
    // One row: the control that opens it and the one that clears it.
    expect(markup.match(/<button /g)).toHaveLength(2);
  });
});
