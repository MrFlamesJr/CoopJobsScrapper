import { useEffect, useRef, useState } from "react";
import { fetchJob } from "../api.js";
import "./JobDetails.css";

// Simple in-memory cache so re-expanding a card doesn't refetch.
const jobDetailCache = new Map();

function paragraphs(text) {
  return (text || "")
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export default function JobDetails({ jobId, onClose }) {
  const [job, setJob] = useState(() => jobDetailCache.get(jobId) || null);
  const [error, setError] = useState(null);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (jobDetailCache.has(jobId)) {
      setJob(jobDetailCache.get(jobId));
      return;
    }
    let cancelled = false;
    setError(null);
    fetchJob(jobId)
      .then((data) => {
        if (cancelled) return;
        jobDetailCache.set(jobId, data);
        setJob(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const stopToggle = (e) => e.stopPropagation();

  return (
    <div className="job-details" onClick={stopToggle}>
      <button
        type="button"
        className="job-details__close"
        onClick={() => onClose()}
        aria-label="Close job details"
        ref={closeButtonRef}
      >
        Close ×
      </button>

      {error && <p className="job-details__error">Couldn't load this job: {error.message}</p>}

      {!error && !job && <p className="job-details__loading">Loading…</p>}

      {job && (
        <div className="job-details__grid">
          <dl className="job-details__facts">
            <div>
              <dt>Term</dt>
              <dd>{job.term || "—"}</dd>
            </div>
            <div>
              <dt>Round</dt>
              <dd>{job.round || "—"}</dd>
            </div>
            <div>
              <dt>Salary</dt>
              <dd>{job.salary || "—"}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{job.deadline_text || "—"}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{job.location || "—"}</dd>
            </div>
          </dl>

          {job.description && (
            <section className="job-details__section">
              <h4>Description</h4>
              {paragraphs(job.description).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </section>
          )}

          {job.requirements?.length > 0 && (
            <section className="job-details__section">
              <h4>Requirements</h4>
              <ul>
                {job.requirements.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>
          )}

          {job.qualifications?.length > 0 && (
            <section className="job-details__section">
              <h4>Qualifications</h4>
              <dl className="job-details__qualifications">
                {job.qualifications.map((q, i) => (
                  <div key={i}>
                    <dt>{q.name}</dt>
                    <dd>{q.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
