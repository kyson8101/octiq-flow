// Agent World — 3D office renderer.
//
// The Agent World view used to be a grid of DOM "rooms" with agent cards dropped
// into each. This module replaces that floor with a small three.js scene: the
// office art (office_background.png) is a flat ground plane, and every agent is a
// billboard SPRITE — a flat PNG that always faces the camera — standing on the
// floor. When an agent's state changes it WALKS to the matching zone (Foyer,
// Work area, Meeting Room, Dining), like an NPC sliding across the floor.
//
// Names + speech bubbles are NOT drawn in 3D (text would blur). Instead each
// agent gets an HTML label in an overlay layer above the canvas; every frame we
// project the sprite's head to screen coordinates and move the label there. So
// the bubble/name styling (and the per-state colors) stay the crisp DOM ones.
//
// This module owns ONLY rendering. agentworld.js decides *which* agents exist and
// *what* each is doing, then hands a plain list to syncWorld(). Clicking a sprite
// calls that agent's onClick (jump to / peek its terminal).
import * as THREE from "/vendor/three.module.js";

// ---- Scene tuning ---------------------------------------------------------
// Nudge these if the framing feels off. The floor is the 16:9 office art laid
// flat; the camera looks down at it from the front at a 3/4 angle.
const PLANE_W = 16; // floor width in world units (16:9 with PLANE_D)
const PLANE_D = 9; // floor depth in world units
const FOV = 32; // camera vertical field of view (degrees) — lower = flatter, less skew
const ELEV_DEG = 66; // camera angle above the floor (90 = straight down) — more top-down
const FRAME_PAD = 1.12; // leave this much slack around the floor when fitting
const SPRITE_H = 1.7; // avatar height in world units (feet on the floor)
const WALK_SPEED = 3.4; // how fast an avatar walks, world units per second
const ARRIVE_EPS = 0.015; // "close enough" distance to stop walking
const DPR_CAP = 2; // cap device pixel ratio so big retina screens stay smooth

// Zone anchor points over the office art, in image UV space
// (u: 0 = left … 1 = right, v: 0 = top … 1 = bottom). `cols` is how many avatars
// stand shoulder-to-shoulder before a new row forms behind them.
const ZONE_UV = {
  foyer: { u: 0.15, v: 0.55, cols: 2 }, // reception / lobby (left)
  work: { u: 0.46, v: 0.6, cols: 3 }, // the desks in the centre
  meeting: { u: 0.76, v: 0.3, cols: 2 }, // meeting room (top-right) — "needs you"
  dining: { u: 0.78, v: 0.82, cols: 2 }, // pantry (bottom-right) — idle break
};
const ENTRANCE_UV = { u: 0.04, v: 0.66 }; // new agents walk in from the door
const SLOT_DX = 1.5; // horizontal gap between standing spots (wide so labels clear)
const SLOT_DZ = 1.5; // depth gap between rows

// ---- Module state ---------------------------------------------------------
let renderer = null;
let scene = null;
let camera = null;
let floorParent = null; // the .aw-floor element we mount into
let canvasEl = null;
let overlayEl = null; // HTML layer holding the labels
let clock = null;
let raf = null;
let resizeObs = null;
let shadowTex = null;
let prefersReducedMotion = false;

// roleId -> THREE.Texture (shared by every agent of that role).
const roleTextures = new Map();
// agentId -> agent render record (sprite, shadow, label, walk state).
const agents = new Map();
// Flat list of sprites for the raycaster (rebuilt on add/remove).
let spriteList = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const projectVec = new THREE.Vector3();

// ---- Geometry helpers -----------------------------------------------------
/** Map an image UV point on the office art to a world (x, z) spot on the floor.
 *  The plane lies on XZ after a -90° X rotation: image left→-x, right→+x; image
 *  top (v=0)→far (-z, the back wall), image bottom (v=1)→near (+z, toward the
 *  camera). So the meeting room (top-right of the art) sits at the back and the
 *  pantry (bottom-right) sits up front, matching the drawn office. */
function uvToWorld(u, v) {
  return { x: (u - 0.5) * PLANE_W, z: (v - 0.5) * PLANE_D };
}

/** The floor spot for the `index`-th of `count` agents in a zone: a centred grid
 *  around the zone anchor so a crowd lines up in neat rows instead of stacking. */
