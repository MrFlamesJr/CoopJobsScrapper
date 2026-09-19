// Every function here keeps its original name and return shape (see the
// server routes this used to hit, app/server.py), but the jobs/facets/
// favorites data now comes straight from the in-browser SQLite database
// (web/src/db) instead of the Flask API.

import { dbClient, requestPersistentStorage } from "./db/client.js";

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

// --- Scraper endpoints -------------------------------------------------
// TODO(phase 3): rewire the scraper to save straight into the in-browser
// SQLite database; until then these still talk to the (soon to be retired)
// Flask server, via the dev-server /api proxy in vite.config.js.

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (cause) {
    const err = new Error("Network error — is the server running?");
    err.code = "network_error";
    err.cause = cause;
    throw err;
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const err = new Error(
      (body && body.message) || `Request failed (${response.status})`,
    );
    err.code = (body && body.error) || `http_${response.status}`;
    err.status = response.status;
    throw err;
  }

  return body;
}

// Server-sent events: the same status object as /api/scraper/status, pushed
// on every change.
export const SCRAPER_STREAM_URL = "/api/scraper/stream";

export function fetchScraperStatus(signal) {
  return request("/api/scraper/status", { signal });
}

export function startScraper() {
  return request("/api/scraper/start", { method: "POST" });
}

export function cancelScraper() {
  return request("/api/scraper/cancel", { method: "POST" });
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
