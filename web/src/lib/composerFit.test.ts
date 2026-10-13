import { describe, expect, it } from "vitest";
import { ROW_FITS, rowFit } from "./composerFit";
import composer from "../components/Composer.tsx?raw";
import styles from "../styles.css?raw";

describe("whether the composer's row holds its pickers side by side", () => {
  it("keeps them while what the row holds is no wider than the row", () => {
    expect(rowFit(ROW_FITS, { scrollWidth: 420, clientWidth: 640 })).toBe(ROW_FITS);
    expect(rowFit(ROW_FITS, { scrollWidth: 420, clientWidth: 420 })).toBe(ROW_FITS);
  });

  it("folds them when the row overflows, at the width it failed at", () => {
    // A chat column between the run panel and a side column: 290px of row
    // for 424px of pickers. The overflow used to land on Send.
    expect(rowFit(ROW_FITS, { scrollWidth: 424, clientWidth: 290 })).toEqual({ tight: true, at: 290 });
  });

  it("tries them side by side again only when the row has grown, or what it holds changed", () => {
    const folded = { tight: true, at: 290 };
    // Folded, the row fits, so its own overflow says nothing any more; at
    // the width it failed at, and narrower, it stays folded.
    expect(rowFit(folded, { scrollWidth: 290, clientWidth: 290 })).toBe(folded);
    expect(rowFit(folded, { scrollWidth: 200, clientWidth: 240 })).toBe(folded);
    // Wider: tried again. The next look, with the pickers drawn, decides.
    expect(rowFit(folded, { scrollWidth: 290, clientWidth: 291 })).toBe(ROW_FITS);
    // What it holds changed (another model, the fonts arrived): tried again
    // at the same width.
    expect(rowFit(folded, { scrollWidth: 290, clientWidth: 290 }, true)).toBe(ROW_FITS);
    // Side by side, "again" is the ordinary look.
    expect(rowFit(ROW_FITS, { scrollWidth: 300, clientWidth: 400 }, true)).toBe(ROW_FITS);
    expect(rowFit(ROW_FITS, { scrollWidth: 424, clientWidth: 400 }, true)).toEqual({ tight: true, at: 400 });
  });

  /** A row whose pickers need `needs`, looked at as the page does: after a
   *  try side by side, once more before the paint. Returns what is painted. */
  const painted = (fit: ReturnType<typeof rowFit>, width: number, needs: number, again = false) => {
    const drawn = (state: typeof fit) => ({ clientWidth: width, scrollWidth: state.tight ? Math.min(width, 180) : Math.max(width, needs) });
    let next = rowFit(fit, drawn(fit), again);
    if (next !== fit) next = rowFit(next, drawn(next));
    return next;
  };

  it("does not flip back and forth at one width", () => {
    // Walk a row down and up again: one fold on the way down, one return on
    // the way up, and the same answer on every repeat at a width.
    let fit = ROW_FITS;
    const seen: string[] = [];
    for (const width of [600, 500, 424, 423, 423, 300, 300, 423, 424, 424, 600]) {
      fit = painted(fit, width, 424);
      seen.push(`${width}:${fit.tight ? "folded" : "side by side"}`);
    }
    expect(seen).toEqual([
      "600:side by side", "500:side by side", "424:side by side", "423:folded", "423:folded", "300:folded", "300:folded",
      "423:folded", "424:side by side", "424:side by side", "600:side by side",
    ]);
  });

  it("is not held folded by what the pickers needed once", () => {
    // Folded while a wider fallback font was drawn (the pickers needed 560),
    // then the app's own font arrived and they need 424. A remembered 560
    // kept them folded in a 530px row; the row is asked again instead.
    let fit = painted(ROW_FITS, 500, 560);
    expect(fit).toEqual({ tight: true, at: 500 });
    fit = painted(fit, 500, 424, true);
    expect(fit).toBe(ROW_FITS);
    // And a try that still does not fit folds again before it is painted.
    fit = painted(painted(ROW_FITS, 300, 424), 300, 424, true);
    expect(fit).toEqual({ tight: true, at: 300 });
    expect(painted(fit, 530, 424)).toBe(ROW_FITS);
  });

  it("goes by what is measured: a wider font folds sooner at the same row", () => {
    const row = 440;
    expect(rowFit(ROW_FITS, { scrollWidth: 424, clientWidth: row }).tight).toBe(false);
    expect(rowFit(ROW_FITS, { scrollWidth: 424 * 1.15, clientWidth: row }).tight).toBe(true);
  });
});

describe("the composer's row as it is wired", () => {
  it("is measured when its size changes and when what it holds does, never on every render", () => {
    expect(composer).toMatch(/const observer = new ResizeObserver\(\(\) => measureRow\(\)\);\s*observer\.observe\(row\);/);
    // What it holds changed, or its fonts arrived: asked again.
    expect(composer).toMatch(/useLayoutEffect\(\(\) => measureRow\(true\), \[measureRow, rowHolds\]\);/);
    expect(composer).toMatch(/document\.fonts\?\.ready\.then\(\(\) => \{ if \(live\) measureRow\(true\); \}\);/);
    // A try side by side is looked at again before the paint. The fold is
    // not one of the things the row "holds", or a try would ask for a try.
    expect(composer).toMatch(/useLayoutEffect\(\(\) => measureRow\(\), \[measureRow, fit\.tight\]\);/);
    expect(/const rowHolds = \[([^\]]*)\]/.exec(composer)![1]).not.toContain("fit");
    expect(composer).toMatch(/className=\{`composer-row\$\{fit\.tight \? " is-tight" : ""\}`\} ref=\{rowRef\}/);
  });

  it("folds by that measure with the phone's own fold, and Send never gives way", () => {
    const rule = (selector: string) => new RegExp(`\\n${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(styles)?.[1] ?? "";
    expect(rule(".composer-row.is-tight .composer-settings")).toMatch(/display: none;/);
    expect(rule(".composer-row.is-tight .settings-toggle")).toMatch(/display: inline-flex;[\s\S]*flex: 0 1 auto;\s*min-width: 0;/);
    // Send keeps its size at the end of the row.
    expect(rule(".send")).toMatch(/width: 32px;[\s\S]*flex: 0 0 auto;/);
  });
});
