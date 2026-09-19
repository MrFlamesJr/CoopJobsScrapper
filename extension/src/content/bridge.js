// Content script injected on the hosted web app's origin. Relays between
// window.postMessage (the web app, source "coopjobs-app") and a long-lived
// chrome.runtime port to the service worker (source "coopjobs-ext" going
// back), named "coopjobs-bridge" -- see background/index.js's protocol
// comment for the full message list this carries (start/cancel/getStatus/ack
// upstream, status/ping downstream).
//
// {type:"ping"} is special-cased: it is answered immediately, from this
// script alone, without waiting on the service worker at all -- that is what
// lets web/src/extensionBridge.js's install-detection be near-instant and
// still work even if the service worker is asleep (connecting to it will
// wake it, but the ping itself doesn't need to).

const PROTOCOL_VERSION = 1;

let port = null;

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "unknown";
  }
}

function postToApp(message) {
  window.postMessage({ source: "coopjobs-ext", ...message }, window.location.origin);
}

function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: "coopjobs-bridge" });
  } catch (exc) {
    console.warn("[CoopJobs] could not connect to the extension:", exc);
    return null;
  }
  port.onMessage.addListener((message) => postToApp(message));
  port.onDisconnect.addListener(() => {
    port = null;
  });
  return port;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return; // only the page itself, never an iframe/other tab
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.source !== "coopjobs-app") return;

  if (data.type === "ping") {
    postToApp({ type: "pong", extensionVersion: extensionVersion(), protocolVersion: PROTOCOL_VERSION });
    return;
  }

  const p = ensurePort();
  if (!p) return;
  try {
    p.postMessage(data);
  } catch (exc) {
    console.warn("[CoopJobs] could not relay a message to the extension:", exc);
  }
});

// Connect eagerly so the service worker can push status the moment it has
// something to say, without waiting for the app to send anything first.
ensurePort();
