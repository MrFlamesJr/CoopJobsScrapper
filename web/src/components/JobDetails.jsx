import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchJob } from "../api.js";
import { Highlight } from "../highlight.jsx";
import "./JobDetails.css";

// Simple in-memory cache so re-expanding a card doesn't refetch.
const jobDetailCache = new Map();

// Exported so a card can prefetch its details before the expand animation
// starts: the new state then already has its content, and the morph doesn't
// jump when "Loading…" is replaced.
export function loadJobDetail(jobId) {
  if (jobDetailCache.has(jobId)) return Promise.resolve(jobDetailCache.get(jobId));
  return fetchJob(jobId).then((data) => {
    jobDetailCache.set(jobId, data);
    return data;
  });
}

/**
 * Drop everything cached. SQLite reuses row ids after the jobs table is
 * cleared, so a cached detail would otherwise be shown under a different job's
 * title once new rows take the old ids.
 */
export function clearJobDetailCache() {
  jobDetailCache.clear();
}

function paragraphs(text) {
  return (text || "")
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// The portal flattens lists into one run of text ("criteria: • Be … • Reside
// …"), so a paragraph with bullet characters is split back into its lead-in
// and the items.
function bulletItems(paragraph) {
  const [lead, ...items] = paragraph.split(/\s*[•●▪]\s*/);
  return { lead: lead.trim(), items: items.map((item) => item.trim()).filter(Boolean) };
}

function DescriptionParagraph({ text }) {
  const { lead, items } = bulletItems(text);
  if (items.length === 0) return <p><Highlight text={text} /></p>;
  return (
    <>
      {lead && <p><Highlight text={lead} /></p>}
      <ul>
        {items.map((item, i) => (
          <li key={i}><Highlight text={item} /></li>
        ))}
      </ul>
    </>
  );
}

export default function JobDetails({ jobId, onClose, header }) {
  const [job, setJob] = useState(() => jobDetailCache.get(jobId) || null);
  const [error, setError] = useState(null);
  const closeButtonRef = useRef(null);
  const rootRef = useRef(null);
  const headerRef = useRef(null);

  useEffect(() => {
    if (jobDetailCache.has(jobId)) {
      setJob(jobDetailCache.get(jobId));
      return;
    }
    let cancelled = false;
    setError(null);
    loadJobDetail(jobId)
      .then((data) => {
        if (!cancelled) setJob(data);
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

  // With header content the panel pins this row (see JobPanel.css), so the
  // rail below has to stick under it. The row wraps on a narrow panel, so its
  // height is measured; it's published on this element rather than `:root`
  // because several panels can be open at once.
  const hasHeader = Boolean(header);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const el = headerRef.current;
    if (!hasHeader || !root || !el) return undefined;
    const update = () => root.style.setProperty("--details-header-h", `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--details-header-h");
    };
  }, [hasHeader]);

  const stopToggle = (e) => e.stopPropagation();

  return (
    <div className="job-details" onClick={stopToggle} ref={rootRef}>
      {/* Built by the caller from the list job (no fetch), so it's there even
          while the detail below is still loading. */}
      {header && (
        <div className="job-details__header" ref={headerRef}>
          <div className="job-details__header-main">{header}</div>
        </div>
      )}
      {/* Its own row under the header's rule, right-aligned under the heart.
          In flow, so however the header above wraps the button can never end
          up on top of it. */}
      <div className={`job-details__close-row ${header ? "" : "job-details__close-row--bare"}`}>
        <button
          type="button"
          className="job-details__close"
          onClick={() => onClose()}
          aria-label="Close job details"
          ref={closeButtonRef}
        >
          Close ×
        </button>
      </div>

      {error && <p className="job-details__error">Couldn't load this job: {error.message}</p>}

      {!error && !job && <p className="job-details__loading">Loading…</p>}

      {job && (
        <div className="job-details__grid">
          <aside className="job-details__rail">
            <dl className="job-details__facts">
              <div>
                <dt>Term</dt>
                <dd><Highlight text={job.term || "—"} /></dd>
              </div>
              <div>
                <dt>Round</dt>
                <dd><Highlight text={job.round || "—"} /></dd>
              </div>
              <div>
                <dt>Salary</dt>
                <dd><Highlight text={job.salary || "—"} /></dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd><Highlight text={job.deadline_text || "—"} /></dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd><Highlight text={job.location || "—"} /></dd>
              </div>
            </dl>

            {job.requirements?.length > 0 && (
              <section className="job-details__section">
                <h4>Requirements</h4>
                <ul>
                  {job.requirements.map((r, i) => (
                    <li key={i}><Highlight text={r} /></li>
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
                      <dt><Highlight text={q.name} /></dt>
                      <dd><Highlight text={q.value} /></dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </aside>

          {job.description && (
            <section className="job-details__section job-details__description">
              <h4>Description</h4>
              {paragraphs(job.description).map((p, i) => (
                <DescriptionParagraph key={i} text={p} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
