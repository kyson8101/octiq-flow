import { describe, expect, it, vi } from "vitest";
import { previewBlob, previewSlots, type ImagePreview } from "./imagePreview";

const fetchFile = vi.hoisted(() => vi.fn(async (path: string) => new Blob([path])));
vi.mock("./bridge", () => ({ bridge: { invoke: async () => [], fetchFile } }));

describe("previewBlob", () => {
  it("downloads an immutable snapshot once, however often it is shown", async () => {
    const first = await previewBlob("/p/once.png");
    const again = await previewBlob("/p/once.png");
    expect(again).toBe(first);
    expect(fetchFile.mock.calls.filter(([path]) => path === "/p/once.png")).toHaveLength(1);
  });

  it("evicts the least recently used once over its byte budget", async () => {
    const big = 60 * 1024 * 1024;
    fetchFile.mockImplementation(async () => ({ size: big }) as Blob);
    await previewBlob("/p/a.png");
    await previewBlob("/p/b.png");
    await previewBlob("/p/a.png");
    const before = fetchFile.mock.calls.length;
    await previewBlob("/p/b.png");
    expect(fetchFile.mock.calls.length).toBe(before + 1);
  });
});

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
