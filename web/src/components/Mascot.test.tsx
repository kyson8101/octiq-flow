import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Mascot } from "./Mascot";
import { MODELS } from "../lib/agentProviders";

describe("Mascot", () => {
  it("is decorative and renders without WebGL during SSR", () => {
    const out = renderToStaticMarkup(<Mascot />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("aria-label");
    expect(out).toContain("<svg");
    expect(out).not.toContain("<canvas");
    expect(out).toContain('data-mood="idle"');
  });

  it("reserves a fixed avatar slot at the requested size", () => {
    const out = renderToStaticMarkup(<Mascot size={44} />);
    expect(out).toContain('width="44" height="44"');
    expect(out).toContain("width:44px;height:44px");
  });

  it("renders a complete cartoon face for every model", () => {
    for (const model of MODELS) {
      const out = renderToStaticMarkup(<Mascot robot={model.composerStyle} />);
      expect(out).toContain(`data-robot="${model.composerStyle}"`);
      expect(out).toContain("mascot-avatar-base");
      expect(out).toContain("mascot-avatar-cheeks");
      expect(out).toContain("mascot-avatar-mark");
      expect(out).not.toContain("mascot-fallback-torso");
      expect(out).toContain("mascot-avatar-eyes");
      expect(out).toContain("mascot-avatar-mouth");
    }
  });

  it("identifies Pi separately from its underlying Codex robot", () => {
    expect(renderToStaticMarkup(<Mascot robot="pi-terra" />)).toContain('data-provider-mark="pi">P');
    expect(renderToStaticMarkup(<Mascot robot="terra" />)).not.toContain("data-provider-mark");
  });

  it("keeps each portrait's iris paint local when many models share a page", () => {
    const out = renderToStaticMarkup(<>{MODELS.map(model => <Mascot key={model.id} robot={model.composerStyle} />)}</>);
    const ids = [...out.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]);
    const paints = [...out.matchAll(/fill="url\(#([^)]+)\)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(MODELS.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(paints).toHaveLength(MODELS.length * 2);
    for (const id of ids) expect(paints.filter(paint => paint === id)).toHaveLength(2);
  });

  it("preserves working, thinking, sleeping and background-task signals", () => {
    expect(renderToStaticMarkup(<Mascot mood="work" alert />)).toContain("is-alert");
    expect(renderToStaticMarkup(<Mascot mood="think" />)).toContain('data-mood="think"');
    const asleep = renderToStaticMarkup(<Mascot asleep />);
    expect(asleep).toContain("is-asleep");
    expect(asleep).toContain('class="mascot-z">z');
  });
  it("uses distinct faces for every state and gives sleep precedence", () => {
    const faces = ["idle", "think", "work", "still"].map(mood => {
      const out = renderToStaticMarkup(<Mascot mood={mood as "idle" | "think" | "work" | "still"} />);
      return out.slice(out.indexOf('<g class="mascot-avatar-face"'), out.indexOf("</svg>"));
    });
    expect(new Set(faces).size).toBe(4);
    const asleep = renderToStaticMarkup(<Mascot mood="work" asleep alert />);
    expect(asleep).toContain('data-expression="asleep"');
    expect(asleep).toContain("is-alert");
  });

});
