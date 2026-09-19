import { useRef } from "react";
import JobCard from "./JobCard.jsx";
import JobPanel from "./JobPanel.jsx";
import Spinner from "./Spinner.jsx";
import { useGridColumns } from "../hooks/useGridColumns.js";
import "./JobGrid.css";

const NO_FAVORITES = new Set();

// How long a card that just arrived plays its rise-in entrance. Live
// refreshes are more frequent than that, so the arrival time is what decides,
// not the render.
const HIGHLIGHT_MS = 4000;

export default function JobGrid({
  jobs,
  total,
  loading,
  error,
  expandedIds = [],
  onToggleExpand,
  onOpenScraper,
  onClearFilters,
  savedJobNumbers = NO_FAVORITES,
  onToggleFavorite,
  scraperStatus = null,
  scraperRunning = false,
}) {
  // Panels are placed by row (see below), so the grid has to know how many
  // columns it actually got.
  const gridRef = useRef(null);
  const columns = useGridColumns(gridRef);

  // Which ids arrived in the last few seconds, so they can play an entrance.
  // Derived from the previous list, and only while a scrape runs: changing a
  // filter never makes cards "new". Keyed on the `jobs` identity so a re-render
  // with the same list doesn't shift the window.
  const seenRef = useRef({ jobs: null, ids: null, marked: new Map() });
  if (seenRef.current.jobs !== jobs) {
    const now = Date.now();
    const ids = new Set(jobs.map((job) => job.id));
    const { ids: previous, marked } = seenRef.current;
    const nextMarked = new Map();
    marked.forEach((at, id) => {
      if (now - at < HIGHLIGHT_MS && ids.has(id)) nextMarked.set(id, at);
    });
    if (previous && scraperRunning) {
      jobs.forEach((job) => {
        if (!previous.has(job.id) && !nextMarked.has(job.id)) nextMarked.set(job.id, now);
      });
    }
    seenRef.current = { jobs, ids, marked: nextMarked };
  }
  const newIds = seenRef.current.marked;

  if (error) {
    return (
      <div className="job-grid__empty">
        <p>Couldn't load jobs: {error.message}</p>
      </div>
    );
  }

  // Nothing in the database yet. While a scrape runs that isn't a dead end:
  // the first cards are on their way.
  if (total === 0 && !loading) {
    if (scraperRunning) {
      const scraping = scraperStatus?.state === "scraping";
      return (
        <div className="job-grid__empty job-grid__empty--live">
          <Spinner size={22} />
          <div>
            <h2>{scraping ? "Scraping the first page…" : "Waiting for the first jobs…"}</h2>
            <p>
              {scraping
                ? "Jobs appear here as they're scraped. Leave the Chrome window alone."
                : "Log in in the Chrome window if you haven't yet."}
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="job-grid__empty">
        <h2>No jobs yet</h2>
        <p>Run the scraper to pull the latest co-op postings into your database.</p>
        <button type="button" className="job-grid__cta" onClick={onOpenScraper}>
          Open scraper
        </button>
      </div>
    );
  }

  if (jobs.length === 0 && !loading) {
    return (
      <div className="job-grid__empty">
        <h2>No jobs match</h2>
        <p>Try widening your search or filters.</p>
        <button type="button" className="job-grid__cta" onClick={onClearFilters}>
          Clear filters
        </button>
      </div>
    );
  }

  // A row of cards, then the panels belonging to that row, newest-opened
  // first (`expandedIds` is in open order). The panel you just opened is then
  // always directly under its own row, never below someone else's tall panel,
  // which is what makes the zoom readable. Keys are stable across a reflow, so
  // React moves nodes instead of remounting them.
  const expanded = new Set(expandedIds);
  const items = [];
  for (let start = 0; start < jobs.length; start += columns) {
    const row = jobs.slice(start, start + columns);
    row.forEach((job) => {
      items.push(
        <JobCard
          key={`card-${job.id}`}
          job={job}
          expanded={expanded.has(job.id)}
          onToggle={onToggleExpand}
          saved={savedJobNumbers.has(job.job_number)}
          onToggleFavorite={onToggleFavorite}
          isNew={newIds.has(job.id)}
        />,
      );
    });
    for (let i = expandedIds.length - 1; i >= 0; i -= 1) {
      const job = row.find((candidate) => candidate.id === expandedIds[i]);
      if (!job) continue;
      items.push(
        <JobPanel
          key={`panel-${job.id}`}
          job={job}
          saved={savedJobNumbers.has(job.job_number)}
          onToggleFavorite={onToggleFavorite}
          onClose={() => onToggleExpand(job.id)}
        />,
      );
    }
  }

  return (
    <div ref={gridRef} className={`job-grid ${loading ? "job-grid--loading" : ""}`}>
      {items}
    </div>
  );
}