function slotPosition(zoneKey, index, count) {
  const z = ZONE_UV[zoneKey] || ZONE_UV.work;
  const base = uvToWorld(z.u, z.v);
  const cols = z.cols;
  const rows = Math.ceil(count / cols);
  const row = Math.floor(index / cols);
  const inRow = Math.min(cols, count - row * cols); // items on this (maybe last) row
  const col = index % cols;
  return {
    x: base.x + (col - (inRow - 1) / 2) * SLOT_DX,
    z: base.z + (row - (rows - 1) / 2) * SLOT_DZ,
  };
}

/** Group key for placement: every project agent shares the central "work" area
 *  (we no longer split the floor into per-project rooms). */
function zoneKeyOf(zone) {
  return zone.kind === "project" ? "work" : zone.kind;
}

// ---- Textures -------------------------------------------------------------
/** A soft round drop shadow, drawn once on a 2D canvas and reused under every
 *  avatar so each one reads as standing on the floor. */
function makeShadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, "rgba(0,0,0,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Load (and cache) a role's avatar texture. Tries the PNG first; on a 404 it
 *  falls back to the generated SVG character, so a sprite is never blank. */
function roleTexture(roleId, pngUrl, fallbackUrl, onReady) {
  const cached = roleTextures.get(roleId);
  if (cached) {
    if (cached.image && cached.image.width) onReady(cached);
    else cached.userData.waiters.push(onReady);
    return cached;
  }
  const loader = new THREE.TextureLoader();
  const tex = loader.load(
    pngUrl,
    (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      flushWaiters(tex);
    },
    undefined,
    () => {
      // PNG missing → swap in the SVG fallback under the same cache entry.
      loader.load(fallbackUrl, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        tex.image = t.image;
        tex.needsUpdate = true;
        flushWaiters(tex);
      });
    },
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData = { waiters: [onReady] };
  roleTextures.set(roleId, tex);
  return tex;
}

function flushWaiters(tex) {
  const waiters = tex.userData?.waiters || [];
  tex.userData.waiters = [];
  for (const cb of waiters) cb(tex);
}

/** Size a sprite to SPRITE_H tall, keeping the PNG's aspect ratio, with its feet
 *  at the sprite position (center y = 0). */
function sizeSprite(sprite, tex) {
  const img = tex.image;
  const raw = img && img.width ? img.width / img.height : 0.62;
  // Clamp so a stray texture size (e.g. a fallback that rasterized oddly) can
  // never produce a grotesquely wide or thin avatar.
  const aspect = Math.min(0.82, Math.max(0.42, raw));
  sprite.scale.set(SPRITE_H * aspect, SPRITE_H, 1);
  sprite.center.set(0.5, 0); // anchor at the feet
}

// ---- Scene build ----------------------------------------------------------
/** Build the office floor: the art as a flat plane, plus a soft fill so the
 *  scene is never pure black while the texture loads or if it 404s. */
function buildFloor() {
  const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_D);
  const mat = new THREE.MeshBasicMaterial({ color: 0x1a1a1e });
  const floor = new THREE.Mesh(geo, mat);
  floor.rotation.x = -Math.PI / 2; // lay it flat
  scene.add(floor);

  new THREE.TextureLoader().load(
    "/assets/agents/office_background.png",
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    },
    undefined,
    () => {
      // No art on disk → keep the flat fill; the scene still works.
    },
  );
}

/** Place the camera so the whole floor fits, viewed from the front at ELEV_DEG.
 *  Recomputed on every resize so the framing survives any window shape. */
function fitCamera(w, h) {
  const aspect = w / Math.max(1, h);
  camera.aspect = aspect;
  const vFov = THREE.MathUtils.degToRad(FOV);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  // Distance needed so the floor's width and depth both fit the frustum.
  const distW = (PLANE_W * FRAME_PAD) / 2 / Math.tan(hFov / 2);
  const distD = ((PLANE_D + SPRITE_H) * FRAME_PAD) / 2 / Math.tan(vFov / 2);
  const dist = Math.max(distW, distD);
  const elev = THREE.MathUtils.degToRad(ELEV_DEG);
  camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist);
  camera.lookAt(0, SPRITE_H * 0.35, 0);
  camera.updateProjectionMatrix();
}

// ---- Agent records --------------------------------------------------------
/** Build the HTML label (bubble + role chip + name + overhead alert) for one
 *  agent. It carries `aw-agent-<state>` so the existing per-state bubble colors
 *  apply. JS moves it over the sprite's head each frame. */
