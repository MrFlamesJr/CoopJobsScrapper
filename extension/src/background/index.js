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
//   -> {type: "openExtensionsPage"}                         open chrome://extensions in a new tab
//   -> {type: "getDebugSnapshots"}                           ask for the recorded debug evidence
//   -> {type: "reset"}                                       wipe a finished run's report after "delete all jobs"
//   <- {type: "status", status}                               status snapshot incl. outbox, pushed on every change
//     and once immediately on connect (status.outbox carries every
//     still-unacknowledged job, so a reconnecting tab drains exactly what it
//     missed -- no separate "job" message type is needed).
//   <- {type: "ping"}                                        heartbeat, every 15s
//   <- {type: "debugSnapshots", snapshots}                   reply to getDebugSnapshots, from chrome.storage.local
//   <- {type: "resetDone"}                                    reply to "reset", so a fire-and-forget post can confirm

import { ScrapeRunner } from "./runner.js";

const SEARCH_URL = "https://experiential-learning.uottawa.ca/search";
// Size mirrors the legacy WINDOW_SIZE = "1280,900" in app/scraper/browser.py.
// A popup has no tab strip/bookmarks bar and a read-only origin label instead
// of an editable omnibox, which is most of what containment (see below) is
// for -- but it stays movable/resizable/maximizable, so it doesn't need a
// manifest change or any special-casing elsewhere.
const PORTAL_WINDOW = { type: "popup", width: 1280, height: 900 };
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
let portalWindowId = null;
let portalPort = null;
const bridgePorts = new Set();
let sleepRequestId = 0;
const pendingSleeps = new Map();

// If the service worker restarted mid-run, clean up any leftover window.
(async () => {
  try {
    const saved = await chrome.storage.session?.get("portalWindowId");
    const windowId = saved?.portalWindowId;
    if (windowId !== null && windowId !== undefined) {
      try {
        await chrome.windows.remove(windowId);
      } catch {
        // Already closed or other error; nothing to do.
      }
      await chrome.storage.session?.remove("portalWindowId");
    }
  } catch {
    // Session storage unavailable; nothing to do.
  }
})();

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

// Safety net: close the portal window whenever the runner reaches a terminal
// state (completed, failed, cancelled), ensuring no path can leave it open.
runner.subscribe((status) => {
  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  if (terminalStates.has(status.state)) {
    closePortalWindow();
  }
});

// -- Portal tab lifecycle ---------------------------------------------------

// Resolves once the scrape tab's id is known, so a content script that
// connects before chrome.windows.create returns is not rejected or mistaken.
let portalTabReady = Promise.resolve();

async function openPortalWindow() {
  portalTabReady = (async () => {
    const win = await chrome.windows.create({ url: SEARCH_URL, focused: true, ...PORTAL_WINDOW });
    const tab = win.tabs && win.tabs[0];
    portalTabId = tab ? tab.id : null;
    portalWindowId = win.id ?? null;
    // The worker can be suspended mid-run; keep both ids where they survive
    // that (same shape as the existing portalTabId persistence below).
    await chrome.storage.session?.set({ portalTabId, portalWindowId });
  })();
  await portalTabReady;
  runner.markWaitingForLogin();
}

async function closePortalWindow() {
  // Safe to call multiple times, ignores "already closed" errors. The ids are
  // dropped before the first await, so a second call that lands while this one
  // is still running finds nothing left to close.
  const known = portalWindowId;
  portalTabId = null;
  portalWindowId = null;
  portalPort = null;
  const windowId = known ?? (await knownPortalWindowId());
  if (windowId === null || windowId === undefined) return;
  portalWindowId = null;
  try {
    await chrome.windows.remove(windowId);
  } catch {
    // Already closed, tab is gone, or other error; nothing to do.
  }
  try {
    await chrome.storage.session?.remove("portalTabId");
    await chrome.storage.session?.remove("portalWindowId");
  } catch {
    // Session storage unavailable; nothing to do.
  }
}

async function knownPortalTabId() {
  await portalTabReady;
  if (portalTabId === null) {
    const saved = await chrome.storage.session?.get("portalTabId");
    portalTabId = saved?.portalTabId ?? null;
  }
  return portalTabId;
}

async function knownPortalWindowId() {
  await portalTabReady;
  if (portalWindowId === null) {
    const saved = await chrome.storage.session?.get("portalWindowId");
    portalWindowId = saved?.portalWindowId ?? null;
  }
  return portalWindowId;
}

function handlePortalTabGone() {
  if (portalTabId === null) return;
  // Close first, then tell the runner. The port can die while the window is
  // still open (a crashed or navigated page), and closePortalWindow is what
  // clears the ids -- clearing them here first would leave nothing for it,
  // or for the terminal-state safety net, to close.
  closePortalWindow();
  runner.handleTabClosed();
}

chrome.tabs?.onRemoved.addListener((tabId) => {
  if (tabId === portalTabId) handlePortalTabGone();
});

