import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The scraper endpoints (app/server.py) are still Flask-backed until phase
  // 3 rewires them onto the in-browser database too -- see the TODO in
  // src/api.js -- so the dev-server proxy for /api stays for now.
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
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