function buildLabel() {
  const root = document.createElement("div");
  root.className = "aw-label";

  const alert = document.createElement("span");
  alert.className = "aw-alert";
  alert.setAttribute("aria-hidden", "true");

  const bubble = document.createElement("div");
  bubble.className = "aw-bubble";

  const role = document.createElement("span");
  role.className = "aw-role";
  const roleDot = document.createElement("span");
  roleDot.className = "aw-role-dot";
  const roleName = document.createElement("span");
  roleName.className = "aw-role-name";
  role.append(roleDot, roleName);

  const meta = document.createElement("span");
  meta.className = "aw-label-meta";
  meta.append(role);

  root.append(alert, bubble, meta);
  overlayEl.append(root);
  return { root, alert, bubble, roleDot, roleName, state: "", roleId: null };
}

/** Create a fresh agent: a sprite (avatar), its ground shadow, and its label.
 *  It spawns at the door and walks to its slot. */
function addAgent(a) {
  const mat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.userData.agentId = a.id;
  const tex = roleTexture(a.roleId, a.avatarUrl, a.avatarFallbackUrl, (t) => {
    mat.map = t;
    mat.needsUpdate = true;
    sizeSprite(sprite, t);
  });
  if (tex.image && tex.image.width) {
    mat.map = tex;
    sizeSprite(sprite, tex);
  }
  scene.add(sprite);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.5 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  scene.add(shadow);

  const start = uvToWorld(ENTRANCE_UV.u, ENTRANCE_UV.v);
  const rec = {
    id: a.id,
    sprite,
    shadow,
    label: buildLabel(),
    roleId: a.roleId,
    pos: { x: start.x, z: start.z },
    target: { x: start.x, z: start.z },
    facing: 1,
    bob: 0,
    onClick: a.onClick,
  };
  agents.set(a.id, rec);
  rebuildSpriteList();
  return rec;
}

/** Drop an agent whose terminal closed: free its sprite, shadow, and label. */
function removeAgent(rec) {
  scene.remove(rec.sprite);
  rec.sprite.material.dispose();
  scene.remove(rec.shadow);
  rec.shadow.geometry.dispose();
  rec.shadow.material.dispose();
  rec.label.root.remove();
  agents.delete(rec.id);
}

function rebuildSpriteList() {
  spriteList = [...agents.values()].map((r) => r.sprite);
}

/** Update a label's text + state class without rebuilding it. */
function paintLabel(rec, a) {
  const L = rec.label;
  if (L.state !== a.state) {
    if (L.state) L.root.classList.remove(`aw-agent-${L.state}`);
    L.root.classList.add(`aw-agent-${a.state}`);
    L.state = a.state;
  }
  if (L.roleId !== a.roleId) {
    L.roleId = a.roleId;
    L.roleName.textContent = a.roleLabel;
    L.roleDot.style.background = a.roleColor;
  }
  L.alert.textContent = a.alert || "";
  if (L.bubble.textContent !== a.bubble) L.bubble.textContent = a.bubble;
}

// ---- Public API -----------------------------------------------------------
/** Stand up the scene inside the .aw-floor element. Safe to call once per show;
 *  unmountWorld() tears it back down when the view hides. */
export function mountWorld(floorEl) {
  if (renderer) return;
  floorParent = floorEl;
  prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
  canvasEl = renderer.domElement;
  canvasEl.className = "aw-canvas";
  floorParent.append(canvasEl);

  overlayEl = document.createElement("div");
  overlayEl.className = "aw-overlay";
  floorParent.append(overlayEl);

  shadowTex = makeShadowTexture();
  buildFloor();

  const { clientWidth: w, clientHeight: h } = floorParent;
  renderer.setSize(Math.max(1, w), Math.max(1, h), false);
  fitCamera(Math.max(1, w), Math.max(1, h));

  resizeObs = new ResizeObserver(() => {
    const cw = Math.max(1, floorParent.clientWidth);
    const ch = Math.max(1, floorParent.clientHeight);
    renderer.setSize(cw, ch, false);
    fitCamera(cw, ch);
  });
  resizeObs.observe(floorParent);

  canvasEl.addEventListener("click", onCanvasClick);
  canvasEl.addEventListener("pointermove", onCanvasHover);

  clock = new THREE.Clock();
  loop();
}

/** Stop and free everything (called when the view hides). */
export function unmountWorld() {
  if (!renderer) return;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  resizeObs?.disconnect();
  resizeObs = null;
  canvasEl.removeEventListener("click", onCanvasClick);
  canvasEl.removeEventListener("pointermove", onCanvasHover);

  for (const rec of [...agents.values()]) removeAgent(rec);
  for (const tex of roleTextures.values()) tex.dispose();
  roleTextures.clear();
  shadowTex?.dispose();
  shadowTex = null;

  renderer.dispose();
  canvasEl.remove();
  overlayEl.remove();
  renderer = scene = camera = canvasEl = overlayEl = clock = null;
  floorParent = null;
  spriteList = [];
}

