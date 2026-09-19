#!/usr/bin/env node
// Builds the extension (npm run build in extension/) and zips its dist/
// folder into web/public/coopjobs-extension.zip -- the file ScraperDialog's
// install panel (web/src/extensionInfo.js's EXTENSION_ZIP_URL) links to for
// Chrome's "Download extension (.zip)" step and Edge's manual-install
// fallback. Run via `npm run package:extension` (web/package.json).

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";

const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(here, "..");
const extensionRoot = resolve(webRoot, "..", "extension");
const distDir = resolve(extensionRoot, "dist");
const outDir = resolve(webRoot, "public");
const outFile = resolve(outDir, "coopjobs-extension.zip");

function run(command, args, cwd) {
  // Windows' "npm" is npm.cmd, which spawnSync can only launch through a
  // shell; args are fixed literals here (never user input), so the shell
  // quoting this triggers Node's EINVAL-avoidance warning about is safe.
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`[package:extension] "${command} ${args.join(" ")}" failed`);
    process.exit(result.status ?? 1);
  }
}

run("npm", ["run", "build"], extensionRoot);

if (!existsSync(distDir)) {
  console.error(`[package:extension] ${distDir} is missing after the extension build`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const output = createWriteStream(outFile);
const archive = new ZipArchive({ zlib: { level: 9 } });

output.on("close", () => {
  console.log(`[package:extension] wrote ${outFile} (${archive.pointer()} bytes)`);
});

archive.on("warning", (err) => {
  if (err.code !== "ENOENT") throw err;
});
archive.on("error", (err) => {
  throw err;
});

archive.pipe(output);
// Zipped at the archive root (not nested under "dist/"), so unzipping gives
// a folder that already has manifest.json at its own root -- exactly what
// "Load unpacked" expects (ScraperDialog.jsx's install steps).
archive.directory(distDir, false);
archive.finalize();
