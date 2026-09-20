// Distribution info for the CoopJobs extension (plan §3b): one MV3 build
// serves both Chrome and Edge, but each is installed a different way, and
// unpacked (non-store) installs never auto-update -- so ScraperDialog.jsx's
// install/update panels need both a target URL per browser and a way to
// tell which browser the page is running in.

// TODO: replace with the real Microsoft Edge Add-ons listing URL once the
// extension is published there (plan §3b, "publish to the Edge Add-ons
// store"). Until then this is a placeholder and the Edge panel's store
// button will 404.
export const EDGE_STORE_URL = "https://microsoftedge.microsoft.com/addons/detail/PLACEHOLDER";

// Relative to the web app's own origin, so it works the same on any static
// host. Produced by `npm run package:extension` (web/package.json), which
// zips extension/dist into exactly this file under web/public/.
export const EXTENSION_ZIP_URL = "coopjobs-extension.zip";

// The oldest extension build this site works with. Raise it (to the new
// extension/manifest.json "version") whenever a release changes how the two
// talk to each other, or fixes something scraping depends on: an older
// installed extension is then reported as outdated and the Scraper dialog
// shows the update panel instead of letting a scrape start.
export const MIN_EXTENSION_VERSION = "0.1.0";

/** -1 / 0 / 1, comparing dotted numeric versions ("0.2.0" > "0.1.9"). */
export function compareVersions(a, b) {
  const partsA = String(a || "0").split(".").map(Number);
  const partsB = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const x = partsA[i] || 0;
    const y = partsB[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Chrome vs. Edge vs. anything else, purely to steer the install
 * instructions in ScraperDialog.jsx -- browsing an imported database works
 * in any browser; only the extension (and so scraping) needs Chromium.
 * Edge is checked first because its UA also contains "Chrome/" and its
 * userAgentData brands also list a Chromium entry.
 */
export function detectBrowser() {
  if (typeof navigator === "undefined") return "other";
  const brands = navigator.userAgentData?.brands || [];
  const ua = navigator.userAgent || "";
  // Phones and tablets can't install extensions, whatever the brand says.
  const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua);
  if (mobile) return "other";
  const hasBrand = (re) => brands.some((b) => re.test(b.brand));
  if (hasBrand(/Microsoft Edge/i) || ua.includes("Edg/")) return "edge";
  if (hasBrand(/Chromium|Google Chrome/i) || ua.includes("Chrome/")) return "chrome";
  return "other";
}
