// Thin fetch helpers. Every function returns parsed JSON on success or
// throws an Error whose `.code` is the server's `error` field (when present)
// and whose `.message` is the human-readable text.

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

function toQueryString(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((v) => v !== "" && search.append(key, v));
    } else {
      search.append(key, value);
    }
  });
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function fetchJobs(params, signal) {
  return request(`/api/jobs${toQueryString(params)}`, { signal });
}

export function fetchJob(id) {
  return request(`/api/jobs/${id}`);
}

export function fetchFacets(signal) {
  return request("/api/facets", { signal });
}

export function deleteAllJobs() {
  return request("/api/jobs", { method: "DELETE" });
}

export function fetchScraperStatus(signal) {
  return request("/api/scraper/status", { signal });
}

export function startScraper() {
  return request("/api/scraper/start", { method: "POST" });
}

export function cancelScraper() {
  return request("/api/scraper/cancel", { method: "POST" });
}

export const EXPORT_JSON_URL = "/api/export/json";
