// The short notice for an auto-mode refusal the agent carried on past, and
// the rules for when there is one (`lib/safetyToast`).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => true, on: () => () => {} } }));

import { SAFETY_TOAST_MS, SafetyToast } from "./SafetyToast";
import { SafetyLines } from "./ChatRequests";
import type { SafetyBlockNotice } from "./SafetyBlock";
import {
  AUTO_MODE_BLOCKED, isAutoModeRefusal, NOTHING_RAN, splitSafety, stackToast, type SafetyToastState,
} from "../lib/safetyToast";

const refusal = (id: string, summary = "Security Weaken"): SafetyBlockNotice => ({
  id,
  chatKey: "chat:c1",
  kind: "high-risk-action",
  title: "Claude's auto mode blocked an action",
  summary,
  detail: "Permission for this action was denied by the Claude Code auto mode classifier.",
  provider: "claude",
  action: "git push --force origin main",
});
const outage: SafetyBlockNotice = { ...refusal("o1"), kind: "outage", title: "Claude's safety check was unavailable" };
const codex: SafetyBlockNotice = { ...refusal("x1"), provider: "codex", title: "Codex blocked a high-risk action" };

const draw = (toast: SafetyToastState | null) =>
  renderToStaticMarkup(<SafetyToast toast={toast} onDetails={() => {}} onDone={() => {}} />);

describe("SafetyToast", () => {
  const one = stackToast(null, "c1", refusal("r1"));

  it("draws nothing at all when there is no notice", () => {
    expect(draw(null)).toBe("");
  });

  it("says in one line what happened, why, and that nothing ran", () => {
    const html = draw(one);
    expect(html).toContain('class="safety-toast"');
    expect(html).toContain(`<span class="safety-toast-what">${AUTO_MODE_BLOCKED}</span>`);
    expect(html).toContain('<span class="safety-toast-reason">Security Weaken</span>');
    expect(html).toContain(`<span class="safety-toast-calm">${NOTHING_RAN}</span>`);
    // An icon, never the command: that is one tap away, in the transcript.
    expect(html).toContain("safety-toast-icon");
    expect(html).not.toContain("git push");
  });

  it("is announced politely, not as an alert, and carries no answer buttons", () => {
    const html = draw(one);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Use safer approach");
    expect(html).not.toContain("Dismiss");
  });

  it("offers Details, a real button a keyboard can reach", () => {
    expect(draw(one)).toContain('<button class="safety-toast-details" type="button">Details</button>');
  });

  it("counts only once there is more than one, and describes the newest", () => {
    expect(draw(one)).not.toContain("safety-toast-count");
    const two = stackToast(one, "c1", refusal("r2", "Production Deploy"));
    const html = draw(two);
    expect(html).toContain('<span class="safety-toast-count">2 blocked</span>');
    expect(html).toContain("Production Deploy");
    expect(html).not.toContain("Security Weaken");
    expect(html.split("safety-toast-what").length - 1).toBe(1);
  });

  it("leaves the reason out when the host gave none", () => {
    const html = draw(stackToast(null, "c1", refusal("r1", "  ")));
    expect(html).not.toContain("safety-toast-reason");
    expect(html).toContain(NOTHING_RAN);
  });

  it("stays about five seconds", () => {
    expect(SAFETY_TOAST_MS).toBe(5000);
  });
});

describe("stacking refusals into one notice", () => {
  it("starts at one and names the refusal Details opens", () => {
    expect(stackToast(null, "c1", refusal("r1"))).toEqual({
      chatId: "c1", blockId: "r1", reason: "Security Weaken", seen: ["r1"],
    });
  });

  it("the newest takes the line and the count goes up", () => {
    const one = stackToast(null, "c1", refusal("r1"));
    const two = stackToast(one, "c1", refusal("r2", "Production Deploy"));
    expect(two).toMatchObject({ blockId: "r2", reason: "Production Deploy", seen: ["r1", "r2"] });
    expect(stackToast(two, "c1", refusal("r3")).seen).toHaveLength(3);
  });

  it("the same card announced again changes nothing, so the clock is not restarted", () => {
    const one = stackToast(null, "c1", refusal("r1"));
    const two = stackToast(one, "c1", refusal("r2"));
    expect(stackToast(two, "c1", refusal("r1"))).toBe(two);
    expect(stackToast(two, "c1", refusal("r2"))).toBe(two);
  });

  it("another chat's refusal starts its own count", () => {
    const one = stackToast(null, "c1", refusal("r1"));
    expect(stackToast(one, "c2", refusal("r9"))).toEqual({
      chatId: "c2", blockId: "r9", reason: "Security Weaken", seen: ["r9"],
    });
  });
});

describe("which refusals fold, and when", () => {
  it("only a refusal Claude's auto mode judged", () => {
    expect(isAutoModeRefusal(refusal("r1"))).toBe(true);
    expect(isAutoModeRefusal(outage)).toBe(false);
    expect(isAutoModeRefusal(codex)).toBe(false);
    // A server too old to say whose review it was: that was always Codex.
    expect(isAutoModeRefusal({ kind: "high-risk-action" })).toBe(false);
  });

  it("while the turn runs, it is a line; an outage or a Codex block is still a card", () => {
    const blocks = [refusal("r1"), outage, codex, refusal("r2")];
    const { folded, cards } = splitSafety(blocks, true);
    expect(folded.map((b) => b.id)).toEqual(["r1", "r2"]);
    expect(cards.map((b) => b.id)).toEqual(["o1", "x1"]);
  });

  it("once the agent has stopped, every one of them is a card again", () => {
    const blocks = [refusal("r1"), outage, codex];
    expect(splitSafety(blocks, false)).toEqual({ folded: [], cards: blocks });
  });
});

describe("SafetyLines", () => {
  const io = { onSafetyAnswered: () => {}, onContinue: async () => {} };

  it("adds nothing to the transcript when no refusal is folded", () => {
    expect(renderToStaticMarkup(<SafetyLines blocks={[]} {...io} />)).toBe("");
  });

  it("draws one shut line per refusal, each findable by its card's pending key", () => {
    const html = renderToStaticMarkup(<SafetyLines blocks={[refusal("r1"), refusal("r2")]} {...io} />);
    expect(html.split('class="safety-line"').length - 1).toBe(2);
    expect(html).toContain('data-pending-keys="safety:r1"');
    expect(html).toContain('data-pending-keys="safety:r2"');
    expect(html).not.toContain("ask-card");
  });
});
