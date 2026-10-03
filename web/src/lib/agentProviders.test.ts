import { describe, expect, it } from "vitest";

import {
  accessFor,
  claudeModelName,
  effortFor,
  liveSettingCommand,
  modelChoiceForFlag,
  modelFromId,
  modelFromReported,
  parseCommandCache,
  providerCommands,
  providers,
  type AgentProvider,
} from "./agentProviders";

/** A provider conformance harness. Add a provider to `providers` and this runs
 * against every one of its models and advertised UI capabilities. Provider
 * adapters get small focused tests only when they add behavior beyond this
 * common contract. */
function checkProvider(provider: AgentProvider) {
  expect(provider.models.length).toBeGreaterThan(0);
  expect(provider.access.length).toBeGreaterThan(0);
  expect(provider.efforts.length).toBeGreaterThan(0);

  const accessIds = new Set(provider.access.map((option) => option.id));
  const effortIds = new Set(provider.efforts.map((option) => option.id));
  expect(accessIds.size).toBe(provider.access.length);
  expect(effortIds.size).toBe(provider.efforts.length);

  for (const model of provider.models) {
    expect(model.agent).toBe(provider.id);
    expect(model.composerStyle).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(modelFromId(model.id)).toEqual(model);
    const command = liveSettingCommand(provider.id, "model", model.flag);
    expect(Boolean(command)).toBe(provider.capabilities.liveSettings.model && Boolean(model.flag));
  }

  for (const access of provider.access) {
    expect(accessFor(provider.id, access.id)).toBe(access.id);
  }
  for (const effort of provider.efforts) {
    expect(effortFor(provider.id, effort.id)).toBe(effort.id);
    expect(Boolean(liveSettingCommand(provider.id, "effort", effort.id))).toBe(
      provider.capabilities.liveSettings.effort,
    );
  }

  const reported = ["context", "compact", "/context", "bad command"];
  const commands = providerCommands(provider.id, reported);
  if (provider.capabilities.commands === "none") {
    expect(commands).toEqual([]);
  } else {
    expect(commands).toEqual([
      { id: "context", label: "/context", insert: "/context " },
      { id: "compact", label: "/compact", insert: "/compact " },
    ]);
  }
}

describe("AgentProvider UI contract", () => {
  it("keeps every registered provider and model conformant", () => {
    for (const provider of Object.values(providers)) checkProvider(provider);

    const styles = Object.values(providers).flatMap((provider) =>
      provider.models.map((model) => model.composerStyle),
    );
    // Versioned models intentionally share their family's visual voice.
    expect(styles.every((style) => /^[a-z][a-z0-9-]*$/.test(style))).toBe(true);
  });

  it("keeps moving aliases distinct from pinned Claude model ids", () => {
    expect(modelFromId("claude:opus")?.flag).toBe("opus");
    expect(modelFromId("claude:opus-4-6")?.flag).toBe("claude-opus-4-6");
    expect(modelFromReported("claude", "claude-opus-4-6")?.id).toBe("claude:opus-4-6");
    expect(modelFromReported("claude", "claude-opus-5-1")?.flag).toBe("claude-opus-5-1");
  });

  it("pins Opus 5.5 and Sonnet 5.5 to their own rows, never the moving alias", () => {
    for (const [family, label] of [["opus", "Opus 5.5"], ["sonnet", "Sonnet 5.5"]] as const) {
      const flag = `claude-${family}-5-5`;
      const byId = modelFromId(`claude:${family}-5-5`);
      expect(byId?.flag).toBe(flag);
      expect(byId?.model).toBe(label);
      expect(byId?.composerStyle).toBe(family);
      const reported = modelFromReported("claude", flag);
      expect(reported?.id).toBe(`claude:${family}-5-5`);
      expect(reported?.flag).not.toBe(family);
    }
    const flags = providers.claude.models.map((model) => model.flag);
    expect(flags.indexOf("claude-opus-5-5") + 1).toBe(flags.indexOf("claude-opus-5"));
    expect(flags.indexOf("claude-sonnet-5-5") + 1).toBe(flags.indexOf("claude-sonnet-5"));
    // An id the list has never heard of keeps its two-part version too.
    expect(modelChoiceForFlag("claude", "claude-haiku-5-5")?.model).toBe("Haiku 5.5");
  });

  it("round-trips a newly discovered exact model through persisted state", () => {
    const choice = modelChoiceForFlag("codex", "gpt-5.7-new", "GPT-5.7 New");
    expect(choice?.model).toBe("GPT-5.7 New");
    expect(choice?.flag).toBe("gpt-5.7-new");
    expect(modelFromId(choice!.id)).toEqual(choice);
  });

  it("scopes a command cache to its provider and migrates the Claude-only legacy shape", () => {
    const cache = parseCommandCache({
      project: ["compact", "context"],
      current: { claude: ["context"], codex: ["release", "release", "bad command"] },
    });

    expect(cache).toEqual({
      project: { claude: ["compact", "context"] },
      current: { claude: ["context"], codex: ["release", "release", "bad command"] },
    });
    expect(providerCommands("claude", cache.project.claude ?? [])).toHaveLength(2);
    // Each provider still reads only its own cache entry. Codex's loaded skill
    // names use the same slash-completion shape as Claude's reported commands.
    expect(providerCommands("codex", cache.project.codex ?? [])).toEqual([]);
    expect(providerCommands("codex", cache.current.codex ?? [])).toEqual([
      { id: "release", label: "/release", insert: "/release " },
    ]);
  });
});

