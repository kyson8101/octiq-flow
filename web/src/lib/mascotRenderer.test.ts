import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MascotState } from "./mascotDesign";
import type { ComposerStyle } from "./agentProviders";

const gpu = vi.hoisted(() => ({
  created: vi.fn(), render: vi.fn(), dispose: vi.fn(), lose: vi.fn(),
}));
vi.mock("three", async importOriginal => {
  const actual = await importOriginal<typeof import("three")>();
  return { ...actual, WebGLRenderer: class {
    domElement = new EventTarget();
    constructor() { gpu.created(); }
    setSize() {} setClearColor() {} setViewport() {} setScissor() {} setScissorTest() {}
    render = gpu.render; dispose = gpu.dispose; forceContextLoss = gpu.lose;
  } };
});
import { mountMascot } from "./mascotRenderer";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let motion: EventTarget & { matches: boolean };
let doc: EventTarget & { hidden: boolean };
let intersection: IntersectionObserverCallback;
let handles: ReturnType<typeof mountMascot>[];
const idle: MascotState = { mood: "idle", alert: false, asleep: false };

function mount(robot: ComposerStyle = "sonnet", state: MascotState = idle) {
  const context = { clearRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { getContext: () => context, clientWidth: 28, width: 28, height: 28 } as unknown as HTMLCanvasElement;
  const host = { dataset: {} } as HTMLElement;
  const current = { ...state };
  const handle = mountMascot(canvas, host, robot, () => current);
  handles.push(handle);
  return { canvas, host, current, context, handle };
}
function tick(time: number) {
  const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time));
}
function visible(canvas: HTMLCanvasElement, isIntersecting: boolean) {
  intersection([{ target: canvas, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
}

beforeEach(() => {
  vi.clearAllMocks(); frames = new Map(); nextFrame = 0; handles = [];
  motion = Object.assign(new EventTarget(), { matches: false });
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("window", { matchMedia: () => motion, devicePixelRatio: 2 });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(fn: IntersectionObserverCallback) { intersection = fn; }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { handles.forEach(h => h.dispose()); vi.unstubAllGlobals(); });

describe("shared mascot renderer", () => {
  it("uses one context and one render for repeated Codex/Pi bodies", () => {
    const a = mount("terra"), b = mount("pi-terra");
    visible(a.canvas, true); visible(b.canvas, true); tick(100);
    expect(gpu.created).toHaveBeenCalledTimes(1);
    expect(gpu.render).toHaveBeenCalledTimes(1);
    expect(a.context.drawImage).toHaveBeenCalledTimes(1);
    expect(b.context.drawImage).toHaveBeenCalledTimes(1);
    expect(a.host.dataset.rendered).toBe("true");
  });

  it("stops offscreen and hidden animations, then resumes on visibility", () => {
    const a = mount(); tick(100);
    expect(gpu.render).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
    visible(a.canvas, true); tick(200);
    expect(frames.size).toBe(1);
    doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange")); tick(300);
    expect(gpu.render).toHaveBeenCalledTimes(2);
    visible(a.canvas, false); tick(400);
    expect(frames.size).toBe(0);
  });

  it("draws reduced motion once and wakes a sleeping robot when its state changes", () => {
    motion.matches = true;
    const a = mount(); visible(a.canvas, true); tick(100);
    expect(frames.size).toBe(0);
    motion.matches = false; motion.dispatchEvent(new Event("change")); tick(200);
    expect(frames.size).toBe(1);
    a.current.asleep = true; a.handle.invalidate(); tick(300);
    expect(frames.size).toBe(0);
    a.current.asleep = false; a.current.mood = "work"; a.handle.invalidate(); tick(400);
    expect(frames.size).toBe(1);
    expect(gpu.render).toHaveBeenCalledTimes(4);
  });

  it("releases GPU resources after the last unmount and can mount again", () => {
    const a = mount(), b = mount();
    a.handle.dispose(); handles = handles.filter(h => h !== a.handle);
    expect(gpu.dispose).not.toHaveBeenCalled();
    b.handle.dispose(); handles = [];
    expect(gpu.dispose).toHaveBeenCalledTimes(1);
    expect(gpu.lose).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    const c = mount(); visible(c.canvas, true); tick(100);
    expect(gpu.created).toHaveBeenCalledTimes(2);
    expect(c.host.dataset.rendered).toBe("true");
  });

  it("leaves a fallback when WebGL cannot be initialized", () => {
    gpu.created.mockImplementationOnce(() => { throw new Error("WebGL unavailable"); });
    const a = mount();
    expect(a.host.dataset.rendered).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(() => a.handle.invalidate()).not.toThrow();
  });
});
