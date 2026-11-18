import { describe, expect, it, vi } from "vitest";

import {
  ACCESS,
  MODELS,
  PROVIDERS,
  accessFor,
  modelChoiceForFlag,
  modelFromReported,
  piFlag,
  piModelRef,
  providerFor,
  sameModelFlag,
  validModelFlag,
} from "./agentProviders";
import { groupByUpstream, choicesFromCatalog, type ModelCatalog } from "./modelCatalog";
import { frontDeskDefaults, leadSettings, teamModelLabel, teamModels, type TeamAgent } from "./agentsMode";
vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));

import { permissionAgent } from "../components/PermissionAsk";

/** What `agent_models` answers for Pi (`agents::pi_models`): `<upstream>/<model>`,
 *  the display text `<id> · <upstream>`, efforts only for a thinking model. */
const hostCatalog: ModelCatalog = {
  source: "provider",
  note: "Each model is named <upstream>/<model>.",
  models: [
    { model: "anthropic/claude-opus-5-5", displayName: "claude-opus-5-5 · anthropic", description: "through anthropic", supportedEfforts: ["low", "high"] },
    { model: "anthropic/claude-sonnet-5-5", displayName: "claude-sonnet-5-5 · anthropic", description: "through anthropic" },
    { model: "anthropic/claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5-20251001 · anthropic", description: "through anthropic" },
    { model: "openai-codex/gpt-5.6-sol", displayName: "gpt-5.6-sol · openai-codex", description: "through openai-codex" },
    { model: "deepseek/deepseek-flash", displayName: "deepseek-flash · deepseek", description: "through deepseek" },
  ],
};

describe("Pi in the provider registry", () => {
  it("is offered beside the other harnesses, with the levels the host's gate enforces", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["claude", "codex", "pi", "antigravity"]);
    // Read, Manual, Edits and Full: no Auto (the host runs an Auto start as Edits).
    expect(ACCESS.pi.map((a) => a.id)).toEqual(["read", "manual", "edits", "full"]);
    expect(ACCESS.pi.filter((a) => a.bypass).map((a) => a.id)).toEqual(["full"]);
  });

  it("runs an Auto level as Accept edits, never as the widest", () => {
    expect(accessFor("pi", "auto")).toBe("edits");
    expect(accessFor("pi", "manual")).toBe("manual");
    expect(accessFor("pi", "full")).toBe("full");
    // Other providers are as they were.
    expect(accessFor("codex", "edits")).toBe("read");
    expect(accessFor("claude", "auto")).toBe("auto");
  });

  it("bundles Claude through the API and Codex through the ChatGPT login until the catalog is read", () => {
    const flags = providerFor("pi").models.map((m) => m.flag).filter(Boolean);
    expect(flags).toContain("anthropic/claude-opus-5-5");
    expect(flags).toContain("anthropic/claude-sonnet-5-5");
    expect(flags).toContain("openai-codex/gpt-5.6-sol");
    // Every bundled flag names its upstream and is one the host would take.
    for (const flag of flags) expect(validModelFlag(flag, "pi")).toBe(true);
    expect(MODELS.filter((m) => m.agent === "pi").every((m) => !m.flag || m.flag.includes("/"))).toBe(true);
  });
});

describe("Pi model ids", () => {
  it("takes <upstream>/<model> for Pi alone, as the host's safe_model reads it", () => {
    expect(validModelFlag("anthropic/claude-sonnet-5-5", "pi")).toBe(true);
    expect(validModelFlag("claude-sonnet-5-5", "pi")).toBe(true);
    expect(validModelFlag("a/b/c", "pi")).toBe(false);
    expect(validModelFlag("anthropic/", "pi")).toBe(false);
    expect(validModelFlag("/claude", "pi")).toBe(false);
    expect(validModelFlag("x".repeat(65), "pi")).toBe(false);
    expect(validModelFlag("anthropic/claude-sonnet-5-5")).toBe(false);
    expect(validModelFlag("anthropic/claude-sonnet-5-5", "claude")).toBe(false);
    expect(modelChoiceForFlag("claude", "anthropic/claude-sonnet-5-5")).toBeUndefined();
    expect(modelChoiceForFlag("codex", "openai-codex/gpt-5.6-sol")).toBeUndefined();
  });

  it("reads a bare id as the Codex upstream and keeps one spelling of it", () => {
    expect(piModelRef("gpt-5.6-sol")).toEqual({ upstream: "openai-codex", id: "gpt-5.6-sol" });
    expect(piModelRef("anthropic/claude-opus-5-5")).toEqual({ upstream: "anthropic", id: "claude-opus-5-5" });
    expect(piFlag("gpt-5.6-sol")).toBe("openai-codex/gpt-5.6-sol");
    expect(sameModelFlag("pi", "gpt-5.6-sol", "openai-codex/gpt-5.6-sol")).toBe(true);
    expect(sameModelFlag("pi", "anthropic/claude-opus-5-5", "openai-codex/claude-opus-5-5")).toBe(false);
    expect(sameModelFlag("codex", "gpt-5.6-sol", "openai-codex/gpt-5.6-sol")).toBe(false);
  });

  it("names a Claude model by its API and gives it the Pi tier that stands for it", () => {
    const opus = modelChoiceForFlag("pi", "anthropic/claude-opus-5-5")!;
    expect(opus.model).toBe("Claude Opus 5.5 · API");
    expect(opus.flag).toBe("anthropic/claude-opus-5-5");
    expect(opus.composerStyle).toBe("pi-sol");
    expect(modelChoiceForFlag("pi", "anthropic/claude-sonnet-5-5")!.composerStyle).toBe("pi-terra");
    expect(modelChoiceForFlag("pi", "anthropic/claude-haiku-4-5-20251001")!.composerStyle).toBe("pi-luna");
    expect(modelChoiceForFlag("pi", "anthropic/claude-fable-5-2")!.composerStyle).toBe("pi-astra");
    expect(modelChoiceForFlag("pi", "anthropic/claude-haiku-4-5-20251001")!.model).toBe("Claude Haiku 4.5 · API");
    // Not a Claude name that merely contains one: `sonnet` is not `sol`.
    expect(modelChoiceForFlag("pi", "deepseek/deepseek-flash")!.composerStyle).toBe("pi");
  });

  it("gives a saved bare Codex id its named row, and refuses a bare Claude id", () => {
    expect(modelFromReported("pi", "gpt-5.6-sol")?.flag).toBe("openai-codex/gpt-5.6-sol");
    expect(modelChoiceForFlag("pi", "gpt-5.6-sol")?.id).toBe("pi:sol");
    // A bare Claude id never meant Pi's Codex upstream; the host refuses it too.
    expect(modelChoiceForFlag("pi", "claude-sonnet-5-5")).toBeUndefined();
  });
});

