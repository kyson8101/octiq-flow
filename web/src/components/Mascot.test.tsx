import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Mascot } from "./Mascot";
import { MODELS } from "../lib/agentProviders";

describe("Mascot", () => {
  it("is decorative and renders without WebGL during SSR", () => {
    const out = renderToStaticMarkup(<Mascot />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("aria-label");
    expect(out).toContain("<canvas");
    expect(out).toContain('data-mood="idle"');
  });

  it("reserves a fixed full-body slot at the requested size", () => {
    const out = renderToStaticMarkup(<Mascot size={44} />);
    expect(out).toContain('width="44" height="44"');
    expect(out).toContain("width:44px;height:44px");
  });

  it("has a full-body fallback for every model while Three.js loads", () => {
    for (const model of MODELS) {
      const out = renderToStaticMarkup(<Mascot robot={model.composerStyle} />);
      expect(out).toContain(`data-robot="${model.composerStyle}"`);
      expect(out).toContain("mascot-fallback-head");
      expect(out).toContain("mascot-fallback-torso");
      expect(out.match(/mascot-fallback-arm/g)).toHaveLength(2);
      expect(out.match(/mascot-fallback-leg/g)).toHaveLength(2);
    }
  });

  it("identifies Pi separately from its underlying Codex robot", () => {
    expect(renderToStaticMarkup(<Mascot robot="pi-terra" />)).toContain('data-provider-mark="pi">P');
    expect(renderToStaticMarkup(<Mascot robot="terra" />)).not.toContain("data-provider-mark");
  });

  it("preserves working, thinking, sleeping and background-task signals", () => {
    expect(renderToStaticMarkup(<Mascot mood="work" alert />)).toContain("is-alert");
    expect(renderToStaticMarkup(<Mascot mood="think" />)).toContain('data-mood="think"');
    const asleep = renderToStaticMarkup(<Mascot asleep />);
    expect(asleep).toContain("is-asleep");
    expect(asleep).toContain('class="mascot-z">z');
  });
});
