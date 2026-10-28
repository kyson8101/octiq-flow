import { afterEach, describe, expect, it, vi } from "vitest";
import { keepMediaFresh, MEDIA_FRESHNESS_WAIT_MS } from "./mediaFreshness";

vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn() } }));

function fixture(initial: string | null = "red") {
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
  const read = vi.fn<() => Promise<string | null>>().mockResolvedValue(initial);
  keepMediaFresh(el as unknown as HTMLMediaElement, "/cut.mp4", "/file?path=cut", read);
  return { el, read, nativePlay };
}
const settled = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it("checks native controls too without stopping the press, including replay after ended", async () => {
    const { el, read, nativePlay } = fixture();
    await settled();
    el.ended = true;
    read.mockResolvedValue("blue");
    await nativePlay();
    expect(el.paused).toBe(false);
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

  it("does not mistake an unavailable initial revision for a changed file", async () => {
    const { el, read } = fixture(null);
    await settled();
    el.currentTime = 5;
    read.mockResolvedValue("red");
    await el.play();
    expect(el.load).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(5);
    el.pause();
    read.mockResolvedValue("blue");
    await el.play();
    expect(el.load).toHaveBeenCalledTimes(1);
    expect(el.currentTime).toBe(0);
  });

  it.each([false, true])("bounds a slow lookup and coalesces repeated %s native plays without losing position", async native => {
    vi.useFakeTimers();
    const { el, read, nativePlay } = fixture();
    await settled();
    el.currentTime = 42;
    let answer!: (value: string) => void;
    read.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const press = native ? nativePlay : () => el.play();
    const first = press();
    await settled();
    expect(el.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    const again = press();
    await settled();
    expect(read).toHaveBeenCalledTimes(2); // initial revision + one shared lookup
    await vi.advanceTimersByTimeAsync(MEDIA_FRESHNESS_WAIT_MS);
    await Promise.all([first, again]);
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBe(42);
    expect(el.load).not.toHaveBeenCalled();
    expect(nativePlay).toHaveBeenCalledTimes(native ? 2 : 1);
    // A response after the bound cannot restart/reset an active player.
    answer("blue");
    await settled();
    expect(el.currentTime).toBe(42);
    expect(el.src).toContain("revision=red");
    expect(el.load).not.toHaveBeenCalled();
    el.pause();
    read.mockResolvedValue("blue");
    await el.play();
    expect(el.load).toHaveBeenCalledTimes(1);
    expect(el.currentTime).toBe(0);
    expect(el.src).toContain("revision=blue");
  });

  it("does not overlap lookups even across timeout, pause and a new play", async () => {
    vi.useFakeTimers();
    const { el, read } = fixture();
    await settled();
    el.currentTime = 17;
    let answer!: (value: string) => void;
    read.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const first = el.play();
    await vi.advanceTimersByTimeAsync(MEDIA_FRESHNESS_WAIT_MS);
    await first;
    el.pause();
    const second = el.play();
    await vi.advanceTimersByTimeAsync(MEDIA_FRESHNESS_WAIT_MS);
    await second;
    expect(el.paused).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    answer("red");
    await settled();
    expect(el.load).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(17);
  });

  it("does not reload on an overdue answer that runs before the delayed timer", async () => {
    vi.useFakeTimers();
    const { el, read } = fixture();
    await settled();
    el.currentTime = 21;
    let answer!: (value: string) => void;
    read.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const pending = el.play();
    await settled();
    clock.mockReturnValue(MEDIA_FRESHNESS_WAIT_MS + 1);
    answer("blue");
    await pending;
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBe(21);
    expect(el.load).not.toHaveBeenCalled();
  });

  it("does not reload or restart a native play that the person then pauses", async () => {
    const { el, read, nativePlay } = fixture();
    await settled();
    let answer!: (value: string) => void;
    read.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    await nativePlay();
    await settled();
    el.pause();
    answer("blue");
    await settled();
    expect(el.paused).toBe(true);
    expect(el.load).not.toHaveBeenCalled();
  });

  it("reports a failed play when there is no replacement revision", async () => {
    const { el, nativePlay } = fixture();
    await settled();
    nativePlay.mockRejectedValueOnce(new Error("play refused"));
    await expect(el.play()).rejects.toThrow("play refused");
  });

  it("lets a verified reload replace the first play promise it aborted", async () => {
    const { el, read, nativePlay } = fixture();
    await settled();
    read.mockResolvedValue("blue");
    nativePlay.mockRejectedValueOnce(new Error("old play aborted by reload"));
    await el.play();
    expect(el.paused).toBe(false);
    expect(el.src).toContain("revision=blue");
    expect(el.load).toHaveBeenCalledTimes(1);
    expect(nativePlay).toHaveBeenCalledTimes(2);
  });
});
