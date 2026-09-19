import { memo, useContext } from "react";
import DeadlineChip from "./DeadlineChip.jsx";
import { loadJobDetail } from "./JobDetails.jsx";
import FavoriteButton from "./FavoriteButton.jsx";
import JobNumber from "./JobNumber.jsx";
import { Highlight, HighlightContext } from "../highlight.jsx";
import "./JobCard.css";

// job.match?.snippet.field -> human label, for the fields that never show up
// on the card itself.
const SNIPPET_LABELS = {
  description: "Description",
  requirements: "Requirements",
  qualifications: "Qualifications",
  salary: "Salary",
  round: "Round",
  term: "Term",
  deadline_text: "Deadline",
};

function JobCard({ job, expanded, onToggle, saved, onToggleFavorite, isNew }) {
  const meta = [job.location, job.duration, job.work_model].filter(Boolean).join(" · ");
  const words = useContext(HighlightContext);
  // Only worth showing once highlighting is on: it's a snippet from a field
  // the card doesn't otherwise display, and without marks it's just noise.
  const snippet = words.length > 0 ? job.match?.snippet : null;

  const handleKeyDown = (e) => {
    if (expanded && e.key === "Escape") {
      e.stopPropagation();
      onToggle(job.id);
    }
  };

  // Fires as soon as the pointer or keyboard focus lands anywhere on the
  // card — well before a click — so the panel the grid opens for it usually
  // has its data already, and the zoom doesn't start on "Loading…".
  const prefetch = () => {
    loadJobDetail(job.id).catch(() => {});
  };

  return (
    <article
      className={`job-card ${expanded ? "job-card--expanded" : ""} ${isNew ? "job-card--new" : ""}`}
      data-job-id={job.id}
      onKeyDown={handleKeyDown}
      onPointerEnter={prefetch}
      onFocus={prefetch}
    >
      {/* The cover is the whole card. The summary button's ::after
          overlay stretches its click target across it, footer included, so the
          footer can hold its own buttons without nesting them in a button. */}
      <div className="job-card__cover">
        <button
          type="button"
          className="job-card__summary"
          onClick={() => onToggle(job.id)}
          aria-expanded={expanded}
        >
          <div className="job-card__top">
            <JobNumber value={job.job_number} />
            <DeadlineChip deadline_date={job.deadline_date} deadline_text={job.deadline_text} />
          </div>
          <h3 className="job-card__title">
            <Highlight text={job.title || "Untitled position"} />
          </h3>
          <div className="job-card__employer">
            <Highlight text={job.employer || "Unknown employer"} />
          </div>
          {snippet && (
            <div className="job-card__snippet">
              <span className="job-card__snippet-label">
                {SNIPPET_LABELS[snippet.field] || snippet.field}
              </span>
              <span className="job-card__snippet-text">
                <Highlight text={snippet.text} />
              </span>
            </div>
          )}
        </button>

        <div className="job-card__footer">
          <span className="job-card__meta">
            <Highlight text={meta} />
          </span>
          <FavoriteButton
            jobNumber={job.job_number}
            saved={saved}
            onToggle={() => onToggleFavorite?.(job)}
          />
        </div>
      </div>
    </article>
  );
}

// Toggling one card re-renders the whole grid, but only that card's `expanded`
// actually changes; the rest of the props are referentially stable, so memo
// keeps a toggle's render cost off the other cards.
export default memo(JobCard);
