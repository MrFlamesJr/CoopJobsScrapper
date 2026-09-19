import DeadlineChip from "./DeadlineChip.jsx";
import JobDetails from "./JobDetails.jsx";
import "./JobCard.css";

export default function JobCard({ job, expanded, onToggle }) {
  const meta = [job.location, job.duration, job.work_model].filter(Boolean);

  const handleKeyDown = (e) => {
    if (expanded && e.key === "Escape") {
      e.stopPropagation();
      onToggle(job.id);
    }
  };

  return (
    <article
      className={`job-card ${expanded ? "job-card--expanded" : ""}`}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="job-card__summary"
        onClick={() => onToggle(job.id)}
        aria-expanded={expanded}
      >
        <div className="job-card__top">
          <span className="job-card__number">{job.job_number || "—"}</span>
          <DeadlineChip deadline_date={job.deadline_date} deadline_text={job.deadline_text} />
        </div>
        <h3 className="job-card__title">{job.title || "Untitled position"}</h3>
        <div className="job-card__employer">{job.employer || "Unknown employer"}</div>
        {meta.length > 0 && (
          <div className="job-card__meta">
            {meta.map((item, i) => (
              <span key={i} className="job-card__meta-item">
                {item}
              </span>
            ))}
          </div>
        )}
      </button>

      {expanded && <JobDetails jobId={job.id} onClose={() => onToggle(job.id)} />}
    </article>
  );
}
