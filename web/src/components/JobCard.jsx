import "./JobCard.css";

function JobCard({ job }) {
  const details = [job.employer, job.location, job.work_model].filter(Boolean);
  const deadline = job.deadline || "No deadline listed";

  return (
    <article className="job-card">
      <div className="job-card__main">
        <p className="job-card__eyebrow">{job.job_number || "Job opportunity"}</p>
        <h2>{job.title || job.displayed_job_title || "Untitled position"}</h2>
        {details.length > 0 && <p className="job-card__details">{details.join(" · ")}</p>}
      </div>
      <div className="job-card__meta">
        <span className="job-card__label">Deadline</span>
        <span>{deadline}</span>
      </div>
    </article>
  );
}

export default JobCard;
