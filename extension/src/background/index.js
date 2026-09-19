// Background service worker.
//
// Implemented in phase 4/5: routes scraped job data from the portal content
// script (src/content/portal.js) to the hosted app's bridge content script
// (src/content/bridge.js), and manages extension storage.

console.log("[CoopJobs] background service worker loaded");
