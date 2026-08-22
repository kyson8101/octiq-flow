import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachList } from "./AttachMenu";

/** The two ways a file reaches the agent, as the "+" menu lists them. They are
 *  genuinely different — one points at a file already on the machine running
 *  the agents, the other uploads bytes off the device in your hand — so the
 *  menu has to say which is which, not just show two icons. */
describe("AttachList", () => {
  const html = () =>
    renderToStaticMarkup(<AttachList onReference={() => {}} onUpload={() => {}} />);

  it("offers both ways, each with what it actually does", () => {
    const out = html();
    expect(out).toContain("Reference a file");
    expect(out).toContain("on the machine running the agents");
    expect(out).toContain("Upload an image");
    expect(out).toContain("from this device");
  });

  it("draws them as menu rows, so the menu is navigable", () => {
    expect(html().match(/role="menuitem"/g)).toHaveLength(2);
  });
});
