// App owns the windows; this reads App.tsx as text for the hand-offs that keep
// a retained window honest (no test renders the app, so it is an alarm on the
// wiring's spelling, not a proof of behaviour).
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import { lf } from "./sourceText";

const source = lf(app);

describe("retained windows in App", () => {
  it("never evicts a window holding a prompt only this tab has", () => {
    expect(source).toMatch(/recentChatWindows\.current\.retain\([^;]*hasLocalPrompt\(next\[id\]\)/s);
  });
  it("forgets a chat's reading state when its window is released, invalidated or deleted", () => {
    expect((source.match(/chatReadingStates\.forget\(id\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it("does not widen the transcript subscription for retained windows", () => {
    expect(source).toMatch(/bridge\.watchChats\(ids\.map\(keyFor\)\)/);
    expect(source).not.toMatch(/watchChats\([^)]*retained/);
  });
  it("draws the sidebar from the host, not a window that is behind it", () => {
    expect(source).toMatch(/getPreviewMessages=\{\(id\) => !behind\.has\(id\) && catchUp\.current\.holds/);
    expect(source).toMatch(/windowBehind\(activity\.seq,/);
    expect(source).toMatch(/if \(!screenChats\.current\.has\(id\)\) void refreshOffscreenResponse\(id\)/);
  });
});
