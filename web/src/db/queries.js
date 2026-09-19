// Pure port of app/db.py. Every function takes a thin sync DB handle:
//   { exec(sql, params) -> array of row objects, run(sql, params) -> { changes } }
// so the same code runs against sqlite-wasm (in the worker) or better-sqlite3
// (in tests) without change.

import { parseDeadline } from "./deadlines.js";

export const FACET_FIELDS = ["employer", "location", "work_model", "term", "duration", "round"];

export const COVER_COLUMNS = [
  "id",
  "job_number",
  "title",
  "employer",
  "location",
  "duration",
  "work_model",
  "term",
  "deadline_text",
  "deadline_date",
];

const JOB_FIELDS = [
  "job_number",
  "title",
  "employer",
  "location",
  "duration",
  "work_model",
  "term",
  "round",
  "salary",
  "deadline_text",
  "description",
];

// Columns queryJobs adds (on top of COVER_COLUMNS) only when `q` has words, to
// compute `match` -- stripped back out before the job objects are returned.
const MATCH_EXTRA_COLUMNS = ["round", "salary", "description", "requirements", "qualifications"];

// All fields `match.fields` checks, using the job's real field names.
const MATCH_FIELDS = [
  "job_number",
  "title",
  "employer",
  "location",
  "duration",
  "work_model",
  "term",
  "round",
  "salary",
  "deadline_text",
  "description",
  "requirements",
  "qualifications",
];

// What's visible on a (collapsed) job card, without opening it.
const CARD_VISIBLE_FIELDS = ["job_number", "title", "employer", "location", "duration", "work_model"];

// Snippet search order for a word that isn't visible on the card.
const SNIPPET_FIELDS = ["term", "round", "salary", "deadline_text", "requirements", "qualifications", "description"];

const SNIPPET_RADIUS = 60;

const SORTS = {
  deadline: "deadline_date IS NULL, deadline_date ASC, title ASC",
  title: "title ASC",
  employer: "employer ASC, title ASC",
  newest: "id DESC",
};

/** Run schema.sql's statements against a fresh handle. Mirrors
 * conn.executescript(): schema.sql has no semicolons except at statement
 * boundaries, so a naive split is safe here. */
export function initDb(handle, schemaSql) {
  const statements = schemaSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    handle.run(statement, []);
  }
}

function orEmpty(value) {
  return value || "";
}

function searchText(job) {
  const parts = JOB_FIELDS.map((field) => String(job[field] ?? ""));
  for (const requirement of job.requirements || []) parts.push(String(requirement));
  for (const qualification of job.qualifications || []) {
    parts.push(String(qualification?.name ?? ""));
    parts.push(String(qualification?.value ?? ""));
  }
  return parts.join(" ").toLowerCase();
}