// Once scraping (never during waiting_for_login -- see the "cancel" reply
// handler in setUpPortalPort for why a disconnect is normal there too), the
// portal tab must stay on the portal's own origin. Letting a stray link or
// redirect carry it elsewhere would strand the in-page scraper with no way
// back, so any cross-origin navigation is bounced straight to SEARCH_URL.
chrome.tabs?.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== portalTabId || !changeInfo.url) return;
  if (runner.status().state !== "scraping") return;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(changeInfo.url).origin === new URL(SEARCH_URL).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) chrome.tabs.update(tabId, { url: SEARCH_URL });
});

// The scraper only ever reads job panels in-page -- it never opens a tab
// itself -- so any tab spawned from the portal tab (a target="_blank" link,
// window.open, etc.) is an escape hatch out of the contained window rather
// than something the scrape needs, and can be closed on sight.
chrome.tabs?.onCreated.addListener((tab) => {
  if (tab.openerTabId === portalTabId) {
    chrome.tabs.remove(tab.id).catch(() => {
      // Already gone; nothing to do.
    });
  }
});

// -- Bridge injection into already-open tabs ---------------------------------

// A tab that was already open when the extension is installed/updated/
// started never gets the declared content_scripts entry (that only runs on
// a tab's own future navigations), so web/src/extensionBridge.js's ping
// would go unanswered until the user reloads the page. Inject the built
// bridge file into every matching tab ourselves, on both onInstalled (covers
// install/update/reload from chrome://extensions) and onStartup (covers the
// browser itself starting with the tab already restored).
async function injectBridgeIntoExistingTabs() {
  if (!chrome.scripting?.executeScript) return;
  // Read the match patterns from the bridge's own content_scripts entry
  // (rather than hardcoding them here) so this can never drift from
  // manifest.json, and so it only ever touches the bridge's own tabs -- never
  // the portal tab or anything else.
  const manifest = chrome.runtime.getManifest();
  const bridgeEntry = (manifest.content_scripts || []).find((entry) =>
    (entry.js || []).includes("content/bridge.js")
  );
  const matches = bridgeEntry?.matches;
  if (!matches || matches.length === 0) return;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: matches });
  } catch (exc) {
    console.warn("[CoopJobs] could not query tabs to inject the bridge into:", exc);
    return;
  }

  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/bridge.js"] });
    } catch (exc) {
      // A discarded tab, or a URL the extension isn't allowed to script
      // (e.g. chrome://) can each fail here; never let one tab stop the rest.
      console.warn("[CoopJobs] could not inject the bridge into tab", tab.id, exc);
    }
  }
}

chrome.runtime?.onInstalled.addListener(() => {
  injectBridgeIntoExistingTabs();
});
chrome.runtime?.onStartup.addListener(() => {
  injectBridgeIntoExistingTabs();
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
      closePortalWindow();
      break;
    case "error":
      runner.handleError(message);
      closePortalWindow();
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

async function readDebugSnapshots() {
  if (!chrome.storage?.local) return [];
  try {
    const { [DEBUG_SNAPSHOTS_KEY]: existing = [] } = await chrome.storage.local.get(DEBUG_SNAPSHOTS_KEY);
    return existing;
  } catch (exc) {
    console.warn("[CoopJobs] could not read debug snapshots:", exc);
    return [];
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
      // Post the cancel to the portal FIRST, close the window SECOND. Doing
      // it the other way round makes chrome.tabs.onRemoved fire before the
      // runner has been told this is a cancel, so handleTabClosed would
      // report "browser window was closed" instead of the cancel the user
      // actually asked for.
      await closePortalWindow();
      break;
    case "getStatus":
      port.postMessage({ type: "status", status: runner.status() });
      break;
    case "reset":
      runner.reset();
      // Clear the debug bundle too, so it never carries evidence for a
      // scrape whose jobs were just wiped out of the database.
      try {
        await chrome.storage.local?.remove(DEBUG_SNAPSHOTS_KEY);
      } catch (exc) {
        console.warn("[CoopJobs] could not clear debug snapshots on reset:", exc);
      }
      port.postMessage({ type: "status", status: runner.status() });
      // The web app posts "reset" fire-and-forget; reply so it can confirm
      // the reset actually happened rather than just hoping the fire landed.
      port.postMessage({ type: "resetDone" });
      break;
    case "ack":
      runner.ack(message.seq, { inserted: message.inserted, error: message.error });
      break;
    case "openExtensionsPage": {
      // A web page can't navigate to chrome://extensions; the extension can.
      // The page says which one (Edge has its own), but only these two.
      const allowed = ["chrome://extensions", "edge://extensions"];
      const url = allowed.includes(message.url) ? message.url : allowed[0];
      chrome.tabs?.create({ url });
      break;
    }
    case "getDebugSnapshots": {
      const snapshots = await readDebugSnapshots();
      try {
        port.postMessage({ type: "debugSnapshots", snapshots });
      } catch {
        // The bridge tab is already gone; onDisconnect will clean it up.
      }
      break;
    }
    default:
      break;
  }
}

export { runner };
