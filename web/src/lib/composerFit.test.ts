import { describe, expect, it } from "vitest";
import { ROW_FITS, rowFit } from "./composerFit";
import composer from "../components/Composer.tsx?raw";
import styles from "../styles.css?raw";

describe("whether the composer's row holds its pickers side by side", () => {
  it("keeps them while what the row holds is no wider than the row", () => {
    expect(rowFit(ROW_FITS, { scrollWidth: 420, clientWidth: 640 })).toBe(ROW_FITS);
    expect(rowFit(ROW_FITS, { scrollWidth: 420, clientWidth: 420 })).toBe(ROW_FITS);
  });

  it("folds them when the row overflows, and remembers what they needed", () => {
    // A chat column between the run panel and a side column: 290px of row
    // for 424px of pickers. The overflow used to land on Send.
    expect(rowFit(ROW_FITS, { scrollWidth: 424, clientWidth: 290 })).toEqual({ tight: true, needed: 424 });
  });

  it("brings them back only when the row is as wide as they needed", () => {
    const folded = { tight: true, needed: 424 };
    // Folded, the row fits, so its own overflow says nothing any more.
    expect(rowFit(folded, { scrollWidth: 290, clientWidth: 290 })).toBe(folded);
    expect(rowFit(folded, { scrollWidth: 400, clientWidth: 423 })).toBe(folded);
    expect(rowFit(folded, { scrollWidth: 400, clientWidth: 424 })).toBe(ROW_FITS);
    expect(rowFit(folded, { scrollWidth: 400, clientWidth: 900 })).toBe(ROW_FITS);
  });

  it("does not flip back and forth at one width", () => {
    // Walk a row down and up again: one fold on the way down, one return on
    // the way up, and the same answer on every repeat at a width.
    let fit = ROW_FITS;
    const needs = 424;
    const drawn = (width: number) => ({ clientWidth: width, scrollWidth: fit.tight ? Math.min(width, 180) : Math.max(width, needs) });
    const seen: string[] = [];
    for (const width of [600, 500, 424, 423, 423, 300, 300, 423, 424, 424, 600]) {
      fit = rowFit(fit, drawn(width));
      seen.push(`${width}:${fit.tight ? "folded" : "side by side"}`);
    }
    expect(seen).toEqual([
      "600:side by side", "500:side by side", "424:side by side", "423:folded", "423:folded", "300:folded", "300:folded",
      "423:folded", "424:side by side", "424:side by side", "600:side by side",
    ]);
  });

  it("goes by what is measured: a wider font folds sooner at the same row", () => {
    const row = 440;
    expect(rowFit(ROW_FITS, { scrollWidth: 424, clientWidth: row }).tight).toBe(false);
    expect(rowFit(ROW_FITS, { scrollWidth: 424 * 1.15, clientWidth: row }).tight).toBe(true);
  });
});

describe("the composer's row as it is wired", () => {
  it("is measured when its size changes and when what it holds does, never on every render", () => {
    expect(composer).toMatch(/const observer = new ResizeObserver\(measureRow\);\s*observer\.observe\(row\);/);
    expect(composer).toMatch(/useLayoutEffect\(measureRow, \[measureRow, rowHolds\]\);/);
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
