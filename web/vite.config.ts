import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The v2 frontend is served two ways and must work the same in both:
//   · dev            — this dev server, talking to the Rust app over its WS
//   · production     — built to web/dist and served BY the Rust app (web.rs)
// `base: "./"` keeps the built asset URLs relative, so the same bundle works
// whether it is mounted at / or under a prefix.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
