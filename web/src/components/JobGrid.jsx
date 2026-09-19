import JobCard from "./JobCard.jsx";
import "./JobGrid.css";

export default function JobGrid({
  jobs,
  total,
  loading,
  error,
  expandedId,
  onToggleExpand,
  onOpenScraper,
  onClearFilters,
}) {
  if (error) {
    return (
      <div className="job-grid__empty">
        <p>Couldn't load jobs: {error.message}</p>
      </div>
    );
  }

  if (total === 0 && !loading) {
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

  return (
    <>
      <p className="job-grid__count">
        <strong>{jobs.length}</strong> job{jobs.length === 1 ? "" : "s"} of {total}
      </p>
      <div className={`job-grid ${loading ? "job-grid--loading" : ""}`}>
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            expanded={expandedId === job.id}
            onToggle={onToggleExpand}
          />
        ))}
      </div>
    </>
  );
}