/** Reconcile the scene to `list` — the agents that should exist right now.
 *  Each item: { id, roleId, roleLabel, roleColor, avatarUrl, avatarFallbackUrl,
 *  state, zone:{kind,pid}, name, bubble, alert, onClick }. Adds new agents,
 *  drops gone ones, repaints labels, and assigns each a walk target slot. */
export function syncWorld(list) {
  if (!renderer) return;
  const live = new Set(list.map((a) => a.id));
  for (const rec of [...agents.values()]) {
    if (!live.has(rec.id)) removeAgent(rec);
  }

  // Bucket agents by zone so we can lay each zone out in centred rows. Stable
  // sort by id keeps a spot from reshuffling when an unrelated agent joins.
  const buckets = new Map();
  for (const a of list) {
    const key = zoneKeyOf(a.zone);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(a);
  }
  for (const arr of buckets.values()) arr.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  for (const [key, arr] of buckets) {
    arr.forEach((a, i) => {
      let rec = agents.get(a.id);
      if (!rec) rec = addAgent(a);
      rec.onClick = a.onClick;
      paintLabel(rec, a);
      const slot = slotPosition(key, i, arr.length);
      rec.target.x = slot.x;
      rec.target.z = slot.z;
    });
  }
}

// ---- Interaction ----------------------------------------------------------
/** Turn a pointer event into the agent sprite under it, if any. */
function pick(e) {
  const r = canvasEl.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(spriteList, false);
  return hits.length ? hits[0].object.userData.agentId : null;
}

function onCanvasClick(e) {
  const id = pick(e);
  if (!id) return;
  agents.get(id)?.onClick?.();
}

function onCanvasHover(e) {
  canvasEl.style.cursor = pick(e) ? "pointer" : "";
}

// ---- Render loop ----------------------------------------------------------
function loop() {
  raf = requestAnimationFrame(loop);
  const dt = Math.min(0.05, clock.getDelta()); // clamp so a tab-stall never leaps
  const t = clock.elapsedTime;
  const w = canvasEl.clientWidth;
  const h = canvasEl.clientHeight;

  for (const rec of agents.values()) {
    // Walk toward the target slot.
    const dx = rec.target.x - rec.pos.x;
    const dz = rec.target.z - rec.pos.z;
    const dist = Math.hypot(dx, dz);
    let moving = false;
    if (dist > ARRIVE_EPS) {
      if (prefersReducedMotion) {
        rec.pos.x = rec.target.x;
        rec.pos.z = rec.target.z;
      } else {
        const step = Math.min(dist, WALK_SPEED * dt);
        rec.pos.x += (dx / dist) * step;
        rec.pos.z += (dz / dist) * step;
        moving = true;
        if (Math.abs(dx) > 0.05) rec.facing = dx < 0 ? -1 : 1; // face the walk
      }
    }

    // Vertical bob: a step bounce while walking, a soft idle sway otherwise.
    if (prefersReducedMotion) rec.bob = 0;
    else if (moving) rec.bob = Math.abs(Math.sin(t * 9)) * 0.07;
    else rec.bob = Math.sin(t * 2 + rec.pos.x) * 0.015;

    rec.sprite.position.set(rec.pos.x, rec.bob, rec.pos.z);
    const sx = Math.abs(rec.sprite.scale.x) * rec.facing; // mirror to face direction
    rec.sprite.scale.x = sx;
    rec.shadow.position.set(rec.pos.x, 0.012, rec.pos.z);
    const sw = Math.abs(sx) * 0.9;
    rec.shadow.scale.set(sw, SPRITE_H * 0.18, 1);

    // Project the head to screen and move the HTML label there.
    projectVec.set(rec.pos.x, SPRITE_H * 0.98 + rec.bob, rec.pos.z).project(camera);
    if (projectVec.z > 1) {
      rec.label.root.classList.add("aw-hidden");
    } else {
      rec.label.root.classList.remove("aw-hidden");
      const px = (projectVec.x * 0.5 + 0.5) * w;
      const py = (-projectVec.y * 0.5 + 0.5) * h - 8;
      rec.label.root.style.transform = `translate(${px}px, ${py}px) translate(-50%, -100%)`;
      // Nearer agents (smaller NDC z) get a higher z-index, so when two labels
      // overlap the front one wins instead of stacking arbitrarily.
      rec.label.root.style.zIndex = String(Math.round((2 - projectVec.z) * 1000));
    }
  }

  renderer.render(scene, camera);
}
