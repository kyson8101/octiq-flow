// The arrival box, and the stylesheet it leans on.
//
// Being late is a class on the same two boxes, never a different tree: a card
// that was waiting when its chat opened and one that turned up afterwards
// differ by `is-late` alone, so nothing remounts and nothing replays. The
// motion itself is CSS, so the second half reads the stylesheet: one set of
// tokens, in the design-system layer, and every entry switched off for a
// reader who asked for less motion.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: () => () => {} } }));

import designSystemCss from "../design-system.css?raw";
import mangaSheet from "../manga.css?raw";
import guofengSheet from "../guofeng.css?raw";
import xpSheet from "../xp.css?raw";
import cyberpunkSheet from "../cyberpunk.css?raw";
import lightPalette from "../lib/themes/light.css?raw";
import funPalette from "../lib/themes/fun.css?raw";
import mangaPalette from "../lib/themes/manga.css?raw";
import guofengPalette from "../lib/themes/guofeng.css?raw";
import xpPalette from "../lib/themes/xp.css?raw";
import cyberpunkPalette from "../lib/themes/cyberpunk.css?raw";
import { useMemo, useRef, useState } from "react";
import { liveAppend } from "../lib/arrival";
import { entryClass, useLiveAppend } from "../lib/useArrival";
import { Arrive, LiveArrivals, useLiveEntry } from "./Arrive";
import { ChatRequests, SafetyLines } from "./ChatRequests";
import { ChatTaskBarView } from "./ChatTaskBar";
import { MemoryNote } from "./MemoryNote";

describe("Arrive", () => {
  it("draws the same two boxes whether or not it is late", () => {
    const still = renderToStaticMarkup(<Arrive late={false}><p>card</p></Arrive>);
    const late = renderToStaticMarkup(<Arrive late><p>card</p></Arrive>);
    expect(still).toBe('<div class="arrive"><div class="arrive-body"><p>card</p></div></div>');
    expect(late).toBe('<div class="arrive is-late"><div class="arrive-body"><p>card</p></div></div>');
  });

  it("is not late by its own account when its content is there as it mounts", () => {
    // A chat opened with the card already waiting, or one come back to.
    expect(renderToStaticMarkup(<Arrive when><p>card</p></Arrive>)).not.toContain("is-late");
  });

  it("draws nothing, and holds no place, while there is nothing to draw", () => {
    expect(renderToStaticMarkup(<Arrive when={false}><p>card</p></Arrive>)).toBe("");
  });

  it("is spans inside a button", () => {
    const html = renderToStaticMarkup(<button type="button"><Arrive inline late><span>line</span></Arrive></button>);
    expect(html).toContain('<span class="arrive is-late"><span class="arrive-body">');
    expect(html).not.toContain("<div");
  });

  it("carries a class of its own for where it sits", () => {
    expect(renderToStaticMarkup(<Arrive className="chat-pending-slot"><i /></Arrive>))
      .toContain('class="arrive chat-pending-slot"');
  });
});

