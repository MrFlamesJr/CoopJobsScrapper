// Every function here keeps its original name and return shape (see the
// server routes this used to hit, app/server.py), but the jobs/facets/
// favorites data now comes straight from the in-browser SQLite database
// (web/src/db) instead of the Flask API.

import { dbClient, requestPersistentStorage } from "./db/client.js";
import { getExtensionBridge } from "./extensionBridge.js";

// OPFS can otherwise be evicted under storage pressure like any other origin
// storage; this is best-effort and never blocks anything on its result.
requestPersistentStorage();

function notFoundError(message) {
  const err = new Error(message);
  err.code = "not_found";
  err.status = 404;
  return err;
}

/** Resolves/rejects `promise`, but rejects early (with the same `AbortError`
 * shape `fetch` uses) if `signal` fires first. Callers that check
 * `err.name === "AbortError"` (see useJobs.js, useFacets.js) keep working
 * unchanged even though nothing here is actually cancellable mid-flight. */
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function fetchJobs(params, signal) {
  const { q, sort, deadline, ...rest } = params || {};
  const filters = {};
  for (const [field, values] of Object.entries(rest)) {
    if (Array.isArray(values) && values.length > 0) filters[field] = values;
  }

  const promise = dbClient
    .queryJobs({ q: q || "", filters, deadline: deadline || null, sort: sort || "deadline" })
    .then(async (jobs) => {
      const total = await dbClient.countJobs();
      return { jobs, total };
    });
  return withAbort(promise, signal);
}

export function fetchJob(id) {
  return dbClient.getJob(Number(id)).then((job) => {
    if (job === null) throw notFoundError("No job with that id.");
    return job;
  });
}

export function fetchFacets(signal) {
  return withAbort(dbClient.getFacets(), signal);
}

export async function deleteAllJobs() {
  const deleted = await dbClient.countJobs();
  await dbClient.clearJobs();
  return { deleted };
}

// Every favorites endpoint answers with the full, fresh list, so callers can
// just replace their state with `.favorites` from any response.
export function fetchFavorites(signal) {
  return withAbort(dbClient.listFavorites().then((favorites) => ({ favorites })), signal);
}

export async function addFavorite(jobNumber) {
  const ok = await dbClient.addFavorite(jobNumber);
  if (!ok) throw notFoundError("No job with that number.");
  const favorites = await dbClient.listFavorites();
  return { favorites };
}

export async function removeFavorite(jobNumber) {
  await dbClient.removeFavorite(jobNumber);
  const favorites = await dbClient.listFavorites();
  return { favorites };
}

// --- Scraper -------------------------------------------------------------
// Scraping now happens in the CoopJobs browser extension (extension/src),
// not a Flask server: startScraper/cancelScraper talk to it through
// extensionBridge.js, and subscribeScraperStatus replaces the old
// /api/scraper/stream EventSource. The runner's status object (state,
// message, pages_completed, jobs_saved, ..., version) is unchanged; only
// job_count / last_scraped_at / last_run are still added here, from the
// local database, exactly like server.py's status_payload did.

// Mirrors runner.js's RUNNING_STATES (and runner.py's _RUNNING_STATES before
// it): "cancelling" still counts as running.
const RUNNING_STATES = new Set(["starting", "waiting_for_login", "scraping", "cancelling"]);

function databaseNotEmptyError() {
  const err = new Error("Clear the existing jobs before scraping again.");
  err.code = "database_not_empty";
  err.status = 409;
  return err;
}

function lastRunRecordFromStatus(status) {
  return {
    state: status.state,
    started_at: status.started_at ?? null,
    finished_at: status.finished_at ?? null,
    pages_completed: status.pages_completed ?? 0,
    total_pages: status.total_pages ?? null,
    jobs_saved: status.jobs_saved ?? 0,
  };
}

/** Adds job_count/last_scraped_at/last_run to a runner status snapshot, the
 * same database facts server.py's status_payload added next to
 * runner.status(). A last_run row still marked "running" while nothing is
 * actually running (the extension/browser was closed mid-scrape) is
 * reported as "interrupted", same as before -- the stored row is untouched. */
