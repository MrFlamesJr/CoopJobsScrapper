// Talks to the CoopJobs browser extension's bridge content script
// (extension/src/content/bridge.js) over window.postMessage, replacing the
// old /api/scraper/* + EventSource stream (app/server.py, runner.py) now
// that scraping happens in the extension instead of on a Python server.
//
// Protocol (mirrors extension/src/background/index.js's port protocol,
// carried across the page/content-script boundary by the bridge script):
//   app -> ext: {source:"coopjobs-app", type:"ping"}
//   ext -> app: {source:"coopjobs-ext", type:"pong", extensionVersion, protocolVersion}
//   app -> ext: {source:"coopjobs-app", type:"start"|"cancel"|"getStatus"}
//   app -> ext: {source:"coopjobs-app", type:"ack", seq, inserted, error}
//   ext -> app: {source:"coopjobs-app", type:"status", status}   (status.outbox carries unacked jobs)
//   ext -> app: {source:"coopjobs-ext", type:"ping"}              heartbeat, every ~15s
//   app -> ext: {source:"coopjobs-app", type:"getDebugSnapshots"}
//   ext -> app: {source:"coopjobs-ext", type:"debugSnapshots", snapshots}
//
// `createExtensionBridge` takes an injectable `win` (default: the real
// global `window`) and `db` (default: web/src/db/client.js's dbClient) so it
// can be unit tested with plain fakes instead of a real extension/DOM -- see
// extensionBridge.test.js.

import { dbClient } from "./db/client.js";

const PROTOCOL_VERSION = 1;
const PING_TIMEOUT_MS = 1000;
// Slightly more than the service worker's 15s heartbeat (background/index.js
// HEARTBEAT_MS), so one missed beat doesn't flip the UI to "reconnecting".
const HEARTBEAT_GRACE_MS = 20_000;

function defaultWindow() {
  return typeof window !== "undefined" ? window : null;
}

