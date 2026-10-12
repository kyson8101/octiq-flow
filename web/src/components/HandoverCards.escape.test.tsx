// A tip on a project's name does not take another surface's Escape.
//
// Whose Escape it is, is a pure answer (`lib/placeTip.keepsEscape`, tabled in
// `placeTip.test.ts`). This file is the card's own listener (`tipKey`) set
// against the real `PlanRejectConfirmation`: the review's case, where the
// pointer rested on a project's name and the first Escape in the plan's
// reject form shut the tip and left the form up.
//
// There is no browser here. One Escape is handed on the way a page hands it
// on: every tip that is shown hears it on the document first, and unless one
// of them kept it, the thing that has the focus hears it next. That order is
// the test's, not the browser's: the real dispatch was pressed in Chrome.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { Children, isValidElement, type ReactElement } from "react";
import { tipKey } from "./HandoverCards";
import { PlanRejectConfirmation } from "./PlanReview";

type Tip = ReturnType<typeof tipKey>;

/** One Escape: to the tips first, then to what has the focus unless a tip
 *  kept it. */
const escape = (tips: Tip[], focused?: (event: unknown) => void) => {
  const event = {
    key: "Escape", prevented: false, stopped: false,
    preventDefault() { event.prevented = true; },
    stopPropagation() { event.stopped = true; },
  };
  for (const tip of tips) tip(event);
  if (!event.stopped) focused?.({ key: "Escape", nativeEvent: { isComposing: false }, preventDefault() {} });
  return event;
};

/** A node, as far as the focus goes. */
const node = () => {
  const self = { contains: (other: unknown) => other === self };
  return self as unknown as Node;
};

/** The page with the focus on `active` (nothing: its body). */
const focusOn = (active: Node | null) => {
  const body = node();
  vi.stubGlobal("document", { activeElement: active ?? body, body });
};

describe("Escape, with a project's tip shown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shuts the tip and lets the form with the focus cancel, on the one press", () => {
    const onCancel = vi.fn();
    const form = PlanRejectConfirmation({
      reason: "", busy: false, disabled: false, rejecting: false, onReason: () => {}, onConfirm: () => {}, onCancel,
    });
    const field = Children.toArray(form.props.children).find((child) => isValidElement(child) && child.type === "input") as
      ReactElement<{ onKeyDown(event: unknown): void }>;
    // The focus is in the form's field; only the pointer is on the name.
    focusOn(node());
    const said: string[] = [];
    const event = escape([tipKey(() => node(), (what) => said.push(what))], field.props.onKeyDown);
    expect(said).toEqual(["escape"]);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(event.stopped).toBe(false);
    expect(event.prevented).toBe(false);
  });

  it("is kept by the tip when the focus is on its own name, or on nothing", () => {
    for (const where of ["word", "nowhere"] as const) {
      const word = node();
      focusOn(where === "word" ? word : null);
      const said: string[] = [];
      const page = vi.fn();
      const event = escape([tipKey(() => word, (what) => said.push(what))], page);
      // The tip shuts, and that is all this press does: focus mode is not
      // left by it (it leaves on an Escape nobody prevented).
      expect(said, where).toEqual(["escape"]);
      expect(event.stopped, where).toBe(true);
      expect(event.prevented, where).toBe(true);
      expect(page, where).not.toHaveBeenCalled();
    }
  });

  it("asks where the focus is as the key arrives, not when the tip opened", () => {
    const word = node();
    focusOn(word);
    const said: string[] = [];
    const key = tipKey(() => word, (what) => said.push(what));
    // Opened by the focus, and the focus has since gone to a field.
    focusOn(node());
    const page = vi.fn();
    expect(escape([key], page).stopped).toBe(false);
    expect(page).toHaveBeenCalledTimes(1);
    expect(said).toEqual(["escape"]);
  });

  it("shuts two tips on one press: one card's name focused, another's hovered", () => {
    const focused = node();
    const hovered = node();
    focusOn(focused);
    // Both listen on the document: stopping the press between elements does
    // not keep it from the other, in either order.
    for (const order of [["focused", "hovered"], ["hovered", "focused"]] as const) {
      const said: string[] = [];
      const tips = { focused: tipKey(() => focused, () => said.push("focused")), hovered: tipKey(() => hovered, () => said.push("hovered")) };
      const event = escape(order.map((name) => tips[name]));
      expect([...said].sort()).toEqual(["focused", "hovered"]);
      // Kept by the tip whose name has the focus.
      expect(event.stopped).toBe(true);
    }
  });
});
