import { useSyncExternalStore } from "react";
import { currentThemeId, THEME_EVENT } from "./themeStore";

function subscribe(changed: () => void) {
  window.addEventListener(THEME_EVENT, changed);
  return () => window.removeEventListener(THEME_EVENT, changed);
}

/** App and the sidebar read the same applied palette, including changes
 *  made before subscribing and choices that could not be persisted. */
export function useThemeId(): string {
  return useSyncExternalStore(subscribe, currentThemeId, currentThemeId);
}
