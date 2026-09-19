// Content script injected on the co-op portal origin.
//
// Implemented in phase 4/5: drives the job list/panel scraping (paging,
// clicking cards, reading panel outerHTML via src/scraper/panelParser.js) and
// sends results to the background service worker.

console.log("[CoopJobs] portal content script loaded");
