// The island drawn and running: one WebGL canvas, the scenery, every placed
// asset, a robot for every resident, the simulation that moves them, and the
// camera the person turns round it. The page gives it the island and the
// agents' real states and is told what was pressed; everything that changes
// every frame (where a robot is, its pose, its bubble, the name over it) is
// written here and never goes through React.
import {
  ACESFilmicToneMapping, BoxGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight, Fog, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, PCFShadowMap, PerspectiveCamera, Raycaster, RingGeometry, Scene,
  Sprite, SpriteMaterial, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from "three";
import type { Material, Object3D } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AssetCache, assetObject, partBox } from "./assets";
import type { Asset, Island, Plot, Resident, Slot } from "./model";
import { PLAZA_RADIUS, SLOTS, TILE_TOP, cellAt, onCellTile, plotNames, plotToWorld, ringCells } from "./model";
import { NavGrid, type Solid } from "./nav";
import { HIP_HEIGHT, SEATED, createIslandRobot, poseIslandRobot, type RobotRig } from "./robot";
import { IslandSim, type AgentMode, type Bubble, type Places, type Seat } from "./sim";
import { buildScenery, groundHeight, onRect, timeOfDay, type Scenery } from "./world";
import { IslandRain, carriesUmbrella, robotAtmosphere, weatherAt, type WeatherChoice } from "./weather";

const DEG = Math.PI / 180;

export type ViewEvents = {
  /** A robot was pressed, or the ground (null). */
  onPick(key: string | null): void;
  /** The WebGL context went and did not come back; the page draws again. */
  onLost?(): void;
};

type RobotView = {
  atmosphere: ReturnType<typeof robotAtmosphere>;
  rig: RobotRig;
  look: string;
  worn: string;
  shadow: Mesh;
  proxy: Mesh;
  bubble: Sprite;
  bubbleKey: string;
};

type PlacedView = { object: Group; signature: string };

/** Cached textures for speech bubbles, by tone and text. */
class Bubbles {
  private made = new Map<string, { material: SpriteMaterial; aspect: number }>();
  constructor(private colors: () => { decide: string; danger: string }) {}

  /** A bubble's picture, as wide as its words need: a square for a mark or
   *  an emoji, wider for "wanna play?". `aspect` is its width over height. */
  material(bubble: Bubble): { material: SpriteMaterial; aspect: number } | null {
    const key = `${bubble.tone}:${bubble.text}`;
    const held = this.made.get(key);
    if (held) return held;
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const emoji = [...bubble.text].length <= 2 && /\p{Extended_Pictographic}/u.test(bubble.text);
    const font = emoji ? "52px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif" : "700 46px Inter, system-ui, sans-serif";
    ctx.font = font;
    const textWidth = Math.ceil(ctx.measureText(bubble.text).width);
    const width = Math.max(128, Math.min(512, textWidth + 64));
    canvas.width = width;
    canvas.height = 128;
    const { decide, danger } = this.colors();
    const fill = bubble.tone === "decide" ? decide : bubble.tone === "danger" ? danger
      : bubble.tone === "sleep" ? "#dfe9ff" : "#ffffff";
    const ink = bubble.tone === "decide" || bubble.tone === "danger" ? "#ffffff" : "#33424d";
    ctx.fillStyle = fill;
    ctx.strokeStyle = "rgba(30, 40, 50, 0.18)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(14, 12, width - 28, 84, 34);
    ctx.moveTo(width / 2 - 12, 94);
    ctx.lineTo(width / 2, 116);
    ctx.lineTo(width / 2 + 12, 94);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(bubble.text, width / 2, emoji ? 58 : 56, width - 40);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const made = { material: new SpriteMaterial({ map: texture, depthWrite: false, transparent: true }), aspect: width / 128 };
    this.made.set(key, made);
    return made;
  }

  dispose() {
    for (const { material } of this.made.values()) {
      material.map?.dispose();
      material.dispose();
    }
    this.made.clear();
  }
}

/** A colour token of the page, for the few things the 3D world says in the
 *  app's own language: a bubble that asks the person is the decision colour. */
