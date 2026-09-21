import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";

// Dev-only sink for src/devLog.js: appends each posted line to .devlogs/.
function devLogSink() {
  return {
    name: "devlog-sink",
    configureServer(server) {
      fs.mkdirSync(".devlogs", { recursive: true });
      server.middlewares.use("/__devlog", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          fs.appendFileSync(".devlogs/scrape.jsonl", body.replace(/\r?\n/g, " ") + "\n");
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  // Relative base so the built site works from any subpath (GitHub Pages
  // serves project sites at /<repo>/).
  base: "./",
  plugins: [react(), devLogSink()],
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
