import { describe, expect, it } from "vitest";
import { carriesUmbrella, robotAtmosphere, weatherAt, IslandRain } from "./weather";
describe("island weather", () => {
  it("shares automatic weather by seed and time and lets a viewer preview rain", () => {
    expect(weatherAt(12, 1000)).toBe(weatherAt(12, 710000));
    expect(weatherAt(12, 1000, "rain")).toBe("rain");
    expect(new Set(Array.from({ length: 50 }, (_, n) => weatherAt(12, n * 720000))).size).toBe(3);
  });
  it("uses umbrellas in rain, folds them for sleep, and frees the extra geometry", () => {
    expect(carriesUmbrella("rain", "walk")).toBe(true);
    expect(carriesUmbrella("rain", "sleep")).toBe(false);
    expect(carriesUmbrella("sunny", "walk")).toBe(false);
    const gear = robotAtmosphere("#99aaff");
    expect(gear.umbrella.children).toHaveLength(2);
    expect(gear.aura.name).toBe("lead-aura");
    expect(gear.aura.visible).toBe(false);
    gear.dispose();
    const rain = new IslandRain();
    rain.update(.1, "rain", 3, 4, true);
    expect(rain.object.visible).toBe(true);
    rain.update(.1, "sunny", 3, 4, false);
    expect(rain.object.visible).toBe(false);
    rain.dispose();
  });
});
