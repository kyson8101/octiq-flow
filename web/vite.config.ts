import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend is served two ways and must work the same in both:
//   · dev            — this dev server, talking to the Rust app over its WS
//   · production     — built to web/dist and served BY the Rust app (web.rs),
//                      at the root
// `base: "./"` keeps the built asset URLs relative, so the bundle does not
// bake in the path it is mounted at.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