export function insertJobs(handle, jobs) {
  let inserted = 0;
  for (const job of jobs) {
    const deadlineText = orEmpty(job.deadline_text);
    const deadlineDate = parseDeadline(deadlineText);
    const result = handle.run(
      `INSERT OR IGNORE INTO jobs (
        job_number, title, employer, location, duration, work_model, term,
        round, salary, deadline_text, deadline_date, description,
        requirements, qualifications, search_text, page_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orEmpty(job.job_number),
        orEmpty(job.title),
        orEmpty(job.employer),
        orEmpty(job.location),
        orEmpty(job.duration),
        orEmpty(job.work_model),
        orEmpty(job.term),
        orEmpty(job.round),
        orEmpty(job.salary),
        deadlineText,
        deadlineDate,
        orEmpty(job.description),
        JSON.stringify(job.requirements || []),
        JSON.stringify(job.qualifications || []),
        searchText(job),
        job.page_number ?? null,
      ],
    );
    inserted += result.changes;
  }
  return inserted;
}

export function countJobs(handle) {
  const rows = handle.exec("SELECT COUNT(*) AS n FROM jobs", []);
  return rows[0].n;
}

export function lastScrapedAt(handle) {
  const rows = handle.exec("SELECT MAX(scraped_at) AS latest FROM jobs", []);
  const latest = rows[0] ? rows[0].latest : null;
  if (!latest) return null;
  // sqlite's datetime('now') default is always "YYYY-MM-DD HH:MM:SS" (UTC, no
  // fractional seconds), so this is a straight reformat, same as the Python
  // strptime/strftime round trip.
  return `${latest.slice(0, 10)}T${latest.slice(11, 19)}Z`;
}

function escapeLike(word) {
  return word.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** The searchable text of one field, for a job whose `requirements` /
 * `qualifications` are already decoded to an array / array of objects. */
function fieldText(job, field) {
  if (field === "requirements") return (job.requirements || []).join(" ");
  if (field === "qualifications") {
    return (job.qualifications || [])
      .map((q) => `${q?.name ?? ""}: ${q?.value ?? ""}`)
      .join(", ");
  }
  return String(job[field] ?? "");
}

function findInRange(text, ch, start, end) {
  const idx = text.indexOf(ch, start);
  return idx !== -1 && idx < end ? idx : -1;
}

function rfindInRange(text, ch, start, end) {
  if (end <= start) return -1;
  const idx = text.slice(start, end).lastIndexOf(ch);
  return idx === -1 ? -1 : start + idx;
}

/** First hit of `word` (lowercase) across SNIPPET_FIELDS, as ~120 chars
 * trimmed to word boundaries with an ellipsis on each cut side. */
function findSnippet(fieldTexts, word) {
  for (const field of SNIPPET_FIELDS) {
    // collapse whitespace first, same as Python's " ".join(text.split())
    const text = fieldTexts[field].split(/\s+/).filter(Boolean).join(" ");
    const idx = text.toLowerCase().indexOf(word);
    if (idx === -1) continue;

    let start = Math.max(0, idx - SNIPPET_RADIUS);
    let end = Math.min(text.length, idx + word.length + SNIPPET_RADIUS);
    if (start > 0) {
      const space = findInRange(text, " ", start, idx);
      if (space !== -1) start = space + 1;
    }
    if (end < text.length) {
      const space = rfindInRange(text, " ", idx + word.length, end);
      if (space !== -1) end = space;
    }

    let snippet = text.slice(start, end).trim();
    if (start > 0) snippet = `\u2026${snippet}`;
    if (end < text.length) snippet += "\u2026";
    return { field, text: snippet };
  }
  return null;
}

/** The `match` payload for one job plus its ranking tier (0 best), for a job
 * whose `requirements` / `qualifications` are already decoded. */
function matchInfo(job, words) {
  const fieldTexts = {};
  const lowerTexts = {};
  for (const field of MATCH_FIELDS) {
    fieldTexts[field] = fieldText(job, field);
    lowerTexts[field] = fieldTexts[field].toLowerCase();
  }

  const fields = MATCH_FIELDS.filter((field) => words.some((word) => lowerTexts[field].includes(word)));
  const cardVisibleWords = new Set(
    words.filter((word) => CARD_VISIBLE_FIELDS.some((field) => lowerTexts[field].includes(word))),
  );

  let snippet = null;
  for (const word of words) {
    if (cardVisibleWords.has(word)) continue;
    snippet = findSnippet(fieldTexts, word);
    if (snippet !== null) break;
  }

  let tier;
  if (words.every((word) => lowerTexts.title.includes(word))) {
    tier = 0;
  } else if (words.every((word) => cardVisibleWords.has(word))) {
    tier = 1;
  } else {
    tier = 2;
  }

  return [{ fields, snippet }, tier];
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * options: { q, filters: {field: [values]}, deadline, sort, today }
 * `today`, when given, is a "YYYY-MM-DD" string (the JS equivalent of the
 * Python `date` object the original takes) — injectable for tests.
 */
export function queryJobs(handle, options = {}) {
  const { q = "", filters = null, deadline = null, sort = "deadline", today = null } = options;

  const where = [];
  const params = [];

  const words = q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  for (const word of words) {
    where.push("search_text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(word)}%`);
  }

  for (const [field, values] of Object.entries(filters || {})) {
    if (!FACET_FIELDS.includes(field) || !values || values.length === 0) continue;
    const placeholders = values.map(() => "?").join(", ");
    where.push(`${field} IN (${placeholders})`);
    params.push(...values);
  }

  const todayStr = today || todayString();
  if (deadline === "open") {
    where.push("(deadline_date >= ? OR deadline_date IS NULL)");
    params.push(todayStr);
  } else if (deadline === "week") {
    where.push("(deadline_date >= ? AND deadline_date <= ?)");
    params.push(todayStr);
    params.push(addDays(todayStr, 7));
  } else if (deadline === "closed") {
    where.push("deadline_date < ?");
    params.push(todayStr);
  }

  const orderBy = SORTS[sort] || SORTS.deadline;
  const columns = words.length ? [...COVER_COLUMNS, ...MATCH_EXTRA_COLUMNS] : COVER_COLUMNS;
  let sql = `SELECT ${columns.join(", ")} FROM jobs`;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY ${orderBy}`;

  const rows = handle.exec(sql, params);
  const jobs = rows.map((row) => ({ ...row }));
  if (!words.length) return jobs;

  // Rank on top of the SQL order: a stable sort by tier keeps ties in place
  // (Array.prototype.sort is guaranteed stable since ES2019).
  const decorated = [];
  for (const job of jobs) {
    job.requirements = JSON.parse(job.requirements);
    job.qualifications = JSON.parse(job.qualifications);
    const [match, tier] = matchInfo(job, words);
    for (const column of MATCH_EXTRA_COLUMNS) delete job[column];
    job.match = match;
    decorated.push([tier, job]);
  }
  decorated.sort((a, b) => a[0] - b[0]);
  return decorated.map(([, job]) => job);
}

/** Turn a raw `jobs` row into the API/export shape: drop search_text, decode
 * JSON lists. */
function decodeJob(row) {
  const job = { ...row };
  delete job.search_text;
  job.requirements = JSON.parse(job.requirements);
  job.qualifications = JSON.parse(job.qualifications);
  return job;
}

export function getJob(handle, jobId) {
  const rows = handle.exec("SELECT * FROM jobs WHERE id = ?", [jobId]);
  return rows.length ? decodeJob(rows[0]) : null;
}

export function getFacets(handle) {
  const facets = {};
  for (const field of FACET_FIELDS) facets[field] = [];
  const rows = handle.exec(
    "SELECT field, value, job_count FROM job_facets ORDER BY field, job_count DESC, value ASC",
    [],
  );
  for (const row of rows) {
    if (row.field in facets) facets[row.field].push({ value: row.value, count: row.job_count });
  }
  return facets;
}

export function clearJobs(handle) {
  handle.run("DELETE FROM jobs", []);
  // No jobs, nothing that could be incomplete: the last run goes with them.
  handle.run("DELETE FROM scrape_meta WHERE key = 'last_run'", []);
}

/** Remember the latest scrape run (state, timings, counters) as JSON. */
export function setLastRun(handle, run) {
  handle.run(
    `INSERT INTO scrape_meta (key, value) VALUES ('last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(run)],
  );
}

