import { useCallback, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import FilterChips from "./components/FilterChips.jsx";
import JobGrid from "./components/JobGrid.jsx";
import ScraperDialog from "./components/ScraperDialog.jsx";
import { useJobs } from "./hooks/useJobs.js";
import { useFacets } from "./hooks/useFacets.js";
import { useScraper } from "./hooks/useScraper.js";
import "./App.css";

const EMPTY_FILTERS = {};

export default function App() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("deadline");
  const [deadlineMode, setDeadlineMode] = useState("open");
  const [facetFilters, setFacetFilters] = useState(EMPTY_FILTERS);

  const [expandedId, setExpandedId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scraperOpen, setScraperOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const filterState = useMemo(
    () => ({
      q,
      sort,
      deadline: deadlineMode === "all" ? "" : deadlineMode,
      filters: facetFilters,
    }),
    [q, sort, deadlineMode, facetFilters],
  );

  const { jobs, total, loading, error } = useJobs(filterState, refreshKey);
  const { facets } = useFacets(refreshKey);

  // Both useJobs and useFacets refetch automatically when refreshKey changes.
  const bumpRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // After a scrape finishes (or the DB is cleared), drop any expanded card
  // and refetch jobs + facets.
  const handleScraperFinished = useCallback(() => {
    setExpandedId(null);
    bumpRefresh();
  }, [bumpRefresh]);

  const scraper = useScraper({
    isOpen: scraperOpen,
    onFinished: handleScraperFinished,
  });

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
    setExpandedId(null);
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

  const toggleExpand = useCallback((id) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  return (
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
        onOpenScraper={() => setScraperOpen(true)}
        isOpen={sidebarOpen}
        onCloseMobile={() => setSidebarOpen(false)}
      />

      <main className="app-main">
        <FilterChips filters={facetFilters} onRemove={handleFacetToggle} onClearAll={clearFacetFilters} />

        <JobGrid
          jobs={jobs}
          total={total}
          loading={loading}
          error={error}
          expandedId={expandedId}
          onToggleExpand={toggleExpand}
          onOpenScraper={() => setScraperOpen(true)}
          onClearFilters={clearAll}
        />
      </main>

      <ScraperDialog
        open={scraperOpen}
        onClose={() => setScraperOpen(false)}
        scraper={scraper}
        onJobsChanged={handleScraperFinished}
      />
    </div>
  );
}
