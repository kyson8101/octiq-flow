import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { cleanupAsked, cleanupSettled } from "../lib/__fixtures__/workspaceCleanup";
import { cleanupFlight, type CleanupCard } from "../lib/workspaceCleanup";
import { once } from "../lib/inFlight";
import { WorkspaceCleanupCard } from "./WorkspaceCleanupCard";
import { ChatRequests } from "./ChatRequests";

const draw = (card: CleanupCard = cleanupAsked, startOpen = false) => renderToStaticMarkup(<WorkspaceCleanupCard card={card} onAnswer={async () => {}} startOpen={startOpen} />);
const receipt: CleanupCard = { id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, request: cleanupAsked, result: cleanupSettled };

describe("the coordinator's cleanup card", () => {
  it("arrives folded, with the whole ask, count and both answers", () => {
    const html = draw();
    expect(html).toContain("Remove 3 finished worktrees and close 1 mission? Their work is merged.");
    expect(html).toContain("2 items");
    expect(html).toContain("Keep them");
    expect(html).toMatch(/class="ask-btn is-primary"[^>]*>Remove all/);
    expect(html).toContain('aria-expanded="false"');
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    expect(html).not.toContain("feature/client");
    expect(html).not.toContain("Finish the client");
  });

  it("opens every item and root whole, including unknown and nonzero ignored counts", () => {
    const html = draw(cleanupAsked, true);
    for (const item of cleanupAsked.items) {
      expect(html).toContain(item.title);
      for (const root of item.worktrees) for (const value of [root.branch, root.path, root.headCommit, root.baseBranch]) expect(html).toContain(value);
    }
    expect(html).toContain("Ignored files at stake</dt><dd>Unknown");
    expect(html).toContain("Ignored files at stake</dt><dd>2");
    expect(html).toContain("is-bounded");
  });

  it("keeps long titles, branches, paths and results without cutting", () => {
    const long = "Complete words ".repeat(1500) + "END_OF_ITEM";
    const card = { ...cleanupAsked, items: Array.from({ length: 55 }, (_, i) => ({ ...cleanupAsked.items[0], id: `item-${i}`, title: `${i} ${long}` })) };
    const html = draw(card, true);
    expect(html.match(/END_OF_ITEM/g)).toHaveLength(55);
    expect(html).toContain("55 items");
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    const result = { ...receipt, result: { ...cleanupSettled, items: [{ ...cleanupSettled.items[0], reason: long }] } };
    expect(draw(result, true)).toContain(long);
  });

  it("states that an empty mission closes only its record", () => {
    const card = { ...cleanupAsked, items: [{ ...cleanupAsked.items[1], worktrees: [] }] };
    expect(draw(card, true)).toContain("No worktrees · close the mission record only");
  });

  it("disables both answers while the host processes this batch", () => {
    expect(draw({ ...cleanupAsked, processing: true }).match(/disabled=""/g)).toHaveLength(2);
  });

  it("stays disabled after remount while the same request's answer is out", async () => {
    let resolve!: () => void;
    const pending = once(cleanupFlight(cleanupAsked.id), () => new Promise<void>((done) => { resolve = done; }));
    try { expect(draw().match(/disabled=""/g)).toHaveLength(2); }
    finally { resolve(); await pending; }
    expect(draw()).not.toContain('disabled=""');
  });

  it("settles to a quiet folded line with every host reason behind its one disclosure", () => {
    const html = draw(receipt);
    expect(html).toContain("1 removed · 1 kept");
    expect(html).toContain("is-settled");
    expect(html).not.toContain("Remove all");
    expect(html).not.toContain("ask-card-dot");
    expect(html).toContain('aria-expanded="false"');
    const open = draw(receipt, true);
    for (const item of cleanupSettled.items) expect(open).toContain(item.reason);
    for (const item of cleanupAsked.items) expect(open).toContain(item.title);
  });

  it("shows nothing removed for a denial, including all kept reasons", () => {
    const denied = { ...receipt, result: { ...cleanupSettled, approved: false, items: cleanupSettled.items.map((item) => ({ ...item, status: "kept" as const, reason: "You chose to keep this worktree." })) } };
    expect(draw(denied)).toContain("Nothing removed · kept them all");
    expect(draw(denied, true)).not.toContain("Removed ·");
    expect(draw(denied, true).match(/You chose to keep this worktree./g)).toHaveLength(2);
  });

  it("draws a remote result even when its proposal was never read", () => {
    const html = draw({ id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, result: cleanupSettled }, true);
    expect(html).toContain(cleanupSettled.items[0].id);
    expect(html).toContain(cleanupSettled.items[0].reason);
  });

  it("carries the same pending identity that the badge reveals", () => {
    const html = renderToStaticMarkup(<ChatRequests asks={[]} safetyBlocks={[]} onPermissionAnswered={() => {}} onSafetyAnswered={() => {}} onContinue={() => {}} cleanupRequests={[cleanupAsked]} onCleanupAnswer={async () => {}} />);
    expect(html).toContain('data-pending-keys="cleanup:batch-1"');
    expect(html).toContain("Remove all");
  });
});