/** The latest run record, or null when there is none. Also null when the row
 * cannot be read (a database from before scrape_meta, or unreadable JSON): a
 * missing run record must never break the status view. */
export function getLastRun(handle) {
  let rows;
  try {
    rows = handle.exec("SELECT value FROM scrape_meta WHERE key = 'last_run'", []);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  let run;
  try {
    run = JSON.parse(rows[0].value);
  } catch {
    return null;
  }
  return run && typeof run === "object" && !Array.isArray(run) ? run : null;
}

/** Saved jobs, newest first. `job` is the cover object, or null while the job
 * is missing from the jobs table (cleared or dropped by a re-scrape). */
export function listFavorites(handle) {
  const columns = COVER_COLUMNS.map((column) => `j.${column} AS job_${column}`).join(", ");
  const rows = handle.exec(
    `SELECT f.job_number, f.title, f.employer, f.created_at, ${columns}
     FROM favorites f LEFT JOIN jobs j ON j.job_number = f.job_number
     ORDER BY f.created_at DESC, f.rowid DESC`,
    [],
  );
  return rows.map((row) => {
    let job = null;
    if (row.job_id !== null && row.job_id !== undefined) {
      job = {};
      for (const column of COVER_COLUMNS) job[column] = row[`job_${column}`];
    }
    return {
      job_number: row.job_number,
      title: row.title,
      employer: row.employer,
      created_at: row.created_at,
      job,
    };
  });
}

/** Save a job, keeping a title/employer snapshot. Idempotent. Returns false
 * when no job has that number. */
export function addFavorite(handle, jobNumber) {
  if (!jobNumber) return false;
  const rows = handle.exec("SELECT title, employer FROM jobs WHERE job_number = ?", [jobNumber]);
  if (!rows.length) return false;
  const { title, employer } = rows[0];
  handle.run("INSERT OR IGNORE INTO favorites (job_number, title, employer) VALUES (?, ?, ?)", [
    jobNumber,
    title,
    employer,
  ]);
  return true;
}

/** Unsave a job. Returns false when it wasn't a favorite. */
export function removeFavorite(handle, jobNumber) {
  const result = handle.run("DELETE FROM favorites WHERE job_number = ?", [jobNumber]);
  return result.changes > 0;
}

export function exportJobs(handle) {
  const rows = handle.exec("SELECT * FROM jobs ORDER BY id", []);
  return rows.map(decodeJob);
}
