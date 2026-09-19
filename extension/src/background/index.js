// Background service worker: wires the chrome.*-independent ScrapeRunner
// (./runner.js) to chrome.windows/tabs/storage/runtime.Port. This is the
// equivalent of app/scraper/browser.py (window lifecycle) plus the parts of
// runner.py that touched threading directly -- everything else already
// lives in runner.js.
//
// Protocol (all messages are plain objects posted over chrome.runtime
// long-lived ports -- see chrome.runtime.connect/onConnect):
//
// Portal content script (src/content/portal.js) <-> this worker, port name
// "coopjobs-portal":
//   -> {type: "ready"}                                   content script connected, tab is the scrape tab
//   -> {type: "loginDetected"}                            JobPortalScraper's readyCallback fired
//   -> {type: "event", event, accounting}                 JobPortalScraper's onEvent fired
//   -> {type: "page", page, jobsCount, accounting}         JobPortalScraper's pageCallback fired
//   -> {type: "finished", cardsSeen, duplicates, failedJobs}   scraper.run() resolved
//   -> {type: "error", name, message}                      scraper.run() rejected
//   -> {type: "sleep", id, ms}                              clock.sleep() request (throttle-proof timer)
//   -> {type: "snapshot", category, name, payload}          debug snapshot
//   <- {type: "start"}                                      begin scraping this tab
//   <- {type: "cancel"}                                     cooperative cancel flag
//   <- {type: "sleepReply", id}                              reply to a "sleep" request
//
// Bridge content script (src/content/bridge.js, on the hosted web app),
// port name "coopjobs-bridge":
//   -> {type: "start"}                                      user clicked "Start scrape"
//   -> {type: "cancel"}                                     user clicked "Cancel"
//   -> {type: "getStatus"}                                   ask for a fresh snapshot
//   -> {type: "ack", seq, inserted, error}                   one outbox job was (or wasn't) saved
//   <- {type: "status", status}                               status snapshot incl. outbox, pushed on every change
//     and once immediately on connect (status.outbox carries every
//     still-unacknowledged job, so a reconnecting tab drains exactly what it
//     missed -- no separate "job" message type is needed).
//   <- {type: "ping"}                                        heartbeat, every 15s

import { ScrapeRunner } from "./runner.js";

const SEARCH_URL = "https://experiential-learning.uottawa.ca/search";
const HEARTBEAT_MS = 15_000;
const DEBUG_SNAPSHOTS_KEY = "debugSnapshots";
const DEBUG_SNAPSHOTS_MAX = 50;

const transport = {
  sendJob() {
    // Replaced below once portPushStatus exists -- kept as a no-op default
    // so a `scraped` event arriving before any bridge has ever connected
    // does not throw. The real delivery mechanism is status.outbox, pushed
    // to every bridge port on every change (see pushStatus()); this hook
    // only exists for parity with runner.js's constructor contract.
  },
};

const runner = new ScrapeRunner({ storage: chrome.storage?.local, transport });

let portalTabId = null;
let portalPort = null;
const bridgePorts = new Set();
let sleepRequestId = 0;
const pendingSleeps = new Map();

function pushStatus() {
  const status = runner.status();
  for (const port of bridgePorts) {
    try {
      port.postMessage({ type: "status", status });
    } catch {
      // The tab is gone; onDisconnect will clean it up shortly.
    }
  }
}

runner.subscribe(() => pushStatus());

// -- Portal tab lifecycle ---------------------------------------------------

// Resolves once the scrape tab's id is known, so a content script that
// connects before chrome.windows.create returns is not rejected or mistaken.
let portalTabReady = Promise.resolve();

async function openPortalWindow() {
  portalTabReady = (async () => {
    const win = await chrome.windows.create({ url: SEARCH_URL, focused: true });
    const tab = win.tabs && win.tabs[0];
    portalTabId = tab ? tab.id : null;
    // The worker can be suspended mid-run; keep the id where it survives that.
    await chrome.storage.session?.set({ portalTabId });
  })();
  await portalTabReady;
  runner.markWaitingForLogin();
}

async function knownPortalTabId() {
  await portalTabReady;
  if (portalTabId === null) {
    const saved = await chrome.storage.session?.get("portalTabId");
    portalTabId = saved?.portalTabId ?? null;
  }
  return portalTabId;
}

function handlePortalTabGone() {
  if (portalTabId === null) return;
  portalTabId = null;
  portalPort = null;
  chrome.storage.session?.remove("portalTabId");
  runner.handleTabClosed();
}

chrome.tabs?.onRemoved.addListener((tabId) => {
  if (tabId === portalTabId) handlePortalTabGone();
});

// -- chrome.runtime.connect: two kinds of long-lived ports -------------------

