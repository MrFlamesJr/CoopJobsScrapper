import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import TopBar from "./components/TopBar.jsx";
import FilterChips from "./components/FilterChips.jsx";
import JobGrid from "./components/JobGrid.jsx";
import ScraperDialog from "./components/ScraperDialog.jsx";
import AboutModal from "./components/AboutModal.jsx";
import BackToTop from "./components/BackToTop.jsx";
import { clearJobDetailCache } from "./components/JobDetails.jsx";
import { useJobs } from "./hooks/useJobs.js";
import { useFacets } from "./hooks/useFacets.js";
import { useRatings } from "./hooks/useRatings.js";
import { useScraper } from "./hooks/useScraper.js";
import { HighlightContext } from "./highlight.jsx";
import { readUrlState, writeUrlState } from "./urlState.js";
import "./App.css";

const EMPTY_FILTERS = {};

// The sort stack, most significant first. One row is always kept, so the
// default is the single sort the old <select> started on.
const DEFAULT_SORTS = [{ field: "employer", dir: "asc" }];

// Jobs are saved one by one during a scrape. Refetch at most this often, with
// a trailing call, so a burst of jobs is a single refetch.
const LIVE_REFRESH_MS = 1500;

// Whether search matches are highlighted, same try/catch persistence pattern
// as the sidebar's saved width.
const HIGHLIGHT_KEY = "searchHighlight";

function loadHighlightOn() {
  try {
    const saved = localStorage.getItem(HIGHLIGHT_KEY);
    if (saved !== null) return saved === "1";
  } catch {
    // Storage can be unavailable (private mode); default to on.
  }
  return true;
}

function saveHighlightOn(on) {
  try {
    localStorage.setItem(HIGHLIGHT_KEY, on ? "1" : "0");
  } catch {
    // Storage can be unavailable; the setting just won't persist.
  }
}

