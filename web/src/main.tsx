import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmProvider } from "./components/Confirm";
import { OpenFileProvider } from "./components/OpenFile";
import "lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css";
import "@fontsource-variable/inter";
import "./design-system.css";
import "./styles.css";
import { applyTheme, savedThemeId } from "./lib/themeStore";

// Old pane URLs now open the same single workspace as every other chat link.
const launchUrl = new URL(window.location.href);
if (launchUrl.searchParams.has("pane") || launchUrl.searchParams.has("side")) {
  launchUrl.searchParams.delete("pane");
  launchUrl.searchParams.delete("side");
  history.replaceState(null, "", launchUrl.pathname + launchUrl.search + launchUrl.hash);
}

// Before render, not in an effect: the variables have to be on the root
// element by the first paint or a themed app flashes the built-in colours.
applyTheme(savedThemeId());

// Two focused portals, one client and one authenticated backend. The server
// already falls back to index.html for browser routes, so `/os` is a real
// bookmarkable mission-control surface rather than a hidden chat mode.
const App = lazy(() => import("./App"));
const OsPortal = lazy(() => import("./os/OsPortal").then(m => ({ default: m.OsPortal })));
const WorldPortal = lazy(() => import("./os/world/WorldPortal").then(m => ({ default: m.WorldPortal })));

const portalPath = window.location.pathname.replace(/\/+$/, "") || "/";
const Portal = portalPath === "/os"
  ? new URLSearchParams(window.location.search).get("view") === "legacy" ? OsPortal : WorldPortal
  : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      {/* Inside the confirm one: the file panel asks before throwing unsaved
          edits away. */}
      <OpenFileProvider>
        <Suspense fallback={<p role="status">Loading workspace…</p>}>
          <Portal />
        </Suspense>
      </OpenFileProvider>
    </ConfirmProvider>
  </StrictMode>,
);
