import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { OsPortal } from "./os/OsPortal";
import { WorldPortal } from "./os/world/WorldPortal";
import { ConfirmProvider } from "./components/Confirm";
import { OpenFileProvider } from "./components/OpenFile";
import "./styles.css";
import { applyTheme, savedThemeId } from "./lib/themeStore";

// Before render, not in an effect: the variables have to be on the root
// element by the first paint or a themed app flashes the built-in colours.
applyTheme(savedThemeId());

// Two focused portals, one client and one authenticated backend. The server
// already falls back to index.html for browser routes, so `/os` is a real
// bookmarkable mission-control surface rather than a hidden chat mode.
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
        <Portal />
      </OpenFileProvider>
    </ConfirmProvider>
  </StrictMode>,
);
