import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { DeletedIndexEntry } from "../lib/chatIndex";
import { DeletedChats } from "./DeletedChats";

const NOW = 1_800_000_000_000;

const chat: DeletedIndexEntry = {
  id: "c1",
  projectId: "p1",
  title: "Recover the login flow",
  sessionId: "session-1",
  modelId: "claude:opus",
  access: "read",
  createdAt: NOW - 10_000,
  updatedAt: NOW - 5_000,
  pinned: false,
  deletedAt: NOW,
};

afterEach(() => vi.useRealTimers());

describe("DeletedChats", () => {
  it("names the restore window and offers the deleted chat back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const out = renderToStaticMarkup(
      <DeletedChats
        chats={[chat]}
        projects={[{ id: "p1", name: "pandaworks-auth" }]}
        onRestore={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(out).toContain('aria-label="Deleted chats"');
    expect(out).toContain("permanently deleted after 24 hours");
    expect(out).toContain("Recover the login flow");
    expect(out).toContain("pandaworks-auth · 24h left");
    expect(out).toContain("Restore chat");
  });
});
