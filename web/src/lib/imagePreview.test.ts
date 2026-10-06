import { describe, expect, it, vi } from "vitest";
import { previewSlots, type ImagePreview } from "./imagePreview";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));

const image = (id: string, slot: string, createdAt: number): ImagePreview =>
  ({ id, slot, title: slot, path: `/${id}.png`, createdAt });

describe("previewSlots", () => {
  it("lists the slot touched most recently first, versions oldest to newest", () => {
    const slots = previewSlots([
      image("a1", "hero", 1),
      image("b1", "logo", 2),
      image("a2", "hero", 3),
      image("c1", "footer", 4),
    ]);
    expect(slots.map(slot => slot.slot)).toEqual(["footer", "hero", "logo"]);
    expect(slots[1].versions.map(version => version.id)).toEqual(["a1", "a2"]);
  });

  it("breaks a createdAt tie by list order", () => {
    const slots = previewSlots([image("a", "first", 5), image("b", "second", 5)]);
    expect(slots.map(slot => slot.slot)).toEqual(["second", "first"]);
  });
});
