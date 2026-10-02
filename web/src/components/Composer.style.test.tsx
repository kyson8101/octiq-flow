import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Importing Composer pulls in the live bridge. This is a static rendering
// contract: no test below talks to the server.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { ACCESS, Composer, MODELS, idleCompanion, idleHint, providerFor, type ModelChoice } from "./Composer";

function renderComposer(choice: ModelChoice, showWorkLocation = false): string {
  const provider = providerFor(choice.agent);
  return renderToStaticMarkup(
    <Composer
      choice={choice}
      onChoice={() => {}}
      access={ACCESS[choice.agent][0].id}
      onAccess={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      busy={false}
      effort={provider.efforts[0].id}
      onEffort={() => {}}
      lite={false}
      onLite={() => {}}
      showWorkLocation={showWorkLocation}
    />,
  );
}

describe("the model-driven composer style", () => {
  it.each(MODELS)("puts $model's visual profile on the composer", (model) => {
    const html = renderComposer(model);

    expect(html).toContain(`data-composer-style="${model.composerStyle}"`);
    expect(html).toContain(`data-model-id="${model.id}"`);
    expect(html).toContain("model-trigger");
  });

  it("offers touch controls for walking sent-message history", () => {
    const html = renderComposer(MODELS[0]);

    expect(html).toContain('aria-label="Sent message history"');
    expect(html).toContain('aria-label="Show previous sent message"');
    expect(html).toContain('aria-label="Show next sent message"');
    expect(html.indexOf('aria-label="Sent message history"')).toBeLessThan(
      html.indexOf('class="composer-box"'),
    );
  });

  it("shows work location only on the new-chat composer", () => {
    expect(renderComposer(MODELS[0])).not.toContain('aria-label="Work location"');
    expect(renderComposer(MODELS[0], true)).toContain('aria-label="Work location"');
  });

  it("states the keyboard rule only where there is a keyboard", () => {
    expect(idleHint(false)).toBe("Enter to send · Shift+Enter for a new line");
    expect(idleHint(true)).toBeNull();
    // Node has no pointer, so the rendered composer is the keyboard one.
    expect(renderComposer(MODELS[0])).toContain("Enter to send · Shift+Enter for a new line");
  });

  it("leaves no agent face alone on the idle line when it has nothing to say", () => {
    // A touch screen with nothing running: no words, so no face for them.
    expect(idleCompanion(true, idleHint(true))).toBeNull();
    expect(idleCompanion(true, idleHint(false))).toBe("avatar");
    expect(idleCompanion(true, "Reading the repo")).toBe("avatar");
    // The person's own mascot is not a label, and stays.
    expect(idleCompanion(false, idleHint(true))).toBe("mascot");
    expect(idleCompanion(false, idleHint(false))).toBe("mascot");
  });
});
