// The copy button, now that two panels share it.
//
// A node run has no clipboard and no click, so what is checked here is the part
// that broke when it moved out of SessionFiles: that a caller can give it its
// own resting class without losing the `is-…` state the stylesheet colours by,
// and that the button says which one it is before it has been pressed. The copy
// itself goes through `lib/clipboard`, which is where that half is tested.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CopyBit, CopyIcon } from "./CopyBit";

describe("a copy button", () => {
  it("says what it offers, in its title and to a screen reader", () => {
    const html = renderToStaticMarkup(
      <CopyBit icon={<CopyIcon />} idle="Copy the path" done="Path copied" read={() => ({ text: "/repo/x.ts" })} />,
    );

    expect(html).toContain('title="Copy the path"');
    expect(html).toContain('aria-label="Copy the path"');
  });

  it("rests in the files column's class unless it is given another", () => {
    const bare = renderToStaticMarkup(
      <CopyBit icon={<CopyIcon />} idle="Copy" done="Copied" read={() => ({ text: "x" })} />,
    );
    const panel = renderToStaticMarkup(
      <CopyBit
        className="panel-act"
        icon={<CopyIcon />}
        idle="Copy"
        done="Copied"
        read={() => ({ text: "x" })}
      />,
    );

    expect(bare).toContain('class="sfp-act is-idle"');
    expect(panel).toContain('class="panel-act is-idle"');
  });
});
