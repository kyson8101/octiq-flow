import { describe, expect, it, vi } from "vitest";
import { ensureGeneralProject, type GeneralProject } from "./generalProject";

const project = (id: string, name: string, shelved = false): GeneralProject => ({
  id,
  name,
  primary_path: `/work/${id}`,
  shelved,
});

describe("General project routing", () => {
  it("reuses an active General without writing", async () => {
    const general = project("g", "General");
    const invoke = vi.fn();
    const result = await ensureGeneralProject([general], [], invoke);
    expect(result.project).toEqual(general);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("creates General lazily with the backend's home-path default", async () => {
    const created = project("g", "General");
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe("add_workspace");
      expect(args).toEqual({ name: "General", primaryPath: "" });
      return created;
    });
    const result = await ensureGeneralProject([project("p", "Product")], [], invoke);
    expect(result.project).toBe(created);
    expect(result.active.map((item) => item.id)).toEqual(["p", "g"]);
  });

  it("restores a shelved General", async () => {
    const general = project("g", "General", true);
    const invoke = vi.fn(async () => undefined);
    const result = await ensureGeneralProject([], [general], invoke);
    expect(invoke).toHaveBeenCalledWith("set_workspace_shelved", {
      id: "g",
      shelved: false,
    });
    expect(result.project.shelved).toBe(false);
    expect(result.shelved).toEqual([]);
  });

  it("uses the project another client created during the same race", async () => {
    const general = project("g", "General");
    const invoke = vi.fn(async (command: string) => {
      if (command === "add_workspace") throw new Error("name already exists");
      return [project("p", "Product"), general];
    });
    const result = await ensureGeneralProject<GeneralProject>([], [], invoke);
    expect(result.project).toEqual(general);
    expect(result.active.map((item) => item.id)).toEqual(["p", "g"]);
  });
});
