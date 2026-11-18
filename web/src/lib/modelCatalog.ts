import {
  modelChoiceForFlag,
  piModelRef,
  piUpstreamHeading,
  providerFor,
  type ModelChoice,
  type Provider,
} from "./agentProviders";

/** Provider-native model metadata returned by the backend. */
export type DiscoveredModel = {
  model: string;
  displayName: string;
  description?: string | null;
  isDefault?: boolean;
  supportedEfforts?: string[];
};

export type ModelCatalog = {
  source: "provider" | "bundled" | string;
  models: DiscoveredModel[];
  note?: string | null;
};

/** Merge discovery into authored fallback choices.
 *
 * Moving aliases remain first because they are a useful explicit choice, but
 * a provider's versioned rows replace matching fallbacks and can add models an
 * OctiqFlow release has never heard of. The provider order is preserved: that
 * is the order its own picker recommends. */
export function choicesFromCatalog(
  provider: Provider,
  catalog: ModelCatalog,
): ModelChoice[] {
  const fallback = providerFor(provider).models.filter((choice) => choice.flag);
  const aliases = provider === "claude"
    ? fallback.filter((choice) => ["opus", "sonnet", "haiku", "fable"].includes(choice.flag))
    : [];
  const discovered = catalog.models.flatMap((entry) => {
    const choice = modelChoiceForFlag(
      provider,
      entry.model,
      entry.displayName,
      entry.description ?? entry.model,
    );
    return choice ? [choice] : [];
  });

  const output: ModelChoice[] = [];
  const seen = new Set<string>();
  const bundledFallback = catalog.source === "bundled" ? fallback : [];
  for (const choice of [...aliases, ...discovered, ...bundledFallback]) {
    const key = choice.flag.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(choice);
  }
  return output;
}

/** Pi's models as the host listed them, one group to an upstream in the order
 *  the upstreams first appear: the upstream is who bills the model, so a
 *  Claude model through the API and the same name elsewhere are told apart. A
 *  choice with no id of its own (Pi's default) has no upstream and no group. */
export function groupByUpstream(
  models: readonly ModelChoice[],
): { upstream: string; heading: string; models: ModelChoice[] }[] {
  const groups: { upstream: string; heading: string; models: ModelChoice[] }[] = [];
  for (const model of models) {
    if (!model.flag) continue;
    const upstream = piModelRef(model.flag).upstream;
    const group = groups.find((g) => g.upstream === upstream);
    if (group) group.models.push(model);
    else groups.push({ upstream, heading: piUpstreamHeading(upstream), models: [model] });
  }
  return groups;
}