function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export class IslandView {
  private weatherChoice: WeatherChoice = "auto";
  private rain = new IslandRain();
  setWeather(choice: WeatherChoice) { this.weatherChoice = choice; this.hourAt = -1; }
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(38, 1, 0.1, 1400);
  private controls: OrbitControls;
  private hemi = new HemisphereLight("#eef6ff", "#c8b58a", 1.4);
  private sun = new DirectionalLight("#fff4e2", 2.6);
  private scenery: Scenery | null = null;
  private sceneryKey = "";
  private cache = new AssetCache();
  private placed = new Map<string, PlacedView>();
  private robots = new Map<string, RobotView>();
  private proxies = new Group();
  private sim: IslandSim;
  private nav: NavGrid;
  private island: Island | null = null;
  private residents: Resident[] = [];
  private bubbles: Bubbles;
  private frame = 0;
  private last = 0;
  private clock = 0;
  private hourAt = -1;
  private hour = 12;
  /** An hour to show instead of the clock's (the preview page's slider). */
  private hourOverride: number | null = null;
  private sky = timeOfDay(12);
  private selected: string | null = null;
  /** Whether the camera goes where the selected robot goes. Moving the view
   *  by hand stops it; choosing a robot again starts it. */
  private following = false;
  /** The movement keys held down. */
  private held = new Set<string>();
  private flight: { from: Vector3; to: Vector3; fromDistance: number; toDistance: number; start: number; seconds: number } | null = null;
  private labels: { hover: HTMLElement; selected: HTMLElement } | null = null;
  private hovered: string | null = null;
  private pointer = new Vector2();
  private pointerAt: { x: number; y: number; time: number } | null = null;
  private raycaster = new Raycaster();
  private faded = new Map<Mesh, Material | Material[]>();
  private fadedMaterials = new Map<Material, Material>();
  private ring: Mesh;
  private shadowGeometry = new CircleGeometry(0.42, 24);
  private shadowMaterial: MeshBasicMaterial;
  // What a press finds a robot by: a little bigger than the robot, so one
  // is easy to pick out from far away too.
  private proxyGeometry = new BoxGeometry(1.3, 1.6, 1.3);
  private resize: ResizeObserver;
  private firstLoad = true;
  private lost = false;
  private canvas: HTMLCanvasElement;
  /** The cells the scenery drew a tile on, as "q,r". */
  private tiled = new Set<string>();

  /** Draws into a canvas of its own, put in `host` and taken out again by
   *  `dispose`: a canvas whose context was let go cannot be drawn into again,
   *  so a view made twice in a row (React's StrictMode) must never share one. */
  constructor(private host: HTMLElement, private events: ViewEvents, private reducedMotion = false) {
    const canvas = document.createElement("canvas");
    canvas.className = "island-canvas";
    canvas.setAttribute("aria-hidden", "true");
    this.canvas = canvas;
    host.prepend(canvas);
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    } catch (problem) {
      canvas.remove();
      throw problem;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.scene.fog = new Fog("#e8f3fb", 90, 420);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.proxies, this.rain.object);
    this.proxies.visible = false;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    // Always looking down from above, so a roofless room shows what is in it.
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = 1.18;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 140;
    this.controls.zoomSpeed = 0.8;
    this.controls.rotateSpeed = 0.6;
    this.controls.addEventListener("start", () => { this.flight = null; });
    // The plaza, the agents' ring and the 波特's homes on the next one, all
    // in view; scrolling in finds a robot, scrolling out the whole island.
    this.camera.position.set(22, 31, 33);
    this.controls.target.set(0, 0, 0);

    this.nav = new NavGrid(40);
    this.sim = new IslandSim(this.nav, { seats: [], plots: new Map(), tree: { x: 0, z: 0 }, plaza: PLAZA_RADIUS, radius: 40 });
    this.bubbles = new Bubbles(() => ({ decide: token("--decide", "#3d7bd9"), danger: token("--danger", "#d6544b") }));
    this.shadowMaterial = new MeshBasicMaterial({ color: "#1e2a24", transparent: true, opacity: 0.22, depthWrite: false });
    this.ring = new Mesh(new RingGeometry(0.55, 0.68, 40), new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);

    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.start();
  }

  /** Two elements the view moves itself: the name over the robot under the
   *  pointer, and over the one being followed. */
  setLabels(hover: HTMLElement, selected: HTMLElement) {
    this.labels = { hover, selected };
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
  }

  /** Show the island at this hour instead of the person's own; null goes
   *  back to the clock. */
  setHourOverride(hour: number | null) {
    this.hourOverride = hour;
    this.hourAt = -1;
  }

  private fit() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // A tall, narrow screen (a phone) gets a wider lens, so it sees about as
    // much of the island side to side as a wide one does.
    this.camera.fov = this.camera.aspect < 1 ? Math.min(62, 38 / Math.sqrt(this.camera.aspect)) : 38;
    this.camera.updateProjectionMatrix();
  }

  private start() {
    if (this.frame || this.lost || document.hidden) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.draw);
  }

  private stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.stop();
    this.events.onLost?.();
  };

  // --- the island's data --------------------------------------------------

  setIsland(island: Island, residents: Resident[]) {
    const before = new Set(this.residents.map((r) => r.key));
    this.island = island;
    this.residents = residents;
    const assets = new Map(island.assets.map((asset) => [asset.id, asset]));
    const plots = new Map(island.plots.map((plot) => [plot.id, plot]));

    const sceneryKey = JSON.stringify([
      island.radius, island.seed,
      island.plots.map((p) => [p.id, p.q, p.r, p.x, p.z, p.facing, p.radius, p.owner.kind,
        plotNames(p, residents)]),
    ]);
    if (sceneryKey !== this.sceneryKey || !this.scenery) {
      if (this.scenery) {
        this.scene.remove(this.scenery.group);
        this.scenery.dispose();
      }
      this.scenery = buildScenery({ radius: island.radius, seed: island.seed, plots: island.plots, residents, shadows: true });
      this.scene.add(this.scenery.group);
      this.sceneryKey = sceneryKey;
      const outermost = Math.max(2, ...island.plots.map((plot) => plot.ring));
      this.tiled = new Set();
      for (let k = 1; k <= outermost; k++) for (const [q, r] of ringCells(k)) this.tiled.add(`${q},${r}`);
      const reach = island.radius + 8;
      const shadow = this.sun.shadow.camera;
      shadow.left = -reach; shadow.right = reach; shadow.top = reach; shadow.bottom = -reach;
      shadow.near = 1; shadow.far = 260;
      shadow.updateProjectionMatrix();
      this.controls.maxDistance = Math.max(60, island.radius * 2.6);
    }
    const scenery = this.scenery;
    scenery.setLetters(island.wishes.filter((w) => w.state === "open").length);

    // Placements: made again only when what they show, or where, changed.
    const keep = new Set<string>();
    const solids: Solid[] = [...scenery.solids];
    const seats: Seat[] = [...scenery.seats];
    for (const placement of island.placed) {
      const plot = plots.get(placement.plot);
      const asset = assets.get(placement.asset);
      if (!plot || !asset || asset.kind === "accessory") continue;
      keep.add(placement.id);
      const signature = [asset.id, asset.rev, placement.x, placement.z, placement.y, placement.turn, plot.x, plot.z, plot.facing].join(":");
      let view = this.placed.get(placement.id);
      if (!view || view.signature !== signature) {
        if (view) this.scene.remove(view.object);
        const object = assetObject(this.cache.get(asset), { shadows: true });
        const at = plotToWorld(plot, placement.x, placement.z);
        // On the tile, which stands a little over the paths.
        object.position.set(at.x, TILE_TOP + placement.y, at.z);
        object.rotation.y = (plot.facing + placement.turn) * DEG;
        object.userData.placement = placement.id;
        object.userData.kind = asset.kind;
        this.scene.add(object);
        view = { object, signature };
        this.placed.set(placement.id, view);
      }
      solids.push(...placementSolids(asset, plot, placement));
      const seat = placementSeat(asset, plot, placement);
      if (seat) seats.push(seat);
    }
    for (const [id, view] of [...this.placed]) {
      if (keep.has(id)) continue;
      this.scene.remove(view.object);
      this.placed.delete(id);
    }

    this.nav = new NavGrid(island.radius, solids, 1.5, scenery.walkways);
    const places: Places = {
      seats,
      plots: new Map(residents.filter((r) => r.plot).map((r) => {
        const plot = r.plot!;
        const center = plotToWorld(plot, 0, 0);
        // Just inside the tile's front edge, which faces the plaza.
        const front = plotToWorld(plot, 0, (plot.radius * Math.sqrt(3)) / 2 - 1.2);
        return [r.key, {
          id: plot.id, center, door: front,
          front: { ...front, face: plot.facing * DEG },
        }];
      })),
      tree: { x: 0, z: 0 },
      plaza: PLAZA_RADIUS,
      radius: island.radius,
      playground: scenery.playground.anchors,
    };
    const now = this.clock;
    this.sim.reset(this.nav, places, residents, now);

    // Bots that came after the island was first drawn step off the boat.
    if (!this.firstLoad) {
      for (const resident of residents) {
        if (before.has(resident.key) || resident.owner.kind !== "bot") continue;
        this.sim.landAt(resident.key, scenery.dock, now);
      }
    } else {
      this.frameEveryone(island.plots);
    }
    this.firstLoad = false;

    // Robots: made again when their look, or what they wear, changed.
    const wornIds = new Set<string>();
    for (const resident of residents) {
      const look = JSON.stringify({ ...resident.look, worn: undefined });
      const wornAssets = SLOTS.map((slot) => {
        const id = resident.look.worn[slot];
        const asset = id ? assets.get(id) : undefined;
        if (asset && asset.kind === "accessory") wornIds.add(asset.id);
        return asset && asset.kind === "accessory" ? `${slot}:${asset.id}:${asset.rev}` : "";
      }).join("|");
      let view = this.robots.get(resident.key);
      if (view && view.look !== look) {
        this.dropRobot(resident.key);
        view = undefined;
      }
      if (!view) view = this.addRobot(resident.key, resident, look);
      view.atmosphere.aura.visible = !!resident.agent?.leader;
      if (view.worn !== wornAssets) {
        for (const slot of SLOTS) {
          const id = resident.look.worn[slot];
          const asset = id ? assets.get(id) : undefined;
          view.rig.wear(slot, asset && asset.kind === "accessory" ? this.accessory(asset, slot) : null);
        }
        view.worn = wornAssets;
      }
    }
    for (const key of [...this.robots.keys()]) {
      if (!residents.some((r) => r.key === key)) this.dropRobot(key);
    }
    if (this.selected && !this.robots.has(this.selected)) this.select(null);
    this.cache.prune(new Set([...island.placed.map((p) => p.asset), ...wornIds]));
  }

  private accessory(asset: Asset, slot: Slot): Object3D {
    const object = assetObject(this.cache.get(asset), { shadows: false });
    object.name = `worn-${slot}`;
    return object;
  }

  private addRobot(key: string, resident: Resident, look: string): RobotView {
    const rig = createIslandRobot(resident.look);
    rig.root.userData.robot = key;
    const shadow = new Mesh(this.shadowGeometry, this.shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    const proxy = new Mesh(this.proxyGeometry, this.shadowMaterial);
    proxy.userData.robot = key;
    const bubble = new Sprite();
    bubble.scale.set(0.6, 0.6, 1);
    bubble.visible = false;
    this.scene.add(rig.root, shadow, bubble);
    this.proxies.add(proxy);
    const atmosphere = robotAtmosphere(resident.look.trim);
    rig.root.add(atmosphere.umbrella, atmosphere.aura);
    const view: RobotView = { rig, atmosphere, look, worn: "", shadow, proxy, bubble, bubbleKey: "" };
    this.robots.set(key, view);
    return view;
  }

  private dropRobot(key: string) {
    const view = this.robots.get(key);
    if (!view) return;
    this.scene.remove(view.rig.root, view.shadow, view.bubble);
    this.proxies.remove(view.proxy);
    view.rig.dispose();
    view.atmosphere.dispose();
    this.robots.delete(key);
  }

  setModes(modes: ReadonlyMap<string, AgentMode>) {
    this.sim.setModes(modes, this.clock);
  }

  event(kind: "wish" | "gift", key: string) {
    this.sim.event(kind, key, this.clock);
  }

  /** A home changed: its 波特 build on it together. */
  homeChanged(plotId: string) {
    this.sim.buildHome(plotId, this.clock);
  }

  describe(key: string): string | null {
    return this.sim.describe(key);
  }

  /** How bored a robot is (0 to 1), whether work just made it happy, and
   *  what it is saying right now. */
  mood(key: string): { boredom: number; excited: boolean; said: string | null } | null {
    const mood = this.sim.mood(key);
    return mood ? { ...mood, said: this.sim.said(key) } : null;
  }

  /** Follow a robot (and fly to it), or let go (null). */
  select(key: string | null, fly = true) {
    this.selected = key;
    this.following = !!key;
    this.ring.visible = !!key;
    if (!key) {
      this.restoreFaded();
      if (this.labels) this.labels.selected.hidden = true;
      return;
    }
    const robot = this.sim.robots.get(key);
    if (robot && fly) this.flyTo(new Vector3(robot.x, 0.6, robot.z), 13);
  }

  /** The first view of an island: everyone's plot and the plaza in the
   *  frame, seen from the usual corner. Only before the person has moved the
   *  camera, which is the first time the island is drawn. */
  private frameEveryone(plots: readonly Plot[]) {
    const points = [{ x: 0, z: 0 }, ...plots.map((plot) => ({ x: plot.x, z: plot.z }))];
    const center = {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      z: points.reduce((sum, p) => sum + p.z, 0) / points.length,
    };
    // As far out as the furthest plot's far edge, plus a little.
    const reach = Math.max(14, ...points.map((p) => Math.hypot(p.x - center.x, p.z - center.z) + 7));
    const distance = Math.min(this.controls.maxDistance, reach * 1.85);
    const offset = new Vector3(22, 31, 33).setLength(distance);
    this.controls.target.set(center.x, 0, center.z);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  /** Back to the whole island. */
  recenter() {
    this.select(null);
    this.flyTo(new Vector3(0, 0, 0), Math.max(46, (this.island?.radius ?? 40) * 1.15));
  }

  private flyTo(target: Vector3, distance: number) {
    const fromDistance = this.camera.position.distanceTo(this.controls.target);
    if (this.reducedMotion) {
      const offset = this.camera.position.clone().sub(this.controls.target).setLength(distance);
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(offset);
      this.flight = null;
      return;
    }
    this.flight = { from: this.controls.target.clone(), to: target, fromDistance, toDistance: distance, start: this.clock, seconds: 0.9 };
  }

  // --- pointer --------------------------------------------------------------

  private robotAt(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.proxies.updateMatrixWorld(true);
    const hit = this.raycaster.intersectObjects(this.proxies.children, false)[0];
    return (hit?.object.userData.robot as string | undefined) ?? null;
  }

  private onDown = (event: PointerEvent) => {
    this.pointerAt = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private onUp = (event: PointerEvent) => {
    const down = this.pointerAt;
    this.pointerAt = null;
    if (!down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > 6 || performance.now() - down.time > 500) return;
    this.events.onPick(this.robotAt(event.clientX, event.clientY));
  };

  private onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.buttons) return;
    const key = this.robotAt(event.clientX, event.clientY);
    this.hovered = key;
    this.canvas.style.cursor = key ? "pointer" : "";
  };

  private onLeave = () => {
    this.hovered = null;
    this.canvas.style.cursor = "";
  };

  // --- the frame ------------------------------------------------------------

  private draw = (time: number) => {
    this.frame = requestAnimationFrame(this.draw);
    const dt = Math.min(0.1, Math.max(0, (time - this.last) / 1000));
    this.last = time;
    this.clock += dt;
    const t = this.clock;

    // The hour is the person's own clock, read once a second.
    if (Math.floor(t) !== this.hourAt) {
      this.hourAt = Math.floor(t);
      const date = new Date();
      this.hour = this.hourOverride ?? date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
      this.sky = timeOfDay(this.hour);
      this.sun.position.copy(this.sky.sun);
      this.sun.color.copy(this.sky.sunColor);
      const weather = weatherAt(this.island?.seed ?? 1, Date.now(), this.weatherChoice);
      this.sun.intensity = this.sky.sunIntensity * (weather === "rain" ? .35 : weather === "cloudy" ? .65 : 1);
      this.hemi.intensity = this.sky.hemi;
      this.hemi.color.copy(new Color("#eef6ff").lerp(new Color("#7f93c9"), this.sky.night));
      (this.scene.fog as Fog).color.copy(this.sky.horizon);
    }

    this.sim.update(dt, t, this.hour);
    const calm = this.reducedMotion;
    const radius = this.island?.radius ?? 40;
    const weather = weatherAt(this.island?.seed ?? 1, Date.now(), this.weatherChoice);
    this.rain.update(dt, weather, this.controls.target.x, this.controls.target.z, calm);
    this.scenery?.playground.setMotion(this.sim.motion);
    for (const [key, view] of this.robots) {
      const robot = this.sim.robots.get(key);
      if (!robot) continue;
      const ground = this.groundAt(robot.x, robot.z, radius);
      const sitting = SEATED.has(robot.pose);
      // On a seat, a swing or the slide it is exactly where the simulation
      // says; anywhere else it stands on the ground under it.
      const y = robot.perched ? Math.max(robot.y, ground) : ground;
      view.rig.root.position.set(robot.x, y, robot.z);
      view.rig.root.rotation.y = robot.heading;
      const act = robot.plan.act;
      const atDesk = act.kind === "work" && act.seat?.kind === "desk" && !robot.path.length;
      poseIslandRobot(view.rig, robot.pose, t + (hashOf(key) % 97) * 0.13, {
        stride: robot.stride, calm, console: !atDesk, lean: robot.lean, bored: robot.boredom > 0.72,
      });
      const umbrella = carriesUmbrella(weather, robot.pose);
      view.atmosphere.umbrella.visible = umbrella;
      view.atmosphere.umbrella.position.y = sitting ? -HIP_HEIGHT : 0;
      if (umbrella) {
        view.rig.arms[1].shoulder.rotation.set(-.5, 0, -.35);
        view.rig.arms[1].elbow.rotation.x = -.7;
      }
      view.atmosphere.aura.scale.setScalar(calm ? 1 : 1 + Math.sin(t * 1.6) * .06);
      view.atmosphere.aura.position.y = ground - y + .035;
      view.shadow.position.set(robot.x, ground + 0.025, robot.z);
      view.shadow.scale.setScalar(robot.perched && y - ground > 0.15 ? 0.7 : 1);
      view.proxy.position.set(robot.x, y + (sitting ? 0.45 : 0.6), robot.z);
      view.proxy.rotation.y = robot.heading;
      const bubble = robot.bubble;
      if (bubble) {
        const bubbleKey = `${bubble.tone}:${bubble.text}`;
        if (bubbleKey !== view.bubbleKey) {
          const made = this.bubbles.material(bubble);
          if (made) {
            view.bubble.material = made.material;
            view.bubble.scale.set(0.6 * made.aspect, 0.6, 1);
          }
          view.bubbleKey = bubbleKey;
        }
        const head = y + (sitting ? 1.0 - HIP_HEIGHT : 1.0);
        const bob = calm ? 0 : Math.sin(t * 2.4 + hashOf(key)) * 0.03;
        view.bubble.position.set(robot.x, head + 0.55 + bob, robot.z);
        view.bubble.visible = true;
      } else {
        view.bubble.visible = false;
      }
    }

    this.scenery?.update(calm ? 0 : t, this.sky.night, this.sky, this.sky.sea);

    // Following: the camera's target goes with the robot.
    if (this.flight) {
      const progress = Math.min(1, (t - this.flight.start) / this.flight.seconds);
      const ease = 1 - Math.pow(1 - progress, 3);
      const target = this.flight.from.clone().lerp(this.flight.to, ease);
      const distance = this.flight.fromDistance + (this.flight.toDistance - this.flight.fromDistance) * ease;
      const offset = this.camera.position.clone().sub(this.controls.target).setLength(distance);
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(offset);
      if (progress >= 1) this.flight = null;
    }
    // W, A, S and D move the view over the island, the way the camera
    // faces; moving it lets go of a robot being followed.
    this.panByKeys(dt);
    const chosen = this.selected ? this.sim.robots.get(this.selected) : undefined;
    if (chosen) {
      if (this.following) {
        const goal = new Vector3(chosen.x, 0.6, chosen.z);
        if (this.flight) this.flight.to.copy(goal);
        else {
          const step = goal.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 3));
          this.controls.target.add(step);
          this.camera.position.add(step);
        }
      }
      this.ring.position.set(chosen.x, this.groundAt(chosen.x, chosen.z, radius) + 0.03, chosen.z);
      this.ring.scale.setScalar(calm ? 1 : 1 + Math.sin(t * 2) * 0.04);
      if (Math.floor(t * 8) !== Math.floor((t - dt) * 8)) this.fadeOccluders(chosen.x, chosen.z);
    }
    // Keep the target on the island.
    const target = this.controls.target;
    const reach = Math.hypot(target.x, target.z);
    if (reach > radius + 4) target.multiplyScalar((radius + 4) / reach);
    target.y = Math.max(0, Math.min(2, target.y));

    this.controls.update();
    this.placeLabels();
    this.renderer.render(this.scene, this.camera);
  };

  // --- keys -------------------------------------------------------------------

  private onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!PAN_KEYS.has(key) || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
    this.held.add(key);
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.held.delete(event.key.toLowerCase());
    if (event.key === "Shift") this.held.delete("shift");
  };

  private onBlur = () => this.held.clear();

  /** Move the view by the keys held: along the ground, the way the camera
   *  looks, faster the further out it is and faster still with Shift. */
  private panByKeys(dt: number) {
    if (!this.held.size) return;
    const forward = this.controls.target.clone().sub(this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) return;
    forward.normalize();
    const right = new Vector3(-forward.z, 0, forward.x);
    const move = new Vector3();
    if (this.held.has("w")) move.add(forward);
    if (this.held.has("s")) move.sub(forward);
    if (this.held.has("d")) move.add(right);
    if (this.held.has("a")) move.sub(right);
    if (move.lengthSq() < 1e-6) return;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const speed = Math.min(28, Math.max(4, distance * 0.4)) * (this.shift ? 2.2 : 1);
    move.normalize().multiplyScalar(speed * dt);
    this.controls.target.add(move);
    this.camera.position.add(move);
    this.flight = null;
    this.following = false;
  }

  private get shift() {
    return this.held.has("shift");
  }

  /** The ground under a point: the land and beach, or the dock's deck. */
  /** The ground under a point: a tile of the honeycomb (the plaza is one),
   *  the paths between them, the beach, or the dock's deck. */
  private groundAt(x: number, z: number, radius: number): number {
    const scenery = this.scenery;
    if (scenery && onRect(x, z, scenery.walkways)) return scenery.deck;
    const [q, r] = cellAt(x, z);
    if (q === 0 && r === 0) return Math.hypot(x, z) < PLAZA_RADIUS - 0.6 ? TILE_TOP : 0;
    if (this.tiled.has(`${q},${r}`) && onCellTile(x, z)) return TILE_TOP;
    return groundHeight(Math.hypot(x, z), radius);
  }

  private placeLabels() {
    if (!this.labels) return;
    const place = (element: HTMLElement, key: string | null) => {
      const robot = key ? this.sim.robots.get(key) : undefined;
      const view = key ? this.robots.get(key) : undefined;
      if (!robot || !view) { element.hidden = true; return; }
      // Under its feet, where what it says over its head never covers it.
      const sitting = SEATED.has(robot.pose);
      const feet = view.rig.root.position.y - (sitting ? HIP_HEIGHT : 0);
      const point = new Vector3(robot.x, feet, robot.z).project(this.camera);
      if (point.z > 1) { element.hidden = true; return; }
      const rect = this.canvas.getBoundingClientRect();
      const x = (point.x * 0.5 + 0.5) * rect.width;
      const y = (-point.y * 0.5 + 0.5) * rect.height;
      element.hidden = false;
      const name = this.residents.find((r) => r.key === key)?.name ?? "";
      if (element.textContent !== name) element.textContent = name;
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 6px)`;
    };
    place(this.labels.selected, this.selected);
    place(this.labels.hover, this.hovered && this.hovered !== this.selected ? this.hovered : null);
  }

  /** Whatever stands between the camera and the followed robot is drawn
   *  faint, so the person always sees who they are watching. */
  private fadeOccluders(x: number, z: number) {
    const head = new Vector3(x, 0.8, z);
    const from = this.camera.position.clone();
    const direction = head.clone().sub(from);
    const distance = direction.length();
    this.raycaster.set(from, direction.normalize());
    this.raycaster.far = distance - 0.4;
    const objects = [...this.placed.values()].map((v) => v.object);
    const hits = this.raycaster.intersectObjects(objects, true);
    this.raycaster.far = Infinity;
    const now = new Set<Mesh>();
    for (const hit of hits) {
      const holder = hit.object.parent;
      if (!holder) continue;
      for (const child of holder.children) if (child instanceof Mesh) now.add(child);
    }
    for (const [mesh, material] of [...this.faded]) {
      if (now.has(mesh)) continue;
      mesh.material = material;
      this.faded.delete(mesh);
    }
    for (const mesh of now) {
      if (this.faded.has(mesh)) continue;
      this.faded.set(mesh, mesh.material);
      mesh.material = this.fadedOf(mesh.material as Material);
    }
  }

  private fadedOf(material: Material): Material {
    let faded = this.fadedMaterials.get(material);
    if (!faded) {
      faded = material.clone();
      faded.transparent = true;
      faded.opacity = 0.2;
      faded.depthWrite = false;
      this.fadedMaterials.set(material, faded);
    }
    return faded;
  }

  private restoreFaded() {
    for (const [mesh, material] of this.faded) mesh.material = material;
    this.faded.clear();
  }

  dispose() {
    this.stop();
    this.resize.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.controls.dispose();
    this.restoreFaded();
    for (const key of [...this.robots.keys()]) this.dropRobot(key);
    for (const view of this.placed.values()) this.scene.remove(view.object);
    this.placed.clear();
    this.cache.dispose();
    this.scenery?.dispose();
    this.bubbles.dispose();
    this.rain.dispose();
    this.fadedMaterials.forEach((m) => m.dispose());
    this.shadowGeometry.dispose();
    this.shadowMaterial.dispose();
    this.proxyGeometry.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as Material).dispose();
    this.renderer.dispose();
    // Let the context go now rather than whenever the canvas is collected:
    // a browser keeps only a handful, and the terminals need theirs.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

const PAN_KEYS = new Set(["w", "a", "s", "d", "shift"]);

/** Is a key going into something being typed in? Then it is not the view's. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  return !!element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

function hashOf(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 1000;
}

/** What of a placed asset a robot cannot walk through: every part at
 *  walking height that is more than a floor. */
export function placementSolids(asset: Asset, plot: Plot, placement: { x: number; z: number; y: number; turn: number }): Solid[] {
  const out: Solid[] = [];
  const yaw = (plot.facing + placement.turn) * DEG;
  const turn = placement.turn * DEG;
  for (const part of asset.parts) {
    const box = partBox(part);
    const bottom = box.min[1] + placement.y;
    const top = box.max[1] + placement.y;
    if (bottom > 0.55 || top < 0.16) continue;
    const cx = (box.min[0] + box.max[0]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    // The part's centre on the plot, then in the world.
    const px = placement.x + cx * Math.cos(turn) + cz * Math.sin(turn);
    const pz = placement.z - cx * Math.sin(turn) + cz * Math.cos(turn);
    const at = plotToWorld(plot, px, pz);
    out.push({ cx: at.x, cz: at.z, hx: (box.max[0] - box.min[0]) / 2, hz: (box.max[2] - box.min[2]) / 2, yaw });
  }
  return out;
}

/** Where a robot sits, sleeps or works on a placed asset: its spot, or the
 *  island's guess for an asset that gave none. */
export function placementSeat(asset: Asset, plot: Plot, placement: { id: string; x: number; z: number; y: number; turn: number }): Seat | null {
  const use = asset.use;
  if (!use || use === "none") return null;
  if (asset.kind !== "furniture" && asset.kind !== "decor") return null;
  let spot = asset.spot;
  if (!spot) {
    const parts = asset.parts.map(partBox);
    const maxZ = Math.max(...parts.map((b) => b.max[2]));
    const low = parts.filter((b) => b.max[1] < 0.9);
    const seatTop = low.length ? Math.max(...low.map((b) => b.max[1])) : 0.3;
    spot = use === "desk"
      ? { at: [0, 0, maxZ + 0.45], face: 180 }
      : { at: [0, seatTop + 0.03, 0], face: 0 };
  }
  const turn = placement.turn * DEG;
  const [sx, sy, sz] = spot.at;
  const px = placement.x + sx * Math.cos(turn) + sz * Math.sin(turn);
  const pz = placement.z - sx * Math.sin(turn) + sz * Math.cos(turn);
  const at = plotToWorld(plot, px, pz);
  return {
    key: `${placement.id}:${asset.id}`,
    kind: use === "desk" ? "desk" : use === "bed" ? "bed" : "seat",
    x: at.x, z: at.z, y: TILE_TOP + placement.y + sy,
    face: (plot.facing + placement.turn + spot.face) * DEG,
    plot: plot.id,
    name: asset.name,
  };
}
