// The space between transcript rows is each row's own top margin, so the host's
// one-line rows can sit closer than a turn does. That is only safe while the
// lines that used to add a margin of their own to the old 18px gap still do.
import { describe, expect, it } from "vitest";
import stylesCss from "../styles.css?raw";
import autoPlanCss from "../components/AutoPlan.css?raw";
import messageListSource from "../components/MessageList.tsx?raw";
import { lf } from "./sourceText";

const css = lf(stylesCss);
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("transcript gaps", () => {
  it("spaces turns by margin, not by the column's gap", () => {
    expect(rule(".msgs-inner")).toMatch(/gap: 0;/);
    expect(rule(".msgs-inner.msgs-inner > * + *")).toMatch(/margin-top: 18px/);
  });

  it("keeps host lines close to what is around them", () => {
    expect(rule(".msgs-inner.msgs-inner > * + :is(.msg-event, .msg-host)")).toMatch(/margin-top: var\(--space-1\)/);
    expect(rule(".msgs-inner.msgs-inner > :is(.msg-event, .msg-host) + *")).toMatch(/margin-top: var\(--space-2\)/);
    expect(rule(".msgs-inner.msgs-inner > :is(.msg-event, .msg-host) + :is(.msg-event, .msg-host)")).toMatch(/margin-top: 0/);
  });

  it("gives the lines that had their own margin the same total as before", () => {
    // stopmark: margin -6px 0 inside an 18px gap = 12px above and below.
    expect(rule(".msgs-inner.msgs-inner > .stopmark")).toMatch(/margin-top: 12px/);
    expect(rule(".msgs-inner.msgs-inner > .stopmark + *")).toMatch(/margin-top: 18px/);
    // compaction rule: margin 6px 0 inside the gap = 24px.
    expect(rule(".msgs-inner.msgs-inner > * + .compacted")).toMatch(/margin-top: 24px/);
  });

  it("drops the reply's extra copy-row margin and the fold line's own margin", () => {
    expect(rule(".msg-foot")).toMatch(/margin-top: 0;/);
    expect(lf(autoPlanCss)).toMatch(/\.auto-plan-approved \.card-fold-line \{ margin-top: 0;/);
  });

  it("marks only the plan auto-approved line as an event row", () => {
    expect(lf(messageListSource)).toMatch(/blocks\.every\(\(b\) => b\.kind === "planAutoApproved"\)/);
    expect(lf(messageListSource)).toMatch(/eventLine \? "msg-event" : ""/);
  });
});