chrome.runtime?.onConnect.addListener((port) => {
  if (port.name === "coopjobs-portal") {
    setUpPortalPort(port);
  } else if (port.name === "coopjobs-bridge") {
    setUpBridgePort(port);
  }
});

async function setUpPortalPort(port) {
  const tabId = port.sender?.tab?.id;
  // Only the tab the service worker itself opened, during a run, is the
  // scrape tab; a portal tab the user opened by hand must never scrape.
  const scrapeTabId = await knownPortalTabId();
  if (!runner.isRunning || scrapeTabId === null || tabId !== scrapeTabId) return;

  portalPort = port;
  port.onMessage.addListener((message) => handlePortalMessage(message, port));
  port.onDisconnect.addListener(() => {
    if (port !== portalPort) return;
    portalPort = null;
    // Logging in navigates the tab through the SSO pages and back, which
    // disconnects the content script; that is not a closed window. Once
    // scraping, a navigation loses the scraper's in-page state, so it ends
    // the run like a closed window (tabs.onRemoved covers a real close).
    if (runner.status().state === "scraping") handlePortalTabGone();
  });
  // The scraper waits for the login/page-ready condition itself; the worker
  // only has to tell it to start once the tab has actually connected.
  const state = runner.status().state;
  if (state === "starting" || state === "waiting_for_login") port.postMessage({ type: "start" });
}

function handlePortalMessage(message, port) {
  switch (message.type) {
    case "ready":
      break; // handshake only; "start" was already sent on connect
    case "loginDetected":
      runner.handleReady();
      break;
    case "event":
      runner.handleEvent(message.event, message.accounting);
      break;
    case "page":
      runner.handlePage(message.page, message.jobsCount, message.accounting);
      break;
    case "finished":
      runner.handleFinished(message);
      break;
    case "error":
      runner.handleError(message);
      break;
    case "sleep":
      handleSleepRequest(message, port);
      break;
    case "snapshot":
      recordDebugSnapshot(message);
      break;
    default:
      break;
  }
}

// MV3 throttles setTimeout in hidden/minimised tabs; the service worker's own
// timers are not subject to that throttling in the same way message
// round-trips are exempt, so every scraper wait is routed through here
// instead of a bare setTimeout in the content script (see portal.js).
function handleSleepRequest(message, port) {
  const { id, ms } = message;
  const timer = setTimeout(() => {
    pendingSleeps.delete(id);
    try {
      port.postMessage({ type: "sleepReply", id });
    } catch {
      // Port already gone; nothing to wake up.
    }
  }, ms);
  pendingSleeps.set(id, timer);
}

async function recordDebugSnapshot(message) {
  if (!chrome.storage?.local) return;
  try {
    const { [DEBUG_SNAPSHOTS_KEY]: existing = [] } = await chrome.storage.local.get(DEBUG_SNAPSHOTS_KEY);
    const next = [...existing, { time: new Date().toISOString(), ...message }].slice(-DEBUG_SNAPSHOTS_MAX);
    await chrome.storage.local.set({ [DEBUG_SNAPSHOTS_KEY]: next });
  } catch (exc) {
    console.warn("[CoopJobs] could not record a debug snapshot:", exc);
  }
}

function setUpBridgePort(port) {
  bridgePorts.add(port);
  port.postMessage({ type: "status", status: runner.status() });
  runner.resendOutbox();

  const heartbeat = setInterval(() => {
    try {
      port.postMessage({ type: "ping" });
    } catch {
      // onDisconnect will fire and clear the interval.
    }
  }, HEARTBEAT_MS);

  port.onMessage.addListener((message) => handleBridgeMessage(message, port));
  port.onDisconnect.addListener(() => {
    clearInterval(heartbeat);
    bridgePorts.delete(port);
  });
}

async function handleBridgeMessage(message, port) {
  switch (message.type) {
    case "start":
      try {
        runner.start();
        await openPortalWindow();
      } catch (exc) {
        // AlreadyRunning / OutboxNotEmpty (or a chrome.windows.create
        // failure): report it as a failed status rather than throwing
        // across the port.
        runner.handleError({ name: exc.name || "Error", message: exc.message || String(exc) });
      }
      break;
    case "cancel":
      runner.cancel();
      if (portalPort) {
        try {
          portalPort.postMessage({ type: "cancel" });
        } catch {
          // The portal tab is already gone; handlePortalTabGone will follow.
        }
      }
      break;
    case "getStatus":
      port.postMessage({ type: "status", status: runner.status() });
      break;
    case "ack":
      runner.ack(message.seq, { inserted: message.inserted, error: message.error });
      break;
    default:
      break;
  }
}

export { runner };
