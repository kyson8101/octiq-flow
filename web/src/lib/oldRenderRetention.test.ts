// A closure made inside a component's render shares V8's scope with every other
// closure of that render, so one that outlives the render (a window listener, a
// context value a stale fiber keeps, a store's `receive`) keeps whatever the
// render's other closures captured: the whole `chats` map, megabytes of
// transcript. These tests prove the module-level makers hold nothing of the
// render that called them, with real GC, and that the inline form they replaced
// does (the control), so the test can see the leak at all. The paste store's
// `receive` is proved in the real App: scripts/test-scope-retention.mjs.
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { makePendingActionsView } from "../components/PendingActionBadge";
import { watchReading } from "./readingWatch";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    // A WeakRef target stays alive for the rest of the job that made or read it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

const transcript = () => ({ c1: { result: "x".repeat(2_000_000) + Math.random() } });

/** One "App render": `chats` is captured by another closure of the render, so
 *  V8 allocates it in the render's shared scope. `make` runs inside it. */
function render<T>(make: () => T): { ref: WeakRef<object>; kept: T } {
  const chats = transcript();
  const other = () => chats.c1.result.length;
  other();
  return { ref: new WeakRef(chats), kept: make() };
}

/** The form the makers replaced: the closure is made in the render's own scope. */
function renderInline(): { ref: WeakRef<object>; kept: { forRow: (id: string) => readonly string[] } } {
  const chats = transcript();
  const other = () => chats.c1.result.length;
  other();
  const rows = new Map<string, readonly string[]>();
  return { ref: new WeakRef(chats), kept: { forRow: (id) => rows.get(id) ?? [] } };
}

describe("a closure that outlives its render holds no old App render", () => {
  it("control: a view made inline in the render keeps it", async () => {
    const { ref, kept } = renderInline();
    expect(kept.forRow("c1")).toEqual([]);
    expect(await collected(ref)).toBe(false);
  });

  it("the pending view's closures hold only their arguments", async () => {
    const { ref, kept } = render(() => makePendingActionsView(new Map(), new Map(), new Map(), () => {}));
    expect(kept.forRow("c1")).toEqual([]);
    expect(await collected(ref)).toBe(true);
    expect(kept.forTask("t")).toEqual([]);
  });

  it("the reading listener holds only the chat id and its setter", async () => {
    const registered: Array<() => void> = [];
    const target = {
      addEventListener: (_: string, fn: () => void) => { registered.push(fn); },
      removeEventListener: () => {},
    };
    const seen: Array<string | null> = [];
    const { ref, kept: stop } = render(() => watchReading("c1", (id) => { seen.push(id); }, target, { ...target, hidden: false }));
    expect(seen).toEqual(["c1"]);
    expect(registered.length).toBe(3);
    expect(await collected(ref)).toBe(true);
    registered[0]();
    expect(seen).toEqual(["c1", "c1"]);
    stop();
  });
});
