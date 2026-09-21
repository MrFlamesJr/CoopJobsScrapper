// Main-thread promise RPC wrapper around worker.js. Lazily starts the worker
// on first use, and multiplexes concurrent calls over the one message port.

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;

  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const { id, result, error } = event.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) {
      const err = new Error(error.message || "Database worker error");
      if (error.stack) err.stack = error.stack;
      if (error.name) err.name = error.name;
      entry.reject(err);
    } else {
      entry.resolve(result);
    }
  };
  worker.onerror = (event) => {
    // The worker itself crashed (e.g. a syntax error, an unhandled init
    // failure): nothing more will ever answer the calls in flight.
    const err = new Error(event?.message || "Database worker crashed");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };
  return worker;
}

// A dev hot-reload re-runs this module; stop the old worker so it releases
// the database file instead of blocking the new one.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    worker?.terminate();
    worker = null;
  });
}

function call(method, args = [], transfer = []) {
  const w = getWorker();
  const id = (seq += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, method, args }, transfer);
  });
}

let persistRequested = false;

/** Ask the browser not to evict this origin's storage (OPFS included) under
 * pressure. Best-effort: silently does nothing where unsupported or denied. */
export async function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // Best-effort only; the app works the same either way.
  }
}

export const dbClient = {
  insertJobs: (jobs) => call("insertJobs", [jobs]),
  countJobs: () => call("countJobs"),
  ratingCounts: () => call("ratingCounts"),
  lastScrapedAt: () => call("lastScrapedAt"),
  queryJobs: (options) => call("queryJobs", [options]),
  getJob: (jobId) => call("getJob", [jobId]),
  getFacets: () => call("getFacets"),
  clearJobs: () => call("clearJobs"),
  setLastRun: (run) => call("setLastRun", [run]),
  getLastRun: () => call("getLastRun"),
  listRatings: () => call("listRatings"),
  setRating: (jobNumber, rating) => call("setRating", [jobNumber, rating]),
  exportJobs: () => call("exportJobs"),
  exportDbFile: () => call("exportDbFile"),
  importDbFile: (bytes) => {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return call("importDbFile", [data], [data.buffer]);
  },
};
