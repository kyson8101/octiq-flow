import { describe, expect, it } from "vitest";

import {
  accessFor,
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
