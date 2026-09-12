import { useEffect, useState } from "react";
import { applyTheme, BUILT_IN, savedThemeId, THEME_EVENT, themeById } from "../lib/themeStore";

/** The same appearance control is available from either OS portal. */
export function AppearanceToggle() {
  const [id, setId] = useState(savedThemeId);
  useEffect(() => {
    const changed = () => setId(savedThemeId());
    window.addEventListener(THEME_EVENT, changed);
    return () => window.removeEventListener(THEME_EVENT, changed);
  }, []);
  const light = themeById(id).scheme === "light";
  const label = `Switch to ${light ? "dark" : "light"} appearance`;
  return (
    <button className="appearance-toggle" type="button" title={label} aria-label={label}
      onClick={() => applyTheme(light ? BUILT_IN : "one-light")}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {light ? <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" /> : <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </>}
      </svg>
    </button>
  );
}
