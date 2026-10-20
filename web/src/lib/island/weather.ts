// Simulated island weather, shared by seed and wall-clock time. It is not a
// real-world forecast and makes no network requests or model calls.
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, PointsMaterial, RingGeometry, SphereGeometry, CylinderGeometry, DoubleSide, AdditiveBlending } from "three";
export type Weather = "sunny" | "cloudy" | "rain";
export type WeatherChoice = "auto" | Weather;
export function weatherAt(seed: number, now: number, choice: WeatherChoice = "auto"): Weather {
  if (choice !== "auto") return choice;
  let hash = Math.imul(seed ^ Math.floor(now / 720000), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  const value = (hash >>> 0) % 10;
  return value < 5 ? "sunny" : value < 8 ? "cloudy" : "rain";
}
export function carriesUmbrella(weather: Weather, pose: string): boolean { return weather === "rain" && pose !== "sleep"; }

export function robotAtmosphere(color: string) {
  const umbrella = new Group(); umbrella.name = "rain-umbrella"; umbrella.visible = false;
  const canopy = new Mesh(new SphereGeometry(.72, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new MeshStandardMaterial({ color, roughness: .65, side: DoubleSide }));
  canopy.scale.y = .45; canopy.position.set(.26, 1.46, .08); umbrella.add(canopy);
  const shaft = new Mesh(new CylinderGeometry(.016, .016, .92, 8), new MeshStandardMaterial({ color: "#4b5967", metalness: .5 }));
  shaft.position.set(.26, 1, .08); umbrella.add(shaft);
  const aura = new Mesh(new RingGeometry(.58, .8, 48), new MeshBasicMaterial({ color: "#ffd687", transparent: true, opacity: .42, depthWrite: false, side: DoubleSide, blending: AdditiveBlending }));
  aura.name = "lead-aura"; aura.rotation.x = -Math.PI / 2; aura.position.y = .035; aura.visible = false;
  return { umbrella, aura, dispose() {
    for (const object of [canopy, shaft, aura]) { object.geometry.dispose(); (object.material as MeshBasicMaterial).dispose(); }
  } };
}

export class IslandRain {
  readonly object: Points;
  private positions = new Float32Array(450 * 3);
  constructor() {
    for (let i = 0; i < 450; i++) {
      this.positions[i * 3] = ((i * .61803398875) % 1 - .5) * 70;
      this.positions[i * 3 + 1] = ((i * .38196601125) % 1) * 24;
      this.positions[i * 3 + 2] = ((i * .754877666) % 1 - .5) * 70;
    }
    const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    this.object = new Points(geometry, new PointsMaterial({ color: "#c6e3fa", size: .09, transparent: true, opacity: .65, depthWrite: false }));
    this.object.name = "island-rain"; this.object.visible = false;
  }
  update(dt: number, weather: Weather, x: number, z: number, calm: boolean) {
    this.object.visible = weather === "rain"; this.object.position.set(x, 0, z);
    if (weather !== "rain" || calm) return;
    const points = this.object.geometry.getAttribute("position");
    for (let i = 0; i < points.count; i++) { const y = points.getY(i) - dt * 13; points.setY(i, y < .2 ? 24 : y); }
    points.needsUpdate = true;
  }
  dispose() { this.object.geometry.dispose(); (this.object.material as PointsMaterial).dispose(); }
}
