import { ACESFilmicToneMapping, DirectionalLight, HemisphereLight, Scene, WebGLRenderer } from "three";
import type { ComposerStyle } from "./agentProviders";
import { robotBody } from "./mascotDesign";
import type { MascotState, RobotBody } from "./mascotDesign";
import { createMascotCamera, createRobot, poseRobot } from "./mascotScene";
import type { RobotRig } from "./mascotScene";

type Entry = {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  context: CanvasRenderingContext2D;
  body: RobotBody;
  state: () => MascotState;
  visible: boolean;
  lastFrame: string;
};

/** Render once per visible model/state/size, then copy into ordinary 2D canvases.
 * A single offscreen WebGL context avoids browser context limits, while local
 * canvases preserve DOM clipping, scrolling, opacity and modal stacking. */
class MascotRenderer {
  private renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  private scene = new Scene();
  private camera = createMascotCamera();
  private entries = new Set<Entry>();
  private rigs = new Map<RobotBody, RobotRig>();
  private motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private frame = 0;
  private lastTime = -Infinity;
  private lost = false;
  private observer = new IntersectionObserver(changes => {
    for (const change of changes) {
      const entry = [...this.entries].find(e => e.canvas === change.target);
      if (entry) { entry.visible = change.isIntersecting; entry.lastFrame = ""; }
    }
    this.invalidate();
  });
  private resize = new ResizeObserver(() => this.invalidate());

  constructor() {
    this.renderer.setSize(512, 512, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene.add(new HemisphereLight(0xf1f7ff, 0x617888, 2.7));
    const key = new DirectionalLight(0xfff5ea, 3.4);
    key.position.set(-3, 5, 6); this.scene.add(key);
    const rim = new DirectionalLight(0xa4cbff, 2.6);
    rim.position.set(3, 2, -4); this.scene.add(rim);
    this.motion.addEventListener("change", this.refresh);
    document.addEventListener("visibilitychange", this.refresh);
    this.renderer.domElement.addEventListener("webglcontextlost", this.contextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.contextRestored);
  }

  private contextLost = (event: Event) => {
    event.preventDefault(); this.lost = true;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.entries.forEach(e => { delete e.host.dataset.rendered; });
  };
  private contextRestored = () => { this.lost = false; this.refresh(); };
  private refresh = () => {
    this.entries.forEach(e => { e.lastFrame = ""; });
    if (document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; }
    else this.invalidate();
  };
  invalidate = () => {
    if (!this.frame && !document.hidden && !this.lost) this.frame = requestAnimationFrame(this.draw);
  };

  add(canvas: HTMLCanvasElement, host: HTMLElement, robot: ComposerStyle, state: () => MascotState) {
    const context = canvas.getContext("2d");
    if (!context) return { dispose: () => {}, invalidate: () => {} };
    const entry: Entry = { canvas, host, context, body: robotBody(robot), state, visible: false, lastFrame: "" };
    this.entries.add(entry);
    this.observer.observe(canvas); this.resize.observe(canvas);
    this.invalidate();
    return {
      invalidate: () => { entry.lastFrame = ""; this.invalidate(); },
      dispose: () => {
        this.observer.unobserve(canvas); this.resize.unobserve(canvas);
        this.entries.delete(entry); delete host.dataset.rendered;
        if (!this.entries.size) { this.dispose(); shared = undefined; }
      },
    };
  }

  private draw = (time: number) => {
    this.frame = 0;
    if (document.hidden || this.lost) return;
    // One 30fps clock for the entire cast, independent of React's render loop.
    if (time - this.lastTime < 1000 / 30) { this.invalidate(); return; }
    this.lastTime = time;
    const batches = new Map<string, { entries: Entry[]; state: MascotState; pixels: number }>();
    let animate = false;
    for (const entry of this.entries) {
      if (!entry.visible) continue;
      const state = entry.state();
      const moving = !this.motion.matches && !state.asleep && state.mood !== "still";
      animate ||= moving;
      const pixels = Math.min(512, Math.max(1, Math.round(entry.canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2))));
      const key = `${entry.body}:${state.mood}:${state.alert}:${state.asleep}:${pixels}:${this.motion.matches}`;
      if (!moving && entry.lastFrame === key) continue;
      entry.lastFrame = key;
      const batch = batches.get(key);
      if (batch) batch.entries.push(entry);
      else batches.set(key, { entries: [entry], state, pixels });
    }
    for (const { entries, state, pixels } of batches.values()) {
      const body = entries[0].body;
      let rig = this.rigs.get(body);
      if (!rig) { rig = createRobot(body); this.rigs.set(body, rig); }
      poseRobot(rig, state, time / 1000, this.motion.matches);
      this.scene.add(rig.root);
      this.renderer.setViewport(0, 0, pixels, pixels);
      this.renderer.setScissor(0, 0, pixels, pixels);
      this.renderer.setScissorTest(true);
      this.renderer.render(this.scene, this.camera);
      this.scene.remove(rig.root);
      for (const { canvas, context, host } of entries) {
        if (canvas.width !== pixels || canvas.height !== pixels) { canvas.width = pixels; canvas.height = pixels; }
        context.clearRect(0, 0, pixels, pixels);
        context.drawImage(this.renderer.domElement, 0, 512 - pixels, pixels, pixels, 0, 0, pixels, pixels);
        host.dataset.rendered = "true";
      }
    }
    if (animate) this.invalidate();
  };

  private dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect(); this.resize.disconnect();
    this.motion.removeEventListener("change", this.refresh);
    document.removeEventListener("visibilitychange", this.refresh);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.contextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.contextRestored);
    this.rigs.forEach(rig => rig.dispose()); this.rigs.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}

let shared: MascotRenderer | undefined;
export function mountMascot(canvas: HTMLCanvasElement, host: HTMLElement, robot: ComposerStyle, state: () => MascotState) {
  try {
    shared ??= new MascotRenderer();
    return shared.add(canvas, host, robot, state);
  } catch {
    // Disabled/unsupported WebGL must never take down the chat UI.
    return { dispose: () => {}, invalidate: () => {} };
  }
}
