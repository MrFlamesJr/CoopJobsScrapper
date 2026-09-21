import DeadlineChip from "./DeadlineChip.jsx";
import RatingButtons from "./RatingButtons.jsx";
import JobDetails from "./JobDetails.jsx";
import JobNumber from "./JobNumber.jsx";
import { Highlight } from "../highlight.jsx";
import "./JobPanel.css";

/**
 * The details panel of an expanded `JobCard`. `JobGrid` places it after the
 * cards of its card's row and it spans the whole row, so it lands directly
 * under that row. The panel simply appears in place with no animation.
 */
export default function JobPanel({ job, rating, onRate, onClose }) {
  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  // Built entirely from the list job already on hand — no fetch. `JobDetails`
  // wraps this in `.job-details__header-main`, which supplies the layout. The
  // title is repeated here: a panel can be a full row away from its card, and
  // several can be open at once.
  const header = (
    <>
      <JobNumber value={job.job_number} as="button" />
      <span className="job-panel__title">
        <Highlight text={job.title || "Untitled position"} />
      </span>
      <span className="job-panel__employer">
        <Highlight text={job.employer || "Unknown employer"} />
      </span>
      <DeadlineChip deadline_date={job.deadline_date} deadline_text={job.deadline_text} />
      <RatingButtons jobNumber={job.job_number} rating={rating} onRate={onRate} />
    </>
  );

  return (
    <section className="job-panel" data-job-id={job.id} onKeyDown={handleKeyDown}>
      <div className="job-panel__inner">
        <JobDetails jobId={job.id} onClose={onClose} header={header} />
      </div>
    </section>
  );
}
