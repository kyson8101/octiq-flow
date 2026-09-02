// projectSlug turns a project's label into its chat-URL address
// (#/p/<slug>/c/<chatId>). The backend mirrors this exact rule
// (name_slug in src-tauri/src/workspaces.rs) to refuse two labels that
// would collide once slugged, so these cases double as the contract
// between the two.
import { describe, expect, it } from "vitest";

import { projectSlug } from "./projectSlug";

describe("projectSlug", () => {
  it("passes a plain name through lower-cased", () => {
    expect(projectSlug("octiq-flow")).toBe("octiq-flow");
    expect(projectSlug("OctiqFlow")).toBe("octiqflow");
  });

  it("folds spaces and parentheses to single dashes", () => {
    expect(projectSlug("pandahrms-sso (Legacy)")).toBe("pandahrms-sso-legacy");
  });

  it("folds a run of several separators into one dash", () => {
    expect(projectSlug("Api Extraction from HCM Web")).toBe("api-extraction-from-hcm-web");
  });

  it("makes two labels that only differ by separator style collide", () => {
    // This is the point of the function: "My App" and "my-app" must produce
    // the same address, which is exactly why the backend refuses to let a
    // second project claim either one.
    expect(projectSlug("My App")).toBe(projectSlug("my-app"));
  });

  it("trims leading and trailing junk rather than leaving a dangling dash", () => {
    expect(projectSlug("  --x--  ")).toBe("x");
  });
});
