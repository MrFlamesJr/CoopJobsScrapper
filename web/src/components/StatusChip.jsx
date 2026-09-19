import { relativeTime } from "../relativeTime.js";
import "./StatusChip.css";

const STATE_LABELS = {
  idle: "Idle",
  starting: "Starting",
  waiting_for_login: "Waiting for login",
  scraping: "Scraping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUNNING = new Set(["starting", "waiting_for_login", "scraping"]);

function toneFor(state) {
  if (RUNNING.has(state)) return "running";
  if (state === "completed") return "success";
  if (state === "failed") return "error";
  return "idle";
}

export default function StatusChip({ status, onClick }) {
  const state = status?.state || "idle";
  const tone = toneFor(state);
  const label = STATE_LABELS[state] || state;
  const jobCount = status?.job_count ?? 0;
  const last = relativeTime(status?.last_scraped_at);

  return (
    <button
      type="button"
      className="status-chip"
      onClick={onClick}
      aria-haspopup="dialog"
    >
      <span className={`status-chip__dot status-chip__dot--${tone}`} aria-hidden="true" />
      <span className="status-chip__text">
        <span className="status-chip__line">
          {label} · {jobCount} job{jobCount === 1 ? "" : "s"}
        </span>
        <span className="status-chip__sub">
          {last ? `Last scraped ${last}` : "Never scraped"}
        </span>
      </span>
    </button>
  );
}
