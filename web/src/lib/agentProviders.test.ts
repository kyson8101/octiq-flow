import { describe, expect, it } from "vitest";

import {
  accessFor,
  effortFor,
  liveSettingCommand,
  modelFromId,
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
  });

  it("scopes a command cache to its provider and migrates the Claude-only legacy shape", () => {
    const cache = parseCommandCache({
      project: ["compact", "context"],
      current: { claude: ["context"], codex: ["unsupported"] },
    });

    expect(cache).toEqual({
      project: { claude: ["compact", "context"] },
      current: { claude: ["context"], codex: ["unsupported"] },
    });
    expect(providerCommands("claude", cache.project.claude ?? [])).toHaveLength(2);
    // This is the regression: a cache from Claude is not a command menu for
    // Codex merely because both chats belong to the same project.
    expect(providerCommands("codex", cache.project.codex ?? [])).toEqual([]);
  });
});
