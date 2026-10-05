import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PreferencesBlock, PreferencesSettings } from "./PreferencesSettings";
import {
  loadPersonalPreferences, PERSONAL_PREFERENCES_MAX, savePersonalPreferences,
} from "../lib/personalPreferences";

const noop = () => {};
const block = (over: Partial<Parameters<typeof PreferencesBlock>[0]> = {}) =>
  renderToStaticMarkup(createElement(PreferencesBlock, {
    saved: "", text: "", loading: false, busy: false, done: false,
    onChange: noop, onSave: noop, onClear: noop, ...over,
  }));

beforeEach(() => invoke.mockReset());

describe("personal preferences in Settings", () => {
  it("says where the words go and when a running chat sees them", () => {
    const page = renderToStaticMarkup(createElement(PreferencesSettings));
    expect(page).toContain("<h2 id=\"preferences-title\">Personal preferences</h2>");
    const html = block();
    expect(html).toContain("Ends the system prompt of every chat OctiqFlow starts");
    expect(html).toContain("the front desk and task workers included");
    expect(html).toContain("the next time it starts or resumes");
    expect(html).toContain(`maxLength="${PERSONAL_PREFERENCES_MAX}"`);
    expect(html).toContain("0 / 4,000");
  });

  it("saves only a change, clears only something saved, and refuses too much", () => {
    const empty = block();
    expect(empty).toMatch(/<button class="vault-button" type="button" disabled="">Clear<\/button>/);
    expect(empty).toMatch(/<button class="settings-primary" type="submit" disabled="">Save preferences<\/button>/);
    const typed = block({ text: "Reply in Malay." });
    expect(typed).toMatch(/<button class="settings-primary" type="submit">Save preferences<\/button>/);
    const saved = block({ saved: "Reply in Malay.", text: "Reply in Malay.", done: true });
    expect(saved).toMatch(/<button class="vault-button" type="button">Clear<\/button>/);
    expect(saved).toMatch(/<button class="settings-primary" type="submit" disabled="">Save preferences<\/button>/);
    expect(saved).toContain("role=\"status\">Saved</span>");
    const long = block({ text: "x".repeat(PERSONAL_PREFERENCES_MAX + 1) });
    expect(long).toContain("too long");
    expect(long).toMatch(/<button class="settings-primary" type="submit" disabled="">/);
  });

  it("reads and writes the host's store", async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await loadPersonalPreferences()).toEqual({ text: "", updatedAt: 0 });
    expect(invoke).toHaveBeenLastCalledWith("personal_preferences", {});
    invoke.mockResolvedValueOnce({ text: "Be brief.", updatedAt: 5 });
    expect(await savePersonalPreferences("Be brief.")).toEqual({ text: "Be brief.", updatedAt: 5 });
    expect(invoke).toHaveBeenLastCalledWith("personal_preferences_set", { text: "Be brief." });
  });
});
