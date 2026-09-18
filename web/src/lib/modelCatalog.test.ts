import { describe, expect, it } from "vitest";

import { choicesFromCatalog, type ModelCatalog } from "./modelCatalog";

describe("provider model catalogs", () => {
  it("keeps moving aliases while adding provider-discovered exact models", () => {
    const catalog: ModelCatalog = {
      source: "provider",
      models: [
        {
          model: "gpt-5.7-new",
          displayName: "GPT-5.7 New",
          description: "newly released",
        },
        {
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
        },
      ],
    };

    const choices = choicesFromCatalog("codex", catalog);
    expect(choices[0].flag).toBe("gpt-5.7-new");
    expect(choices[0].model).toBe("GPT-5.7 New");
    expect(choices.filter((choice) => choice.flag === "gpt-5.6-sol")).toHaveLength(1);
  });

  it("keeps Claude latest aliases separate from a pinned Opus 4.6", () => {
    const choices = choicesFromCatalog("claude", {
      source: "bundled",
      models: [
        {
          model: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
        },
      ],
    });

    expect(choices.find((choice) => choice.flag === "opus")?.model).toBe("Opus latest");
    expect(choices.find((choice) => choice.flag === "claude-opus-4-6")?.model).toBe("Opus 4.6");
  });
});
