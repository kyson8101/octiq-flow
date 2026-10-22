import { afterEach, describe, expect, it, vi } from "vitest";
import { createMedia } from "./MediaSlot";

vi.mock("../lib/pathStore", () => ({ mediaRevision: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("a player's element", () => {
  it("is the browser's own player, streaming from /file, asking only for its length and first frame", () => {
    const made: Array<Record<string, unknown>> = [];
    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        const attrs: Record<string, string> = {};
        const el = { tag, attrs, setAttribute: (name: string, value: string) => { attrs[name] = value; } };
        made.push(el);
        return el;
      },
    });
    createMedia("video", "/file?path=%2Frepo%2Fwalk-run.mp4", "walk-run.mp4");
    createMedia("audio", "/file?path=%2Frepo%2Fvoice.m4a", "voice.m4a");
    expect(made[0]).toMatchObject({ tag: "video", src: "/file?path=%2Frepo%2Fwalk-run.mp4", controls: true, preload: "metadata", playsInline: true, attrs: { "aria-label": "walk-run.mp4" } });
    expect(made[1]).toMatchObject({ tag: "audio", src: "/file?path=%2Frepo%2Fvoice.m4a", controls: true, preload: "metadata", attrs: { "aria-label": "voice.m4a" } });
    expect(made[1]).not.toHaveProperty("playsInline");
  });
});