describe("Pi's catalog from the host", () => {
  it("replaces the bundled rows and names each model by its upstream", () => {
    const choices = choicesFromCatalog("pi", hostCatalog);
    expect(choices.map((c) => c.flag)).toEqual(hostCatalog.models.map((m) => m.model));
    expect(choices.map((c) => c.model)).toEqual([
      "Claude Opus 5.5 · API",
      "Claude Sonnet 5.5 · API",
      "Claude Haiku 4.5 · API",
      "GPT-5.6 Sol · ChatGPT",
      "deepseek-flash · deepseek",
    ]);
    // The host's own display text is not what the picker shows.
    expect(choices.some((c) => c.model.includes(" · anthropic"))).toBe(false);
    // A listed model that is a bundled row is that row, so it keeps its id.
    expect(choices.find((c) => c.flag === "openai-codex/gpt-5.6-sol")?.id).toBe("pi:sol");
  });

  it("groups by upstream in the order the host listed them", () => {
    const groups = groupByUpstream(choicesFromCatalog("pi", hostCatalog));
    expect(groups.map((g) => g.upstream)).toEqual(["anthropic", "openai-codex", "deepseek"]);
    expect(groups.map((g) => g.heading)).toEqual(["Claude · Anthropic API", "Codex · ChatGPT login", "deepseek"]);
    expect(groups[0].models.map((m) => m.flag)).toEqual([
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-4-5-20251001",
    ]);
  });

  it("leaves Pi's default out of every group, and falls back to the bundled rows when the host sent none", () => {
    expect(groupByUpstream(providerFor("pi").models).flatMap((g) => g.models).some((m) => !m.flag)).toBe(false);
    const bundled = choicesFromCatalog("pi", { source: "bundled", models: [] });
    expect(bundled.map((c) => c.flag)).toEqual(providerFor("pi").models.map((m) => m.flag).filter(Boolean));
  });
});

describe("a registered Pi agent", () => {
  const agent = (over: Partial<TeamAgent>): TeamAgent => ({
    id: "a1", name: "Pi worker", role: "", agent: "pi", model: "anthropic/claude-sonnet-5-5", effort: "medium",
    access: "auto", projectId: null, reportsTo: null, teamId: null, ...over,
  } as TeamAgent);

  it("offers the bundled rows to a picker and labels a saved model, bare or named", () => {
    expect(teamModels("pi").map((m) => m.flag)).toContain("anthropic/claude-sonnet-5-5");
    expect(teamModelLabel(agent({}))).toBe("Claude Sonnet 5.5 · API");
    expect(teamModelLabel(agent({ model: "gpt-5.6-sol" }))).toBe("GPT-5.6 Sol · ChatGPT");
    // A model only the host's catalog lists is still read as a name.
    expect(teamModelLabel(agent({ model: "anthropic/claude-sonnet-4-6" }))).toBe("Claude Sonnet 4.6 · API");
  });

  it("opens a chat on the registration, with Auto taken as Accept edits", () => {
    const lead = leadSettings(agent({ model: "anthropic/claude-sonnet-4-6" }))!;
    expect(lead.choice.flag).toBe("anthropic/claude-sonnet-4-6");
    expect(lead.access).toBe("edits");
    expect(leadSettings(agent({ model: "gpt-5.6-luna" }))!.choice.id).toBe("pi:luna");
  });

  it("has a front-desk default the host takes", () => {
    expect(validModelFlag(frontDeskDefaults("pi").model, "pi")).toBe(true);
  });

  it("is named on a permission card", () => {
    expect(permissionAgent("pi")).toBe("Pi");
  });
});
