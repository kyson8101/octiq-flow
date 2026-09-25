// One localStorage stub, so a test that needs one does not write a ninth.
//
// The web suite runs in the node environment with no jsdom (see AGENTS.md), so
// there is no real `localStorage` to lean on. Every file that needed one grew
// its own copy of this, and each copy has to be found and changed whenever the
// surface does.
//
// Returns the backing map, so a test can plant a row the app would never write
// — an older schema, a half-migrated record — and read back what it did with it.
import { vi } from "vitest";

export function fakeLocalStorage(initial?: Map<string, string>): Map<string, string> {
  const held = initial ?? new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
    clear: () => held.clear(),
    key: (n: number) => [...held.keys()][n] ?? null,
    get length() { return held.size; },
  });
  // `vi.unstubAllGlobals()` in an afterEach is what removes it — restoring by
  // re-stubbing installs the previous value as a stub of its own, which in the
  // node environment means installing `undefined`.
  return held;
}
