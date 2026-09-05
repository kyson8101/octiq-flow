// The UI-facing half of an agent integration.
//
// The backend owns process creation and stream normalization in its
// `AgentProvider` trait. This registry owns the corresponding UI facts: which
// settings a provider offers, which reported commands it exposes, and which
// settings can change inside an existing session. Keeping those facts together
// means a new provider is an adapter here, not another set of `if (claude)`
// checks across the composer and App.

export type Provider = "claude" | "codex";

/** A model's visual voice in the composer. The names are deliberately model
 * specific: adding a model means choosing how it looks instead of silently
 * inheriting whichever provider style happened to be there first. */
export type ComposerStyle =
  | "opus"
  | "sonnet"
  | "haiku"
  | "fable"
  | "claude"
  | "astra"
  | "sol"
  | "terra"
  | "luna"
  | "codex";

export type ModelChoice = {
  id: string;
  agent: Provider;
  name: string;
  model: string;
  /** What the backend passes as --model / -m. Empty = the provider default. */
  flag: string;
  hint: string;
  /** Selects the composer's scoped colour and surface treatment. */
  composerStyle: ComposerStyle;
};

/** The shared wire vocabulary. Each provider deliberately offers a subset. */
export type AccessLevel = "read" | "manual" | "edits" | "auto" | "full";

export type AccessOption = {
  id: AccessLevel;
  label: string;
  hint: string;
  bypass?: boolean;
};

export type Effort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultracode"
  | "auto";

export type EffortOption = {
  id: Effort;
  label: string;
  short: string;
  hint: string;
};

/** A command the composer may autocomplete. `insert` keeps syntax local to its
 * provider in case another provider does not use Claude-style slash commands. */
export type AgentCommand = {
  id: string;
  label: string;
  insert: string;
};

export type LiveSetting = "model" | "effort";

export type AgentCapabilities = {
  commands: "reported" | "loaded" | "none";
  liveSettings: Readonly<Record<LiveSetting, boolean>>;
  cleanStart: boolean;
};

export interface AgentProvider {
  readonly id: Provider;
  readonly name: string;
  readonly models: readonly ModelChoice[];
  readonly access: readonly AccessOption[];
  readonly efforts: readonly EffortOption[];
  readonly capabilities: AgentCapabilities;
  /** Turns provider-reported commands into the composer’s common shape. */
  commands(source: readonly string[]): readonly AgentCommand[];
  /** The provider-native command for a live setting, when it supports one. */
  liveSettingCommand(setting: LiveSetting, value: string): string | undefined;
}

