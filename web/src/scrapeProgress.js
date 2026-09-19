/**
 * Pure progress maths shared by the scraper dialog's two bars and the
 * sidebar's status chip. No React, no DOM — safe to import from a plain
 * node script.
 */

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Percent of the whole run's pages: pages already completed plus how far
 * into the current page we are. `null` while `total_pages` isn't known yet
 * (still counting), so callers can fall back to an indeterminate state.
 */
export function totalPercent(status) {
  const totalPages = status?.total_pages;
  if (!totalPages) return null;
  const pagesDone = status?.pages_completed ?? 0;
  const current = status?.current;
  const withinPage = current?.total ? current.index / current.total : 0;
  return clampPercent(((pagesDone + withinPage) / totalPages) * 100);
}

/** Percent through the page being scraped right now; 0 when there is none. */
export function pagePercent(status) {
  const current = status?.current;
  if (!current?.total) return 0;
  return clampPercent((current.index / current.total) * 100);
}

/**
 * "page 3 of 39" for a finished run: it stopped part-way through the page
 * after the last completed one. Drops "of M" when the pager wasn't readable.
 */
export function runPageLabel(run) {
  const total = run?.total_pages;
  const stoppedOn = (run?.pages_completed ?? 0) + 1;
  if (!total) return `page ${stoppedOn}`;
  return `page ${Math.min(stoppedOn, total)} of ${total}`;
}

/** Ways a run can end with jobs saved but the list left half-finished. */
const INCOMPLETE_STATES = new Set(["cancelled", "failed", "interrupted"]);

/**
 * The last run when it ended early and left jobs behind, else `null`. Read
 * from `last_run`, which the server persists, so it survives a restart —
 * and is simply absent on an older server.
 */
export function incompleteRun(status) {
  if ((status?.job_count ?? 0) === 0) return null;
  const run = status?.last_run;
  return run && INCOMPLETE_STATES.has(run.state) ? run : null;
}
