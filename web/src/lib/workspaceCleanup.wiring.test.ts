import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import requests from "./useChatRequests.ts?raw";
import cards from "../components/ChatRequests.tsx?raw";
import card from "../components/WorkspaceCleanupCard.tsx?raw";
import fold from "../components/CardFold.tsx?raw";

describe("cleanup's one pending reader and chat hand-off", () => {
  it("refills on the existing connect door, listens to the host event, and answers only id and approve", () => {
    expect(requests.match(/refill\(cleanups, "orchestration_workspace_cleanup_request_pending"\)/g)).toHaveLength(1);
    expect(app).not.toContain('invoke("orchestration_workspace_cleanup_request_pending"');
    expect(requests).toContain('bridge.on<CleanupEvent>("orchestration-workspace-cleanup-request"');
    expect(requests).toMatch(/bridge.invoke<CleanupSettled>\("orchestration_workspace_cleanup_request_answer", \{ id: card.id, approve \}\)/);
    expect(requests).toMatch(/publishCleanup\(applyCleanupEvent\(cleanupStore,/);
  });

  it("hands the same collection to the shared reading and coordinator's card", () => {
    expect(app).toMatch(/pendingReading\(\{[^}]*cleanupRequests,/);
    expect(app).toContain("cleanupRequests={cleanupRequests[conversationId] ?? []}");
    expect(app).toContain("onCleanupAnswer={answerCleanup}");
    expect(cards).toContain("data-pending-keys={`cleanup:${card.id}`}");
    expect(cards).toContain("<WorkspaceCleanupCard card={card} onAnswer={onCleanupAnswer}");
  });

  it("uses the shared disclosure, press guards and request-keyed inFlight", () => {
    expect(card.match(/<FoldLine\b/g)).toHaveLength(1);
    expect(card).toContain("onKeyDown={dropHeld}");
    // Keep them, Remove all, and the settled result's Dismiss.
    expect(card.match(/!repeatsAnother\(event\)/g)).toHaveLength(3);
    expect(fold).toMatch(/notePress\(event\);\s*fold.toggle\(\)/);
    expect(card).toContain("useInFlight(cleanupFlight(card.id))");
    expect(card).toContain("once(cleanupFlight(card.id)");
  });

  it("marks the chosen answer locally before invoking the host and clears it on failure", () => {
    expect(card).toMatch(/setLocalAnswer\(\{ id: card.id, approved: approve \}\);\s*return onAnswer\(card, approve\)/);
    expect(card).toMatch(/catch \(problem\) \{\s*setLocalAnswer\(null\)/);
  });
});
