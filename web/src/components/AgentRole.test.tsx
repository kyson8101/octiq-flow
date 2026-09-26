import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRole, AgentWelcome, rolePreview } from "./AgentRole";

describe("an agent's role in a list", () => {
  it("carries the whole stored role, and a toggle tied to it", () => {
    const role = "Leave lead.\n\nOwns the rules & reviews <every> change.";
    const html = renderToStaticMarkup(<AgentRole text={role} name="Papaya Juice" />);
    const id = html.match(/<p class="agent-role-text" id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain("Leave lead.\n\nOwns the rules &amp; reviews &lt;every&gt; change.");
    expect(html).toContain(`aria-controls="${id}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Full role for Papaya Juice"');
    // Nothing is measured before it is on screen, so it offers nothing yet.
    expect(html).toMatch(/<button[^>]*hidden=""/);
  });
});

describe("rolePreview", () => {
  it("takes the first sentence", () => {
    expect(rolePreview("CTO. Owns technical direction across every project.")).toBe("CTO");
    expect(rolePreview("Frontend engineer")).toBe("Frontend engineer");
  });

  it("cuts a long first sentence at a word", () => {
    const preview = rolePreview("Pandahrms Leave module lead reporting to Potato Juice and coordinating mobile consumers with Kiwi.");
    expect(preview).toBe("Pandahrms Leave module lead reporting to Potato Juice…");
    expect(preview.length).toBeLessThanOrEqual(57);
  });

  it("flattens line breaks, and does not split on a dotted name", () => {
    expect(rolePreview("  Reviewer\n\nfor core-v1/Pandahrms_Web.  ")).toBe("Reviewer for core-v1/Pandahrms_Web");
  });
});

describe("the welcome under a new conversation's heading", () => {
  const role = "Starfall creative lead and novelist. Owns chapters & <canon>.\n\nWork only in /Users/kyson/03-projects/Starfall.";
  const how = "Does the work itself or hands parts to its team, and you approve any plan first.";

  it("shows one line, and keeps the whole stored role behind a shut toggle", () => {
    const html = renderToStaticMarkup(<AgentWelcome name="Vesper" role={role} scope="Works only in starfall" how={how} />);
    expect(html).toContain('<span class="agent-welcome-summary">Starfall creative lead and novelist · Works only in starfall</span>');
    const id = html.match(/<div class="agent-welcome-details" id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-controls="${id}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Details about Vesper"');
    expect(html).toMatch(/<div class="agent-welcome-details"[^>]*role="region"[^>]*aria-label="About Vesper"[^>]*hidden=""/);
    // Word for word, only escaped — the welcome never edits what is stored.
    expect(html).toContain("Owns chapters &amp; &lt;canon&gt;.\n\nWork only in /Users/kyson/03-projects/Starfall.</p>");
    expect(html).toContain(`<p>${how}</p>`);
  });

  it("says where an agent with no role works, and still offers how it works", () => {
    const html = renderToStaticMarkup(<AgentWelcome name="Ada" role="  " scope="Works in any project" how={how} />);
    expect(html).toContain('<span class="agent-welcome-summary">Works in any project</span>');
    expect(html).not.toContain("agent-welcome-role");
    expect(html).toContain(`<p>${how}</p>`);
  });
});