function slashCommands(reported: readonly string[]): readonly AgentCommand[] {
  const seen = new Set<string>();
  const out: AgentCommand[] = [];
  for (const raw of reported) {
    const id = raw.trim().replace(/^\/+/, "");
    // A whitespace command cannot be completed safely, and keeping the id
    // restrictive means a malformed stream cannot turn the menu into a second
    // prompt surface.
    if (!id || /\s/.test(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({ id, label: `/${id}`, insert: `/${id} ` });
  }
  return out;
}

export const providers = {
  claude: {
    id: "claude",
    name: "Claude",
    models: [
      { id: "claude:opus", agent: "claude", name: "Claude", model: "Opus", flag: "opus", hint: "for complex work", composerStyle: "opus" },
      { id: "claude:sonnet", agent: "claude", name: "Claude", model: "Sonnet", flag: "sonnet", hint: "the everyday balance", composerStyle: "sonnet" },
      { id: "claude:haiku", agent: "claude", name: "Claude", model: "Haiku", flag: "haiku", hint: "fastest, for quick answers", composerStyle: "haiku" },
      { id: "claude:fable", agent: "claude", name: "Claude", model: "Fable", flag: "fable", hint: "for the toughest problems", composerStyle: "fable" },
      { id: "claude:default", agent: "claude", name: "Claude", model: "Default", flag: "", hint: "whatever the CLI picks", composerStyle: "claude" },
    ],
    access: [
      { id: "read", label: "Plan", hint: "create a plan before making changes" },
      { id: "manual", label: "Manual", hint: "always ask before making changes" },
      { id: "edits", label: "Accept edits", hint: "automatically accept all file edits" },
      { id: "auto", label: "Auto", hint: "Claude handles permission decisions" },
      { id: "full", label: "Bypass permissions", hint: "run anything without asking", bypass: true },
    ],
    efforts: [
      { id: "low", label: "Low", short: "Low", hint: "quick answers, least thinking" },
      { id: "medium", label: "Medium", short: "Med", hint: "the usual balance" },
      { id: "high", label: "High", short: "High", hint: "thinks longer, costs more" },
      { id: "xhigh", label: "Very high", short: "V.high", hint: "for problems worth the wait" },
      { id: "max", label: "Max", short: "Max", hint: "everything it has" },
      { id: "ultracode", label: "Ultracode", short: "Ultra", hint: "max, and it fans work out to subagents" },
      { id: "auto", label: "Auto", short: "Auto", hint: "it picks the level itself, per turn" },
    ],
    capabilities: {
      commands: "reported",
      liveSettings: { model: true, effort: true },
      cleanStart: true,
    },
    commands: slashCommands,
    liveSettingCommand(setting, value) {
      if (!value) return undefined;
      return setting === "model" ? `/model ${value}` : `/effort ${value}`;
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    models: [
      { id: "codex:astra", agent: "codex", name: "Codex", model: "Astra", flag: "gpt-6-astra", hint: "the frontier one", composerStyle: "astra" },
      { id: "codex:sol", agent: "codex", name: "Codex", model: "Sol", flag: "gpt-5.6-sol", hint: "the reliable workhorse", composerStyle: "sol" },
      { id: "codex:terra", agent: "codex", name: "Codex", model: "Terra", flag: "gpt-5.6-terra", hint: "the everyday balance", composerStyle: "terra" },
      { id: "codex:luna", agent: "codex", name: "Codex", model: "Luna", flag: "gpt-5.6-luna", hint: "fast and cheap", composerStyle: "luna" },
      { id: "codex:default", agent: "codex", name: "Codex", model: "Default", flag: "", hint: "whatever the CLI picks", composerStyle: "codex" },
    ],
    access: [
      { id: "read", label: "Read-only", hint: "sandboxed, no writes" },
      { id: "auto", label: "Workspace write", hint: "writes in the project, asks when unsure" },
      { id: "full", label: "Danger: full access", hint: "no sandbox, no approvals" },
    ],
    efforts: [
      { id: "low", label: "Low", short: "Low", hint: "quick answers" },
      { id: "medium", label: "Medium", short: "Med", hint: "the usual balance" },
      { id: "high", label: "High", short: "High", hint: "thinks longer, costs more" },
      { id: "xhigh", label: "Very high", short: "V.high", hint: "for problems worth the wait" },
      { id: "max", label: "Max", short: "Max", hint: "everything it has" },
    ],
    capabilities: {
      commands: "loaded",
      liveSettings: { model: false, effort: false },
      cleanStart: false,
    },
    commands: slashCommands,
    liveSettingCommand() {
      return undefined;
    },
  },
} satisfies Record<Provider, AgentProvider>;

export function providerFor(provider: Provider): AgentProvider {
  return providers[provider];
}

export const PROVIDERS = Object.values(providers) as AgentProvider[];
export const MODELS = PROVIDERS.flatMap((provider) => provider.models);
export const AGENT_NAME = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider.name]),
) as Record<Provider, string>;

/** Kept as a record for the components which index directly from the chosen
 * provider. The provider adapters above remain its single source of truth. */
export const ACCESS = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider.access]),
) as Record<Provider, readonly AccessOption[]>;
export const EFFORTS = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider.efforts]),
) as Record<Provider, readonly EffortOption[]>;

export function modelFromId(id: string | null): ModelChoice | undefined {
  if (!id) return undefined;
  const exact = MODELS.find((model) => model.id === id);
  if (exact) return exact;
  const provider = id.split(":")[0] as Provider;
  return providers[provider]?.models[0];
}

export function accessFor(provider: Provider, wanted: AccessLevel): AccessLevel {
  const options = providerFor(provider).access;
  return options.some((option) => option.id === wanted) ? wanted : options[0].id;
}

export function accessLabel(provider: Provider, access: AccessLevel): string {
  return providerFor(provider).access.find((option) => option.id === access)?.label ?? access;
}

export function effortSteps(provider: Provider): readonly EffortOption[] {
  return providerFor(provider).efforts.filter((effort) => effort.id !== "auto");
}

export function effortFor(provider: Provider, wanted: Effort): Effort {
  const efforts = providerFor(provider).efforts;
  return efforts.some((effort) => effort.id === wanted) ? wanted : efforts[0].id;
}

export function providerCommands(provider: Provider, source: readonly string[]): readonly AgentCommand[] {
  return providerFor(provider).commands(source);
}

export function liveSettingCommand(
  provider: Provider,
  setting: LiveSetting,
  value: string,
): string | undefined {
  return providerFor(provider).liveSettingCommand(setting, value);
}

/** The v1 cache keyed commands only by project. Those entries could only have
 * come from Claude, because Codex does not report a slash-command catalog. */
export type CommandCache = Record<string, Partial<Record<Provider, string[]>>>;

export function parseCommandCache(value: unknown): CommandCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: CommandCache = {};
  for (const [projectId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(entry)) {
      const commands = entry.filter((command): command is string => typeof command === "string");
      if (commands.length) out[projectId] = { claude: commands };
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const byProvider: Partial<Record<Provider, string[]>> = {};
    for (const provider of Object.keys(providers) as Provider[]) {
      const commands = (entry as Record<string, unknown>)[provider];
      if (Array.isArray(commands)) {
        const strings = commands.filter((command): command is string => typeof command === "string");
        if (strings.length) byProvider[provider] = strings;
      }
    }
    if (Object.keys(byProvider).length) out[projectId] = byProvider;
  }
  return out;
}
