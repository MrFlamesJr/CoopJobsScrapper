import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // No more Flask backend to proxy /api to: jobs/facets/favorites/export
  // come from the in-browser SQLite worker (src/db) and the scraper talks to
  // the CoopJobs extension via window.postMessage (src/extensionBridge.js).
  build: {
    outDir: "dist",
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
