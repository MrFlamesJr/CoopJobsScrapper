// Content script injected on the hosted app origin (localhost/127.0.0.1 for
// now -- see extension/README.md TODO for adding the real hosted origin).
//
// Implemented in phase 4/5: receives scraped job data from the background
// service worker and hands it off to the hosted web app running in this tab.

console.log("[CoopJobs] bridge content script loaded");