describe("a block inside the conversation", () => {
  function Probe() {
    return <i className={useLiveEntry()} />;
  }

  it("takes no entry outside a transcript, or in one being read back", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<i class=""></i>');
    expect(renderToStaticMarkup(<LiveArrivals.Provider value={{ current: false }}><Probe /></LiveArrivals.Provider>))
      .toBe('<i class=""></i>');
  });

  it("enters when the transcript says it was just said", () => {
    expect(renderToStaticMarkup(<LiveArrivals.Provider value={{ current: true }}><Probe /></LiveArrivals.Provider>))
      .toBe('<i class="enter-rise"></i>');
  });

  describe("in a render React runs twice", () => {
    // The transcript sets its window during render when the chat changes,
    // and React then runs that render again before it draws anything. This
    // is that, through React itself: the server renderer re-runs a component
    // whose state was set while it rendered, exactly as the browser's does.
    // What it cannot run is a commit, so the record moving when React
    // commits is checked in a browser (the A to B to A harness), not here.
    const runs: boolean[] = [];
    function Transcript({ chat, ids, decide }: {
      chat: string;
      ids: string[];
      decide: (chat: string, ids: string[]) => boolean;
    }) {
      const [shown, setShown] = useState("");
      if (shown !== chat) setShown(chat);
      const liveNow = decide(chat, ids);
      runs.push(liveNow);
      const live = useMemo(() => ({ current: liveNow }), [liveNow]);
      return <LiveArrivals.Provider value={live}><Probe /></LiveArrivals.Provider>;
    }
    /** The rule as it was: a record written by each run of the render. */
    function useAsItWas(_chat: string, ids: string[]): boolean {
      const drawn = useRef<string[] | null>(null);
      const live = liveAppend(drawn.current, ids);
      drawn.current = ids;
      return live;
    }
    const history = ["t1", "t2", "t3"];

    it("draws a history notice with no entry", () => {
      runs.length = 0;
      const html = renderToStaticMarkup(<Transcript chat="A" ids={history} decide={useLiveAppend} />);
      // Two runs of the one render, and the same answer from both.
      expect(runs).toEqual([false, false]);
      expect(html).toBe('<i class=""></i>');
    });

    it("is the render that used to replay it", () => {
      // The same component with the old rule: the second run saw the turns
      // the first had recorded, and history came in as if it had been said.
      runs.length = 0;
      const html = renderToStaticMarkup(<Transcript chat="A" ids={history} decide={useAsItWas} />);
      expect(runs).toEqual([false, true]);
      expect(html).toBe('<i class="enter-rise"></i>');
    });
  });

  const saved = { id: "m1", status: "saved" as const, text: "Remember this.", at: 1_700_000_000_000 };

  it("leaves a memory note from history as it was", () => {
    const html = renderToStaticMarkup(<MemoryNote activity={saved} />);
    expect(html).toContain('class="memory-note is-saved "');
    expect(html).not.toContain("enter-");
  });

  it("brings in a memory note saved while you watch", () => {
    const html = renderToStaticMarkup(
      <LiveArrivals.Provider value={{ current: true }}><MemoryNote activity={saved} /></LiveArrivals.Provider>,
    );
    expect(html).toContain("memory-note is-saved  enter-rise");
  });
});

describe("the cards above the message box", () => {
  const callbacks = {
    onPermissionAnswered: () => {}, onSafetyAnswered: () => {},
    onContinue: async () => {},
  };
  const ask = { id: "perm-1", toolName: "Bash", toolInput: { command: "pnpm test" } };

  it("draws a card that was waiting when the chat opened in place", () => {
    const html = renderToStaticMarkup(<ChatRequests scope="chat-1" asks={[ask]} safetyBlocks={[]} {...callbacks} />);
    expect(html).toContain('<div class="arrive"><div class="arrive-body"><div class="pending-target" data-pending-keys="permission:perm-1">');
    expect(html).not.toContain("is-late");
  });

  it("keeps the card the first thing inside its pending target", () => {
    // `PendingActionBadge` rings `pending-target`'s first child: the card.
    const html = renderToStaticMarkup(<ChatRequests scope="chat-1" asks={[ask]} safetyBlocks={[]} {...callbacks} />);
    expect(html).toMatch(/data-pending-keys="permission:perm-1"><div class="[^"]*ask-card/);
  });

  it("still adds nothing at all when nothing is asked", () => {
    expect(renderToStaticMarkup(<ChatRequests scope="chat-1" asks={[]} safetyBlocks={[]} {...callbacks} />)).toBe("");
  });

  it("marks a refusal line late only when told it is", () => {
    const block = { id: "s1", chatKey: "chat:1", toolName: "Bash", reason: "Not allowed here.", toolInput: { command: "rm -rf x" } };
    const still = renderToStaticMarkup(<SafetyLines blocks={[block as never]} onSafetyAnswered={() => {}} onContinue={async () => {}} />);
    const late = renderToStaticMarkup(<SafetyLines blocks={[block as never]} late={new Set(["safety:s1"])}
      onSafetyAnswered={() => {}} onContinue={async () => {}} />);
    expect(still).not.toContain("is-late");
    expect(late).toContain('<div class="arrive is-late">');
  });
});