export default function App() {
  // Read once on the first render, so all five pieces come from the same URL.
  const [initialUrlState] = useState(readUrlState);
  const [q, setQ] = useState(initialUrlState.q);
  const [sorts, setSorts] = useState(initialUrlState.sorts);
  const [ratingFilter, setRatingFilter] = useState(initialUrlState.ratingFilter);
  const [deadlineMode, setDeadlineMode] = useState(initialUrlState.deadlineMode);
  const [facetFilters, setFacetFilters] = useState(initialUrlState.facetFilters);
  const [highlightOn, setHighlightOn] = useState(loadHighlightOn);

  // Any number of cards can be expanded at once.
  const [expandedIds, setExpandedIds] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scraperOpen, setScraperOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Set together with refreshKey: true means "this refetch came from the live
  // scrape stream", so the grid swaps quietly instead of dimming.
  const [silentRefresh, setSilentRefresh] = useState(false);

  const filterState = useMemo(
    () => ({
      q,
      sorts,
      rating: ratingFilter === "all" ? null : ratingFilter,
      deadline: deadlineMode === "all" ? "" : deadlineMode,
      filters: facetFilters,
    }),
    [q, sorts, ratingFilter, deadlineMode, facetFilters],
  );

  // Update URL when filter state changes
  useEffect(() => {
    writeUrlState({
      q,
      sorts,
      ratingFilter,
      deadlineMode,
      facetFilters,
    });
  }, [q, sorts, ratingFilter, deadlineMode, facetFilters]);

  const { jobs, total, loading, error, appliedQ } = useJobs(filterState, refreshKey, silentRefresh);
  const { facets } = useFacets(refreshKey);
  // Refetches on refreshKey too, so re-linked and orphaned ratings update.
  const ratings = useRatings(refreshKey);

  // The top bar's counts come straight from the optimistic ratings state, so
  // a thumb click shows up at once.
  const stats = useMemo(
    () => ({ liked: ratings.likedCount, disliked: ratings.dislikedCount }),
    [ratings.likedCount, ratings.dislikedCount],
  );

  // Lowercase search words currently highlighted, or empty when the toggle is
  // off. `appliedQ` (not the raw, still-debouncing `q`) is what the visible
  // results actually matched, so marks never run ahead of the list.
  const words = useMemo(
    () => (highlightOn ? appliedQ.toLowerCase().split(/\s+/).filter(Boolean) : []),
    [highlightOn, appliedQ],
  );

  const toggleHighlight = useCallback(() => {
    setHighlightOn((prev) => {
      const next = !prev;
      saveHighlightOn(next);
      return next;
    });
  }, []);

  // Both useJobs and useFacets refetch automatically when refreshKey changes.
  const bumpRefresh = useCallback((silent = false) => {
    setSilentRefresh(silent);
    setRefreshKey((k) => k + 1);
  }, []);

  // A finished scrape only refetches: cards you opened while watching the jobs
  // arrive stay open.
  const handleScrapeFinished = useCallback(() => {
    bumpRefresh();
  }, [bumpRefresh]);

  // "Delete all jobs" empties the grid, so expanded cards go with it. Cached
  // details go too: SQLite hands the old row ids to the next scrape's jobs.
  // Opening a database swaps the whole row set the same way, so it uses this
  // as well rather than a plain refresh.
  const handleJobsReplaced = useCallback(() => {
    clearJobDetailCache();
    setExpandedIds([]);
    bumpRefresh();
  }, [bumpRefresh]);

  const scraper = useScraper({ onFinished: handleScrapeFinished });

  const scraperRunning = scraper.isRunning(scraper.status?.state);
  const jobsSaved = scraper.status?.jobs_saved ?? 0;

  // A run starting is the moment rows with recycled ids begin to appear, so
  // anything cached from before it belongs to a different job.
  useEffect(() => {
    if (scraperRunning) clearJobDetailCache();
  }, [scraperRunning]);

  // Watch jobs arrive: every time the runner saves one, refresh the grid and
  // the facet counts — throttled, and always with a trailing refetch so the
  // last jobs of a burst show up too.
  const lastLiveRefreshRef = useRef(0);
  useEffect(() => {
    if (!scraperRunning || jobsSaved === 0) return undefined;
    const waited = Date.now() - lastLiveRefreshRef.current;
    if (waited >= LIVE_REFRESH_MS) {
      lastLiveRefreshRef.current = Date.now();
      bumpRefresh(true);
      return undefined;
    }
    const timer = setTimeout(() => {
      lastLiveRefreshRef.current = Date.now();
      bumpRefresh(true);
    }, LIVE_REFRESH_MS - waited);
    return () => clearTimeout(timer);
  }, [scraperRunning, jobsSaved, bumpRefresh]);

  // With a rating filter on, the job that was just liked/disliked may no
  // longer belong in the grid. Refetch once the write has landed (quietly, so
  // the grid does not dim).
  const handleRate = useCallback(
    (job, rating) => {
      const done = ratings.setRating(job, rating);
      if (ratingFilter !== "all") Promise.resolve(done).then(() => bumpRefresh(true));
    },
    [ratings, ratingFilter, bumpRefresh],
  );

  const handleFacetToggle = useCallback((field, value) => {
    setFacetFilters((prev) => {
      const current = prev[field] || [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      const updated = { ...prev };
      if (next.length === 0) delete updated[field];
      else updated[field] = next;
      return updated;
    });
    setExpandedIds([]);
  }, []);

  const clearFacetFilters = useCallback(() => setFacetFilters({}), []);

  const clearAll = useCallback(() => {
    setQ("");
    setFacetFilters({});
    setDeadlineMode("open");
    setRatingFilter("all");
  }, []);

  const activeFilterCount = useMemo(
    () => Object.values(facetFilters).reduce((sum, values) => sum + values.length, 0),
    [facetFilters],
  );

  // Opening and closing is now an instant state flip with no animation.
  // Hovering or focusing the card already prefetched the details, so there is
  // nothing to wait for.
  const toggleExpand = useCallback((id) => {
    setExpandedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);

  const collapseAll = useCallback(() => setExpandedIds([]), []);

  const openScraper = useCallback(() => setScraperOpen(true), []);

  // Shared between the sidebar's status chip and the Data dialog, so the
  // dialog can read the chip's on-screen position and animate outward from
  // it (see ScraperDialog's open effect).
  const statusChipRef = useRef(null);

  return (
    <HighlightContext.Provider value={words}>
      <div className="app-shell">
        <div className="app-topbar">
          <button
            type="button"
            className="app-topbar__toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open filters"
          >
            ☰
          </button>
          <span className="app-topbar__title">Co-op Jobs</span>
        </div>

        <Sidebar
          q={q}
          onQChange={setQ}
          sorts={sorts}
          onSortsChange={setSorts}
          ratingFilter={ratingFilter}
          onRatingFilterChange={setRatingFilter}
          deadlineMode={deadlineMode}
          onDeadlineModeChange={setDeadlineMode}
          facets={facets}
          selectedFilters={facetFilters}
          onFacetToggle={handleFacetToggle}
          activeFilterCount={activeFilterCount}
          onClearFilters={clearFacetFilters}
          status={scraper.status}
          onOpenScraper={openScraper}
          statusChipRef={statusChipRef}
          isOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
          highlightOn={highlightOn}
          onToggleHighlight={toggleHighlight}
          onOpenAbout={() => setAboutOpen(true)}
        />

        <main className="app-main">
          <TopBar
            shown={jobs.length}
            total={total}
            stats={stats}
            scraperRunning={scraperRunning}
            scraperStatus={scraper.status}
            onOpenScraper={openScraper}
            expandedCount={expandedIds.length}
            onCollapseAll={collapseAll}
          />
          <FilterChips
            filters={facetFilters}
            onRemove={handleFacetToggle}
            onClearAll={clearFacetFilters}
            q={appliedQ}
            onClearSearch={() => setQ("")}
            hideClosed={deadlineMode === "open"}
            onShowClosed={() => setDeadlineMode("all")}
            ratingFilter={ratingFilter}
            onClearRatingFilter={() => setRatingFilter("all")}
          />
          <JobGrid
            jobs={jobs}
            total={total}
            loading={loading}
            error={error}
            expandedIds={expandedIds}
            onToggleExpand={toggleExpand}
            onOpenScraper={openScraper}
            onClearFilters={clearAll}
            ratingMap={ratings.ratingMap}
            onRate={handleRate}
            scraperStatus={scraper.status}
            scraperRunning={scraperRunning}
          />
        </main>

        <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

        <ScraperDialog
          open={scraperOpen}
          onClose={() => setScraperOpen(false)}
          scraper={scraper}
          onJobsChanged={handleJobsReplaced}
          onDatabaseImported={() => { handleJobsReplaced(); scraper.resetToIdle(); }}
          statusChipRef={statusChipRef}
        />

        <BackToTop />
      </div>
    </HighlightContext.Provider>
  );
}