describe("claudeModelName", () => {
  it("names a pinned Claude id by family and version", () => {
    expect(claudeModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(claudeModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(claudeModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(claudeModelName("claude-opus-4-6")).toBe("Opus 4.6");
  });

  it("drops a date suffix instead of reading it as a version", () => {
    expect(claudeModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(claudeModelName("claude-opus-4-5-20251101")).toBe("Opus 4.5");
  });

  it("never gives a moving alias a version", () => {
    expect(claudeModelName("sonnet")).toBe("Sonnet");
    expect(claudeModelName("opus")).toBe("Opus");
    expect(claudeModelName("haiku")).toBe("Haiku");
    expect(claudeModelName("fable")).toBe("Fable");
  });

  it("keeps the version of an id it has never seen", () => {
    expect(claudeModelName("claude-opus-5-1")).toBe("Opus 5.1");
    expect(claudeModelName("claude-fable-5-1")).toBe("Fable 5.1");
  });

  it("drops a context tag, which is not part of the version", () => {
    expect(claudeModelName("claude-opus-4-6[1m]")).toBe("Opus 4.6");
  });

  it("leaves every other id to the caller", () => {
    for (const id of ["gpt-5.6-terra", "gpt-6-astra", "codex", "inherit", "", "claude-3-5-sonnet-20241022"]) {
      expect(claudeModelName(id)).toBeUndefined();
    }
  });
});

describe("Antigravity", () => {
  const agy = providers.antigravity;

  it("offers the models agy lists, each as its own exact id", () => {
    const flags = agy.models.map((model) => model.flag);
    expect(flags).toContain("gemini-3.8-flash-high");
    expect(flags).toContain("gemini-3.1-pro-high");
    expect(flags).toContain("");
    expect(agy.models.every((model) => model.agent === "antigravity" && model.composerStyle === "antigravity")).toBe(true);
    // A newly listed id is still a choice, in Antigravity's own voice.
    expect(modelChoiceForFlag("antigravity", "gemini-3.9-flash-high", "Gemini 3.9 Flash (High)")).toMatchObject({
      model: "Gemini 3.9 Flash (High)",
      composerStyle: "antigravity",
    });
  });

  it("says what each access level refuses or runs unasked, since no card can ask", () => {
    expect(agy.access.map((a) => a.id)).toEqual(["read", "edits", "auto", "full"]);
    expect(agy.access.find((a) => a.id === "edits")?.hint).toMatch(/shell commands are refused/);
    expect(agy.access.find((a) => a.id === "auto")?.label).toMatch(/unguarded/);
    // One bypass switch per list: Skip permissions.
    expect(agy.access.filter((a) => a.bypass).map((a) => a.id)).toEqual(["full"]);
    expect(agy.accessNote).toMatch(/no permission card can appear/);
    expect(accessFor("antigravity", "manual")).toBe("read");
    expect(accessFor("antigravity", "auto")).toBe("auto");
  });

  it("leaves the effort to the model unless asked, as an id names its own", () => {
    expect(agy.efforts[0].id).toBe("auto");
    expect(effortFor("antigravity", "ultracode")).toBe("auto");
    expect(effortFor("antigravity", "max")).toBe("max");
  });
});
