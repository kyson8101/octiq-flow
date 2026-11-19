import { useCallback, useEffect, useMemo, useState } from "react";
import { loadAgents, type AgentInstall } from "./agentInstalls";
import type { Provider } from "./agentProviders";

/** Which agent CLIs this machine has. Asked once on arrival: it decides what
 *  the model picker may offer, so it is not only the Agents page's business. */
export function useInstalledAgents(): Provider[] | undefined {
  const [agents, setAgents] = useState<AgentInstall[]>([]);

  /** Ask the backend which agent CLIs resolve on this machine.
   *
   *  Fails SOFT, to an empty list: a backend too old to know this command still
   *  has to be usable, and "we could not ask" must never read as "nothing is
   *  installed". Everything downstream treats an empty list as "no answer" and
   *  offers every agent, exactly as it did before this page existed. */
  const loadAgentList = useCallback((refresh?: boolean) => {
    loadAgents(refresh === true)
      .then((list) => setAgents(list ?? []))
      .catch(() => setAgents([]));
  }, []);

  useEffect(loadAgentList, [loadAgentList]);

  /** The agents this machine has, or undefined while we have no answer.
   *  Undefined and empty mean different things downstream — "could not ask" vs
   *  "asked, has none" — so they are kept apart rather than both being []. */
  const installed: Provider[] | undefined = useMemo(
    () => (agents.length > 0 ? agents.filter((a) => a.installed).map((a) => a.id) : undefined),
    [agents],
  );
  return installed;
}
