import { describe, expect, it, vi } from "vitest";
import { keepMediaFresh } from "./mediaFreshness";

vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn() } }));

function fixture() {
  const listeners = new Map<string, Array<() => void>>();
  const emit = (type: string) => listeners.get(type)?.forEach(fn => fn());
  const el = {
    paused: true, ended: false, isConnected: true, src: "", currentTime: 0,
    load: vi.fn(), getAttribute: () => el.src || null,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    play: vi.fn(async () => { const wasPaused = el.paused; el.paused = false; el.ended = false; if (wasPaused) emit("play"); }),
    pause: vi.fn(() => { if (!el.paused) { el.paused = true; queueMicrotask(() => emit("pause")); } }),
  };
  const nativePlay = el.play;
  const read = vi.fn<() => Promise<string | null>>().mockResolvedValue("red");
  keepMediaFresh(el as unknown as HTMLMediaElement, "/cut.mp4", "/file?path=cut", read);
  return { el, read, nativePlay };
}
const settled = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("playback freshness on the same element", () => {
  it("replays an overwritten file from zero, but resumes an unchanged file without reload", async () => {
    const { el, read } = fixture();
    await el.play();
    el.currentTime = 1;
    el.pause();
    await el.play();
    expect(el.currentTime).toBe(1);
    expect(el.load).not.toHaveBeenCalled();
    el.pause();
    read.mockResolvedValue("blue");
    await el.play();
    expect(el.src).toContain("revision=blue");
    expect(el.currentTime).toBe(0);
    expect(el.paused).toBe(false);
    expect(el.load).toHaveBeenCalledTimes(1);
    // A repeated play while already playing does not even query the host.
    const calls = read.mock.calls.length;
    read.mockResolvedValue("green");
    await el.play();
    expect(read).toHaveBeenCalledTimes(calls);
    expect(el.src).toContain("revision=blue");
  });

  it("gates native controls too, including replay after ended", async () => {
    const { el, read, nativePlay } = fixture();
    await settled();
    el.ended = true;
    read.mockResolvedValue("blue");
    await nativePlay();
    expect(el.paused).toBe(true);
    await settled();
    expect(el.paused).toBe(false);
    expect(el.src).toContain("revision=blue");
    expect(el.load).toHaveBeenCalledTimes(1);
  });

  it.each(["pause", "release"])("does not resurrect playback after %s during a held host lookup", async action => {
    const { el, read } = fixture();
    await settled();
    let answer!: (value: string) => void;
    read.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const pending = el.play();
    await settled();
    el.pause();
    if (action === "release") { el.src = ""; el.isConnected = false; }
    answer("blue");
    await pending;
    expect(el.paused).toBe(true);
    expect(el.load).not.toHaveBeenCalled();
  });

  it("keeps playback available when the metadata command is unavailable", async () => {
    const { el, read } = fixture();
    read.mockRejectedValue(new Error("old host"));
    await el.play();
    expect(el.paused).toBe(false);
    expect(el.load).not.toHaveBeenCalled();
  });
});