export async function enrichScraperStatus(status) {
  const [jobCount, lastScrapedAt, storedLastRun] = await Promise.all([
    dbClient.countJobs(),
    dbClient.lastScrapedAt(),
    dbClient.getLastRun(),
  ]);
  let lastRun = storedLastRun;
  if (lastRun && lastRun.state === "running" && !RUNNING_STATES.has(status.state)) {
    lastRun = { ...lastRun, state: "interrupted" };
  }
  return { ...status, job_count: jobCount, last_scraped_at: lastScrapedAt, last_run: lastRun };
}

/** Subscribes to the extension's status stream (replaces the old
 * /api/scraper/stream EventSource). `callback` receives each snapshot
 * already enriched with the database facts above. Also records `last_run`
 * the moment a run reaches a terminal state -- idempotently, the same
 * guarantee runner.py's _save_last_run gave via its `finally` block -- since
 * the extension itself has no access to this database to do it. Returns an
 * unsubscribe function. */
export function subscribeScraperStatus(callback) {
  return getExtensionBridge().subscribe(async (status) => {
    if (status.state !== "idle" && !RUNNING_STATES.has(status.state)) {
      try {
        await dbClient.setLastRun(lastRunRecordFromStatus(status));
      } catch {
        // Best-effort, same as runner.py's _save_last_run: must never break the UI.
      }
    }
    let enriched;
    try {
      enriched = await enrichScraperStatus(status);
    } catch {
      return; // a transient DB read failure; the next snapshot retries
    }
    callback(enriched);
  });
}

/** One-off refresh for state changes the extension never announces (e.g.
 * "Clear all jobs" changes job_count without any scraper event) -- re-reads
 * the database facts around whatever runner state the caller already has. */
export function refreshScraperStatus(currentStatus) {
  return enrichScraperStatus(currentStatus || { state: "idle" });
}

/** Checks whether the extension is installed/reachable and speaks a
 * protocol we understand -- see extensionBridge.js's detect(). */
export function checkExtension() {
  return getExtensionBridge().detect();
}

export async function startScraper() {
  const count = await dbClient.countJobs();
  if (count > 0) throw databaseNotEmptyError();

  // Written before the extension is even asked to start: if the browser is
  // killed mid-scrape, this unfinished record is what tells the UI the job
  // list is incomplete (see enrichScraperStatus's "interrupted" handling) --
  // same guarantee as runner.py's start(), just made here since the
  // extension has no database access of its own.
  const startedAt = new Date().toISOString();
  await dbClient.setLastRun({
    state: "running",
    started_at: startedAt,
    finished_at: null,
    pages_completed: 0,
    total_pages: null,
    jobs_saved: 0,
  });
  getExtensionBridge().start();
  return { state: "starting", message: "Starting the scraper browser.", started_at: startedAt };
}

export function cancelScraper() {
  getExtensionBridge().cancel();
  return { state: "cancelling", message: "Aborting the scrape." };
}

// --- Export / database file ---------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downloads coop-jobs.json = { exported_at, jobs }, the same shape the old
 * /api/export/json route produced. */
export async function exportJobsJson() {
  const jobs = await dbClient.exportJobs();
  const payload = {
    exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    jobs,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  downloadBlob(blob, "coop-jobs.json");
}

/** Downloads the raw SQLite database file, interchangeable with the Python
 * app's coopjobs.db. */
export async function downloadDatabase() {
  const bytes = await dbClient.exportDbFile();
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  downloadBlob(blob, "coopjobs.db");
}

/** Replaces the in-browser database with the contents of `file` (a .db file
 * picked by the user, e.g. one downloaded from the Python app). */
export async function importDatabase(file) {
  const buffer = await file.arrayBuffer();
  await dbClient.importDbFile(new Uint8Array(buffer));
}

/** Downloads the extension's recorded debug snapshots (evidence captured for
 * failed cards / anomalies, plan §4 item 35) as one JSON file, for attaching
 * to a bug report. Resolves with an empty bundle if the extension has none
 * or doesn't answer in time -- see extensionBridge.js's getDebugSnapshots(). */
export async function downloadDebugBundle() {
  const snapshots = await getExtensionBridge().getDebugSnapshots();
  const payload = { exported_at: new Date().toISOString(), snapshots };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  downloadBlob(blob, "coopjobs-debug.json");
}
