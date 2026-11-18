import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import { teamModels } from "./agentsMode";
import { choicesFromCatalog, type ModelCatalog } from "./modelCatalog";
import type { ModelChoice, Provider } from "./agentProviders";

/** What the host's catalog said for a provider, kept for the page's life so
 *  several pickers (Agents, fallback, the composer) ask once. */
const read = new Map<Provider, ModelChoice[]>();
const asked = new Map<Provider, Promise<ModelChoice[] | null>>();

/** Pi's models are the host's to say (`pi --list-models`, for the logins that
 *  are ready), so a registered agent or a fallback offers them from there. The
 *  other providers keep their authored list here; their pickers are unchanged.
 *  Until the catalog is read, and when it cannot be, the bundled rows stand. */
export function useTeamModels(provider: Provider): ModelChoice[] {
  const [, bump] = useState(0);
  useEffect(() => {
    if (provider !== "pi" || read.has(provider)) return;
    let live = true;
    let pending = asked.get(provider);
    if (!pending) {
      pending = bridge
        .invoke<ModelCatalog>("agent_models", { agent: provider })
        .then((catalog) => {
          const choices = choicesFromCatalog(provider, catalog);
          if (choices.length) read.set(provider, choices);
          return choices;
        })
        .catch(() => null)
        .finally(() => asked.delete(provider));
      asked.set(provider, pending);
    }
    void pending.then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [provider]);
  return read.get(provider) ?? teamModels(provider);
}
