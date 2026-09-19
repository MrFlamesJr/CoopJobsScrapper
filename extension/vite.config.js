import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Copies the top-level manifest.json into dist/ verbatim on every build, so
// extension/manifest.json stays the single source of truth for the manifest
// (rather than living under public/ or being hand-duplicated into dist/).
function copyManifestPlugin() {
  return {
    name: "copy-manifest",
    writeBundle() {
      copyFileSync(
        resolve(__dirname, "manifest.json"),
        resolve(__dirname, "dist/manifest.json")
      );
    },
  };
}

export default defineConfig({
  plugins: [copyManifestPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/index": resolve(__dirname, "src/background/index.js"),
        "content/portal": resolve(__dirname, "src/content/portal.js"),
        "content/bridge": resolve(__dirname, "src/content/bridge.js"),
      },
      output: {
        // "es" (not "iife"/"umd") because Rollup refuses IIFE/UMD output for a
        // multi-entry build. Each entry below is fully self-contained (no
        // shared chunks, no dynamic import()), so Rollup inlines everything
        // statically imported into that single output file and emits no
        // top-level `import`/`export` -- the result is plain script code,
        // safe to load as a classic (non-module) MV3 content script.
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
