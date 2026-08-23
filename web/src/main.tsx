import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConfirmProvider } from "./components/Confirm";
import { OpenFileProvider } from "./components/OpenFile";
import "./styles.css";
import { applyTheme, savedThemeId } from "./lib/themeStore";

// Before render, not in an effect: the variables have to be on the root
// element by the first paint or a themed app flashes the built-in colours.
applyTheme(savedThemeId());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      {/* Inside the confirm one: the file panel asks before throwing unsaved
          edits away. */}
      <OpenFileProvider>
        <App />
      </OpenFileProvider>
    </ConfirmProvider>
  </StrictMode>,
);