describe("the status line above a chat", () => {
  const status = {
    chatId: "c1",
    report: { objective: "Ship it", steps: [{ title: "a", state: "done" as const }, { title: "b", state: "active" as const }], reportedAt: 1, reportedBy: "claude" },
    workspace: { branch: "feature/x", cwd: "/r", exists: true, isRepo: true, isWorktree: false, changed: 0, ahead: 0, behind: 0, hasUpstream: true },
  };

  it("draws what it knew at the first draw in place", () => {
    const html = renderToStaticMarkup(<ChatTaskBarView status={status as never} scope="c1" open={false} now={2} onToggle={() => {}} />);
    expect(html).toContain('<span class="chat-task-branch">feature/x</span>');
    expect(html).not.toContain("gate-");
  });

  it("holds its place unseen until its status has been answered", () => {
    // Still in the tree, still its own height: only out of sight.
    const html = renderToStaticMarkup(<ChatTaskBarView scope="c1" ready={false} open={false} now={2} onToggle={() => {}} />);
    expect(html).toContain('class="chat-task-trigger enter-gated gate-held"');
    expect(html).toContain("chat-task-phase");
  });

  it("never holds the action button, which waits for nothing", () => {
    const html = renderToStaticMarkup(<ChatTaskBarView action scope="c1" ready={false} open={false} now={2} onToggle={() => {}} />);
    expect(html).toContain("Task details");
    expect(html).not.toContain("gate-held");
  });
});

describe("the entry motion", () => {
  const css = designSystemCss;
  const ms = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)ms`).exec(css)?.[1]);

  it("is one set of tokens, inside the house range", () => {
    // 130–220ms, ease-out, a few pixels: the person's standing rule.
    for (const name of ["enter-duration", "enter-reveal-duration"]) {
      expect(ms(name), name).toBeGreaterThanOrEqual(130);
      expect(ms(name), name).toBeLessThanOrEqual(220);
    }
    expect(Number(/--enter-distance:\s*(\d+)px/.exec(css)?.[1])).toBeLessThanOrEqual(6);
  });

  it("never overshoots", () => {
    // A cubic-bezier overshoots only with a control point outside 0..1.
    const curve = /--enter-ease:\s*cubic-bezier\(([^)]+)\)/.exec(css)?.[1].split(",").map(Number) ?? [];
    expect(curve).toHaveLength(4);
    expect(curve[1]).toBeLessThanOrEqual(1);
    expect(curve[3]).toBeLessThanOrEqual(1);
    expect(curve[1]).toBeGreaterThanOrEqual(0);
    expect(curve[3]).toBeGreaterThanOrEqual(0);
  });

  it("animates opacity and transform, and one bounded row", () => {
    const frames = [...css.matchAll(/@keyframes (enter-[a-z]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(frames.map((match) => match[1]).sort()).toEqual(["enter-clip", "enter-fade", "enter-reveal", "enter-rise"]);
    const touched = new Set(frames.flatMap((match) => [...match[2].matchAll(/([a-z-]+)\s*:/g)].map((prop) => prop[1])));
    expect([...touched].sort()).toEqual(["grid-template-rows", "opacity", "overflow", "transform"]);
  });

  it("is switched off whole for reduced motion, with the space still held", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.enter-fade[\s\S]*?\{ animation: none; \}/.exec(css)?.[0] ?? "";
    for (const selector of [".enter-fade", ".enter-rise", ".arrive.is-late", ".arrive.is-late > .arrive-body", ".gate-entering .enter-gated"]) {
      expect(reduced, selector).toContain(selector);
    }
    // Holding a place is not motion: the held rule sits outside that block.
    expect(reduced).not.toContain("gate-held");
    expect(css).toMatch(/\.gate-held \.enter-gated[^{]*\{ visibility: hidden; \}/);
  });

  it("is the same in every mode: no palette or mode sheet restates it", () => {
    const sheets = { lightPalette, funPalette, mangaPalette, guofengPalette, xpPalette, cyberpunkPalette, mangaSheet, guofengSheet, xpSheet, cyberpunkSheet };
    for (const [name, sheet] of Object.entries(sheets)) {
      expect(sheet.length, name).toBeGreaterThan(0);
      expect(sheet, name).not.toContain("--enter-");
      expect(sheet, name).not.toMatch(/\benter-(fade|rise|reveal|clip)\b/);
    }
  });

  it("names its gate classes the way the stylesheet does", () => {
    expect(entryClass("held")).toBe("gate-held");
    expect(entryClass("entering")).toBe("gate-entering");
    expect(entryClass("settled")).toBe("");
    expect(css).toContain(".gate-entering .enter-gated");
  });
});
