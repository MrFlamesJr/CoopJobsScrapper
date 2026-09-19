import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import TopBar from "./components/TopBar.jsx";
import FilterChips from "./components/FilterChips.jsx";
import JobGrid from "./components/JobGrid.jsx";
import ScraperDialog from "./components/ScraperDialog.jsx";
import FavoritesDrawer from "./components/FavoritesDrawer.jsx";
import { clearJobDetailCache } from "./components/JobDetails.jsx";
import { useJobs } from "./hooks/useJobs.js";
import { useFacets } from "./hooks/useFacets.js";
import { useFavorites } from "./hooks/useFavorites.js";
import { useScraper } from "./hooks/useScraper.js";
import { HighlightContext } from "./highlight.jsx";
import { runPanelTransition } from "./viewTransition.js";
import "./App.css";

const EMPTY_FILTERS = {};

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
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("employer");
  const [deadlineMode, setDeadlineMode] = useState("open");
  const [facetFilters, setFacetFilters] = useState(EMPTY_FILTERS);
  const [highlightOn, setHighlightOn] = useState(loadHighlightOn);

  // Any number of cards can be expanded at once.
  const [expandedIds, setExpandedIds] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scraperOpen, setScraperOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Set together with refreshKey: true means "this refetch came from the live
  // scrape stream", so the grid swaps quietly instead of dimming.
  const [silentRefresh, setSilentRefresh] = useState(false);

  const filterState = useMemo(
    () => ({
      q,
      sort,
      deadline: deadlineMode === "all" ? "" : deadlineMode,
      filters: facetFilters,
    }),
    [q, sort, deadlineMode, facetFilters],
  );

  const { jobs, total, loading, error, appliedQ } = useJobs(filterState, refreshKey, silentRefresh);
  const { facets } = useFacets(refreshKey);
  // Refetches on refreshKey too, so re-linked and orphaned favorites update.
  const favorites = useFavorites(refreshKey);

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
  const handleJobsDeleted = useCallback(() => {
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
  }, []);

  const activeFilterCount = useMemo(
    () => Object.values(facetFilters).reduce((sum, values) => sum + values.length, 0),
    [facetFilters],
  );

  // The state flip, wrapped in a View Transition so the panel zooms out of
  // this card (and back into it) while the rest of the grid slides — see
  // viewTransition.js. Hovering or focusing the card already prefetched the
  // details, so there is nothing to wait for.
  const toggleExpand = useCallback((id) => {
    runPanelTransition({
      morphId: id,
      update: () =>
        setExpandedIds((current) =>
          current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
        ),
    });
  }, []);

  // With several panels closing at once there is no single card to zoom back
  // into, so they just slide away.
  const collapseAll = useCallback(() => {
    runPanelTransition({
      morphId: expandedIds.length === 1 ? expandedIds[0] : null,
      update: () => setExpandedIds([]),
    });
  }, [expandedIds]);

  const openScraper = useCallback(() => setScraperOpen(true), []);

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
          sort={sort}
          onSortChange={setSort}
          deadlineMode={deadlineMode}
          onDeadlineModeChange={setDeadlineMode}
          facets={facets}
          selectedFilters={facetFilters}
          onFacetToggle={handleFacetToggle}
          activeFilterCount={activeFilterCount}
          onClearFilters={clearFacetFilters}
          status={scraper.status}
          onOpenScraper={openScraper}
          isOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
          highlightOn={highlightOn}
          onToggleHighlight={toggleHighlight}
        />

        <main className="app-main">
          <TopBar
            shown={jobs.length}
            total={total}
            scraperRunning={scraperRunning}
            scraperStatus={scraper.status}
            onOpenScraper={openScraper}
            expandedCount={expandedIds.length}
            onCollapseAll={collapseAll}
            favoritesCount={favorites.favorites.length}
            pulseKey={favorites.pulseKey}
            onOpenFavorites={() => setFavoritesOpen(true)}
          />
          <FilterChips
            filters={facetFilters}
            onRemove={handleFacetToggle}
            onClearAll={clearFacetFilters}
            q={appliedQ}
            onClearSearch={() => setQ("")}
            hideClosed={deadlineMode === "open"}
            onShowClosed={() => setDeadlineMode("all")}
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
            savedJobNumbers={favorites.savedSet}
            onToggleFavorite={favorites.toggle}
            scraperStatus={scraper.status}
            scraperRunning={scraperRunning}
          />
        </main>

        <FavoritesDrawer
          open={favoritesOpen}
          onClose={() => setFavoritesOpen(false)}
          favorites={favorites.favorites}
          onToggle={favorites.toggle}
        />

        <ScraperDialog
          open={scraperOpen}
          onClose={() => setScraperOpen(false)}
          scraper={scraper}
          onJobsChanged={handleJobsDeleted}
        />
      </div>
    </HighlightContext.Provider>
  );
}
