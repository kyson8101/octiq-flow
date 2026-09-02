import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Importing Composer pulls in the live bridge. This is a static rendering
// contract: no test below talks to the server.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { ACCESS, Composer, MODELS, providerFor, type ModelChoice } from "./Composer";

function renderComposer(choice: ModelChoice): string {
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
});
