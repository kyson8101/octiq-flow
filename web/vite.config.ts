// `vitest/config`, not `vite`, so the `test` block below type-checks.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The server is the shipped app, so its Cargo package version is the release
// version. Read it here instead of keeping a second frontend version in sync.
const cargoManifest = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const appVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoManifest)?.[1];

if (!appVersion) throw new Error("Could not read the OctiqFlow version from src-tauri/Cargo.toml");

// The frontend is served two ways and must work the same in both:
//   · dev            — this dev server, talking to the Rust app over its WS
//   · production     — built to web/dist and served BY the Rust app (web.rs),
//                      at the root
// `base: "./"` keeps the built asset URLs relative, so the bundle does not
// bake in the path it is mounted at.
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { port: 5273, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  // Themes are pasted in verbatim as `.css` and read with `?raw`. Vitest stubs
  // CSS to an empty string by default, `?raw` included, which turned every
  // theme into an empty token map — silently, since the mapper has fallbacks
  // for every field. This makes the runner hand the file over as written.
  test: { css: true },
});
