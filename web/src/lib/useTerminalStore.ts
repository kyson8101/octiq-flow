import { useCallback, useState } from "react";
import { parseStore, tabsFor, type Store, type Tabs } from "./terminals";

const TERMS_KEY = "octiq.v2.terminals";

/** App owns the tabs even while the drawer is hidden. Both entry points use
 * the same functional update, so a Run never overwrites a newly opened tab. */
export function useTerminalStore() {
  const [store, setStore] = useState<Store>(() => {
    try { return parseStore(localStorage.getItem(TERMS_KEY)); }
    catch { return {}; }
  });
  const update = useCallback((projectId: string, change: (tabs: Tabs) => Tabs) => {
    setStore((previous) => {
      const next = { ...previous, [projectId]: change(tabsFor(previous, projectId)) };
      try { localStorage.setItem(TERMS_KEY, JSON.stringify(next)); }
      catch { /* Tabs still work for this session. */ }
      return next;
    });
  }, []);
  return { store, update };
}
