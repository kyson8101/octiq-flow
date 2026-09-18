// The UI-facing half of an agent integration.
//
// The backend owns process creation and stream normalization in its
// `AgentProvider` trait. This registry owns the corresponding UI facts: which
// settings a provider offers, which reported commands it exposes, and which
// settings can change inside an existing session. Keeping those facts together
// means a new provider is an adapter here, not another set of `if (claude)`
// checks across the composer and App.

export type Provider = "claude" | "codex" | "pi";

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
  | "codex"
  | "pi-astra"
  | "pi-sol"
  | "pi-terra"
  | "pi-luna"
  | "pi";

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
      // Aliases deliberately say "latest": choosing `opus` is permission for
      // Claude Code to move to a newer Opus. The versioned rows below are the
      // distinct choice for someone who wants 4.6 to remain 4.6.
      { id: "claude:opus", agent: "claude", name: "Claude", model: "Opus latest", flag: "opus", hint: "for complex work · moving alias opus", composerStyle: "opus" },
      { id: "claude:sonnet", agent: "claude", name: "Claude", model: "Sonnet latest", flag: "sonnet", hint: "the everyday balance · moving alias sonnet", composerStyle: "sonnet" },
      { id: "claude:haiku", agent: "claude", name: "Claude", model: "Haiku latest", flag: "haiku", hint: "fastest for quick answers · moving alias haiku", composerStyle: "haiku" },
      { id: "claude:fable", agent: "claude", name: "Claude", model: "Fable latest", flag: "fable", hint: "for the toughest problems · moving alias fable", composerStyle: "fable" },
      { id: "claude:opus-5", agent: "claude", name: "Claude", model: "Opus 5", flag: "claude-opus-5", hint: "claude-opus-5", composerStyle: "opus" },
      { id: "claude:opus-4-8", agent: "claude", name: "Claude", model: "Opus 4.8", flag: "claude-opus-4-8", hint: "claude-opus-4-8", composerStyle: "opus" },
      { id: "claude:opus-4-7", agent: "claude", name: "Claude", model: "Opus 4.7", flag: "claude-opus-4-7", hint: "claude-opus-4-7", composerStyle: "opus" },
      { id: "claude:opus-4-6", agent: "claude", name: "Claude", model: "Opus 4.6", flag: "claude-opus-4-6", hint: "claude-opus-4-6", composerStyle: "opus" },
      { id: "claude:opus-4-5-20251101", agent: "claude", name: "Claude", model: "Opus 4.5", flag: "claude-opus-4-5-20251101", hint: "claude-opus-4-5-20251101", composerStyle: "opus" },
      { id: "claude:sonnet-5", agent: "claude", name: "Claude", model: "Sonnet 5", flag: "claude-sonnet-5", hint: "claude-sonnet-5", composerStyle: "sonnet" },
      { id: "claude:sonnet-4-6", agent: "claude", name: "Claude", model: "Sonnet 4.6", flag: "claude-sonnet-4-6", hint: "claude-sonnet-4-6", composerStyle: "sonnet" },
      { id: "claude:sonnet-4-5-20250929", agent: "claude", name: "Claude", model: "Sonnet 4.5", flag: "claude-sonnet-4-5-20250929", hint: "claude-sonnet-4-5-20250929", composerStyle: "sonnet" },
      { id: "claude:haiku-4-5-20251001", agent: "claude", name: "Claude", model: "Haiku 4.5", flag: "claude-haiku-4-5-20251001", hint: "claude-haiku-4-5-20251001", composerStyle: "haiku" },
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
  pi: {
    id: "pi",
    name: "pi.dev",
    // Pi is the harness here; OpenAI Codex is its selected upstream provider.
    // Keep the same model names and visual voices as a direct Codex chat so
    // choosing the harness does not make the underlying model look different.
    models: [
      { id: "pi:astra", agent: "pi", name: "pi.dev", model: "Astra", flag: "gpt-6-astra", hint: "Codex through pi.dev", composerStyle: "pi-astra" },
      { id: "pi:sol", agent: "pi", name: "pi.dev", model: "Sol", flag: "gpt-5.6-sol", hint: "Codex through pi.dev", composerStyle: "pi-sol" },
      { id: "pi:terra", agent: "pi", name: "pi.dev", model: "Terra", flag: "gpt-5.6-terra", hint: "Codex through pi.dev", composerStyle: "pi-terra" },
      { id: "pi:luna", agent: "pi", name: "pi.dev", model: "Luna", flag: "gpt-5.6-luna", hint: "Codex through pi.dev", composerStyle: "pi-luna" },
      { id: "pi:default", agent: "pi", name: "pi.dev", model: "Default", flag: "", hint: "whatever Pi picks", composerStyle: "pi" },
    ],
    // Pi JSON mode does not expose a tool approval handshake. Read-only is a
    // strict tool allowlist; Full access is an explicit opt-in to all built-ins.
    access: [
      { id: "read", label: "Read-only", hint: "only read, search and list tools" },
      { id: "full", label: "Full access", hint: "Pi can run commands and edit files", bypass: true },
    ],
    efforts: [
      { id: "minimal", label: "Minimal", short: "Min", hint: "the least reasoning" },
      { id: "low", label: "Low", short: "Low", hint: "quick answers" },
      { id: "medium", label: "Medium", short: "Med", hint: "the usual balance" },
      { id: "high", label: "High", short: "High", hint: "thinks longer, costs more" },
      { id: "xhigh", label: "Very high", short: "V.high", hint: "for problems worth the wait" },
      { id: "max", label: "Max", short: "Max", hint: "everything it has" },
    ],
    capabilities: {
      commands: "none",
      liveSettings: { model: false, effort: false },
      cleanStart: false,
    },
    commands() {
      return [];
    },
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

const DYNAMIC_MODEL_ID = ":model:";

/** Provider model ids are command-line tokens. Match the backend's allowlist
 * here so an exact-id field can fail before it creates a choice the runtime
 * will silently discard. */
export function validModelFlag(flag: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(flag);
}

function titleWord(word: string): string {
  if (/^gpt$/i.test(word)) return "GPT";
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function modelLabel(provider: Provider, flag: string, displayName?: string): string {
  if (displayName?.trim()) {
    return displayName.trim().replace(/^Claude\s+/i, "");
  }
  if (provider === "claude") {
    const parts = flag.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
    const family = titleWord(parts.shift() ?? flag);
    return parts.length ? `${family} ${parts.join(".")}` : family;
  }
  const parts = flag.split("-");
  if (/^gpt$/i.test(parts[0] ?? "")) {
    const family = titleWord(parts.shift()!);
    const version = parts.shift() ?? "";
    return [family + (version ? `-${version}` : ""), ...parts.map(titleWord)].join(" ");
  }
  return flag;
}

function styleForModel(provider: Provider, flag: string): ComposerStyle {
  const lower = flag.toLowerCase();
  if (provider === "claude") {
    if (lower.includes("opus")) return "opus";
    if (lower.includes("sonnet")) return "sonnet";
    if (lower.includes("haiku")) return "haiku";
    if (lower.includes("fable")) return "fable";
    return "claude";
  }
  if (provider === "codex") {
    if (lower.includes("astra")) return "astra";
    if (lower.includes("sol")) return "sol";
    if (lower.includes("terra")) return "terra";
    if (lower.includes("luna")) return "luna";
    return "codex";
  }
  if (lower.includes("astra")) return "pi-astra";
  if (lower.includes("sol")) return "pi-sol";
  if (lower.includes("terra")) return "pi-terra";
  if (lower.includes("luna")) return "pi-luna";
  return "pi";
}

/** Turn a provider-discovered or manually entered exact id into the same
 * choice shape as a built-in model. Known flags reuse their authored label and
 * visual voice; newly released flags remain fully selectable and persistable. */
export function modelChoiceForFlag(
  provider: Provider,
  flag: string,
  displayName?: string,
  hint?: string,
): ModelChoice | undefined {
  const wanted = flag.trim();
  if (!validModelFlag(wanted)) return undefined;
  const known = providerFor(provider).models.find((model) => model.flag === wanted);
  if (known) return known;
  return {
    id: `${provider}${DYNAMIC_MODEL_ID}${encodeURIComponent(wanted)}`,
    agent: provider,
    name: providerFor(provider).name,
    model: modelLabel(provider, wanted, displayName),
    flag: wanted,
    hint: hint?.trim() || wanted,
    composerStyle: styleForModel(provider, wanted),
  };
}

export function modelFromId(id: string | null): ModelChoice | undefined {
  if (!id) return undefined;
  const exact = MODELS.find((model) => model.id === id);
  if (exact) return exact;
  const provider = id.split(":")[0] as Provider;
  const marker = id.indexOf(DYNAMIC_MODEL_ID);
  if (providers[provider] && marker > 0) {
    try {
      return modelChoiceForFlag(provider, decodeURIComponent(id.slice(marker + DYNAMIC_MODEL_ID.length)));
    } catch {
      return undefined;
    }
  }
  return providers[provider]?.models[0];
}

/** Resolve the exact model an agent reported. Never substring-match a moving
 * alias: a newly released `claude-opus-5-1` contains `opus`, but choosing the
 * alias would erase the version that actually answered. */
export function modelFromReported(provider: Provider, reported: string): ModelChoice | undefined {
  const value = reported.trim();
  if (!value) return providerFor(provider).models.find((model) => !model.flag);
  const offered = providerFor(provider).models.filter((model) => model.flag);
  const exact = offered.find((model) => model.flag === value);
  return exact ?? modelChoiceForFlag(provider, value);
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