export function createExtensionBridge({ win = defaultWindow(), db = dbClient } = {}) {
  const statusListeners = new Set();
  const connectionListeners = new Set();
  // seq -> {inserted, error} already returned to the extension, so a
  // re-sent (unacknowledged-from-the-extension's-view) outbox entry is
  // answered again with the SAME result instead of being inserted twice.
  const ackedSeqs = new Map();
  const inFlightSeqs = new Set();

  let connection = "reconnecting";
  let heartbeatTimer = null;
  let listening = false;

  function post(message) {
    if (!win) return;
    win.postMessage({ source: "coopjobs-app", ...message }, win.location ? win.location.origin : "*");
  }

  function setConnection(next) {
    if (connection === next) return;
    connection = next;
    for (const listener of connectionListeners) listener(connection);
  }

  function armHeartbeatTimeout() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    setConnection("live");
    heartbeatTimer = setTimeout(() => setConnection("reconnecting"), HEARTBEAT_GRACE_MS);
  }

  async function insertAndAck(entry) {
    const { seq } = entry;
    if (ackedSeqs.has(seq)) {
      post({ type: "ack", seq, ...ackedSeqs.get(seq) });
      return;
    }
    if (inFlightSeqs.has(seq)) return;
    inFlightSeqs.add(seq);
    let result;
    try {
      const inserted = await db.insertJobs([entry.job]);
      result = { inserted, error: "" };
    } catch (exc) {
      // Only a real SQLite error means "this job can't be saved". If the
      // database couldn't even be opened (locked by another tab, worker
      // crashed), don't ack: the job stays in the extension's outbox for a
      // tab that can save it, instead of being dropped.
      if (!exc || exc.name !== "SQLite3Error") {
        inFlightSeqs.delete(seq);
        return;
      }
      result = { inserted: 0, error: exc.message || String(exc) };
    }
    inFlightSeqs.delete(seq);
    ackedSeqs.set(seq, result);
    post({ type: "ack", seq, ...result });
  }

  function handleStatusMessage(status) {
    armHeartbeatTimeout();
    const { outbox = [], ...rest } = status || {};
    for (const entry of outbox) {
      // Fire-and-forget: each entry acks itself independently and out of
      // order is fine, the extension matches acks back to entries by seq.
      insertAndAck(entry);
    }
    for (const listener of statusListeners) listener(rest);
  }

  function onMessage(event) {
    if (event.source !== win) return;
    if (win.location && event.origin !== win.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== "coopjobs-ext") return;
    if (data.type === "status") {
      handleStatusMessage(data.status);
    } else if (data.type === "ping") {
      armHeartbeatTimeout();
    }
  }

  function ensureListening() {
    if (listening || !win) return;
    listening = true;
    win.addEventListener("message", onMessage);
  }

  /** Pings the extension and resolves once, or after ~1s of silence.
   * `installed:false` covers both "not installed" and "unreachable". */
  function detect() {
    return new Promise((resolve) => {
      if (!win) {
        resolve({ installed: false, outdated: false, extensionVersion: null });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        win.removeEventListener("message", onPong);
        clearTimeout(timer);
        resolve(result);
      };
      function onPong(event) {
        if (event.source !== win) return;
        if (win.location && event.origin !== win.location.origin) return;
        const data = event.data;
        if (!data || data.source !== "coopjobs-ext" || data.type !== "pong") return;
        finish({
          installed: true,
          outdated: (data.protocolVersion ?? 0) < PROTOCOL_VERSION,
          extensionVersion: data.extensionVersion ?? null,
        });
      }
      const timer = setTimeout(() => finish({ installed: false, outdated: false, extensionVersion: null }), PING_TIMEOUT_MS);
      win.addEventListener("message", onPong);
      post({ type: "ping" });
    });
  }

  function subscribe(callback) {
    ensureListening();
    statusListeners.add(callback);
    return () => statusListeners.delete(callback);
  }

  function onConnectionChange(callback) {
    ensureListening();
    connectionListeners.add(callback);
    return () => connectionListeners.delete(callback);
  }

  function start() {
    ensureListening();
    post({ type: "start" });
  }

  function cancel() {
    ensureListening();
    post({ type: "cancel" });
  }

  function requestStatus() {
    ensureListening();
    post({ type: "getStatus" });
  }

  /** Asks the extension for its recorded debug snapshots (evidence captured
   * for failed cards / anomalies, background/index.js's DEBUG_SNAPSHOTS_KEY)
   * and resolves with the array, or [] after ~2s of silence -- same
   * one-shot-listener shape as detect(). */
  function getDebugSnapshots() {
    return new Promise((resolve) => {
      if (!win) {
        resolve([]);
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        win.removeEventListener("message", onReply);
        clearTimeout(timer);
        resolve(result);
      };
      function onReply(event) {
        if (event.source !== win) return;
        if (win.location && event.origin !== win.location.origin) return;
        const data = event.data;
        if (!data || data.source !== "coopjobs-ext" || data.type !== "debugSnapshots") return;
        finish(data.snapshots || []);
      }
      const timer = setTimeout(() => finish([]), 2000);
      win.addEventListener("message", onReply);
      ensureListening();
      post({ type: "getDebugSnapshots" });
    });
  }

  return {
    detect,
    subscribe,
    onConnectionChange,
    getConnectionState: () => connection,
    start,
    cancel,
    requestStatus,
    getDebugSnapshots,
    // exposed for tests only: lets a test push a status message without a
    // real window round trip.
    _handleMessageForTests: onMessage,
  };
}

let defaultBridge = null;

/** The bridge every real caller (useScraper.js) uses; lazily created (rather
 * than a plain module-level singleton) purely so tests that only need
 * createExtensionBridge don't also pay for constructing this one. */
export function getExtensionBridge() {
  if (!defaultBridge) defaultBridge = createExtensionBridge();
  return defaultBridge;
}
