import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectAvatar, projectInitial } from "./ProjectAvatar";

describe("ProjectAvatar", () => {
  it("uses the project name as the default identity", () => {
    expect(projectInitial({ name: "octiq-flow" })).toBe("O");
    const out = renderToStaticMarkup(
      <ProjectAvatar project={{ id: "p1", name: "octiq-flow" }} size="tiny" />,
    );
    expect(out).toContain("project-avatar is-tiny");
    expect(out).toContain("project-avatar-text\">O</span>");
    expect(out).not.toContain("<img");
  });

  it("supports a two-character fallback", () => {
    expect(projectInitial({ name: "octiq-flow", initial: "of" })).toBe("OF");
  });

  it("shows an uploaded image instead of fallback text", () => {
    const out = renderToStaticMarkup(
      <ProjectAvatar project={{
        id: "p1",
        name: "octiq-flow",
        icon: "data:image/png;base64,aWNvbg==",
      }} />,
    );
    expect(out).toContain("has-icon");
    expect(out).toContain('src="data:image/png;base64,aWNvbg=="');
    expect(out).not.toContain("project-avatar-text");
  });
});
