import { describe, expect, it } from "vitest";
import {
  acceptSnapshot,
  allowed,
  type Agent,
  type Project,
  type Snapshot,
} from "./types";

describe("world project eligibility", () => {
  const a = {
    orgId: "org-a",
    allProjects: false,
    projectIds: ["project-a"],
  } as Agent;
  it("restricts direct and meeting pickers to authorized projects", () => {
    expect(allowed(a, { id: "project-a", orgId: "org-a" } as Project)).toBe(
      true,
    );
    expect(allowed(a, { id: "project-b", orgId: "org-a" } as Project)).toBe(
      false,
    );
  });
  it("keeps all-project access inside the organization", () => {
    expect(
      allowed({ ...a, allProjects: true }, {
        id: "future",
        orgId: "org-a",
      } as Project),
    ).toBe(true);
    expect(
      allowed({ ...a, allProjects: true }, {
        id: "project-a",
        orgId: "org-b",
      } as Project),
    ).toBe(false);
  });
});
describe("world snapshot ordering", () => {
  it("does not let a late poll overwrite a newer mutation response", () => {
    const newer = { world: { revision: 12 } } as Snapshot;
    const older = { world: { revision: 11 } } as Snapshot;
    expect(acceptSnapshot(newer, older)).toBe(newer);
    expect(acceptSnapshot(older, newer)).toBe(newer);
    expect(acceptSnapshot(null, older)).toBe(older);
  });
});
