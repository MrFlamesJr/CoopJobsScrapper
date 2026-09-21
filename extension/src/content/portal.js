// Content script injected on the co-op portal origin. Runs JobPortalScraper
// (src/scraper/portal.js) against the live DOM and reports every callback
// back to the service worker (src/background/index.js) over a long-lived
// "coopjobs-portal" port -- see the protocol comment at the top of
// background/index.js for the full message list.
//
// This script connects on load unconditionally, but only ever *scrapes* when
// the service worker answers with {type:"start"} -- which it only sends to
// the port belonging to the tab it itself opened (background/index.js's
// setUpPortalPort). A portal tab the user opened by hand just sits idle.

import { JobPortalScraper } from "../scraper/portal.js";

let port = null;
let cancelled = false;
let sleepSeq = 0;
const pendingSleeps = new Map();

function connect() {
  try {
    port = chrome.runtime.connect({ name: "coopjobs-portal" });
  } catch (exc) {
    console.warn("[CoopJobs] could not connect to the extension:", exc);
    return;
  }
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // Any sleeps still waiting on a reply would hang forever otherwise --
    // fall back to a local timer so a run in flight can still finish.
    for (const [id, resolve] of pendingSleeps) {
      pendingSleeps.delete(id);
      resolve();
    }
  });
  post({ type: "ready" });
}

function handleMessage(message) {
  switch (message.type) {
    case "start":
      cancelled = false;
      runScrape();
      break;
    case "cancel":
      cancelled = true;
      break;
    case "sleepReply":
      resolveSleep(message.id);
      break;
    default:
      break;
  }
}

function post(message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch (exc) {
    console.warn("[CoopJobs] could not reach the extension:", exc);
  }
}

/** clock.sleep() routed through the service worker's setTimeout, which is
 * not subject to the 1/s-then-1/min throttling Chrome applies to timers in a
 * hidden/minimised tab (message round-trips are exempt) -- see the module
 * docstring in background/index.js. Falls back to a local timer if the port
 * is unreachable, so a run doesn't simply hang. */
function sleep(ms) {
  return new Promise((resolve) => {
    if (!port) {
      setTimeout(resolve, ms);
      return;
    }
    const id = sleepSeq;
    sleepSeq += 1;
    pendingSleeps.set(id, resolve);
    try {
      port.postMessage({ type: "sleep", id, ms });
    } catch (exc) {
      pendingSleeps.delete(id);
      console.warn("[CoopJobs] sleep request failed, falling back to a local timer:", exc);
      setTimeout(resolve, ms);
    }
  });
}

function resolveSleep(id) {
  const resolve = pendingSleeps.get(id);
  if (!resolve) return;
  pendingSleeps.delete(id);
  resolve();
}

async function runScrape() {
  const scraper = new JobPortalScraper({
    dom: document,
    searchUrl: window.location.href,
    clock: { now: () => Date.now(), sleep },
    isCancelled: () => cancelled,
    onEvent: (event) => post({ type: "event", event, accounting: currentAccounting(scraper) }),
    readyCallback: () => post({ type: "loginDetected" }),
    pageCallback: (page, jobs) =>
      post({ type: "page", page, jobsCount: jobs.length, accounting: currentAccounting(scraper) }),
    snapshotSink: (category, name, { json, html }) =>
      post({ type: "snapshot", category, name, payload: { json, html } }),
    snapshotAll: false,
  });

  try {
    await scraper.run();
    post({ type: "finished", cardsSeen: scraper.cardsSeen, duplicates: scraper.duplicates, failedJobs: scraper.failed, duplicateJobs: scraper.duplicateJobs });
  } catch (exc) {
    post({ type: "error", name: (exc && exc.name) || "Error", message: (exc && exc.message) || String(exc) });
  }
}

/** Mirrors runner.py's sync_accounting(): a snapshot of the scraper's own
 * running counters, taken in the same tick as the event that is being
 * reported (see background/index.js's runner.handleEvent). */
function currentAccounting(scraper) {
  return {
    cardsSeen: scraper.cardsSeen,
    duplicates: scraper.duplicates,
    failed: scraper.failed.length,
    failedJobs: scraper.failed,
    duplicateJobs: scraper.duplicateJobs,
  };
}

connect();
