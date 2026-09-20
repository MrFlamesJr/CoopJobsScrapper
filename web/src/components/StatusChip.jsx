import Spinner from "./Spinner.jsx";
import { relativeTime } from "../relativeTime.js";
import { totalPercent, pagePercent, incompleteRun } from "../scrapeProgress.js";
import "./StatusChip.css";

// The most important message while a scrape runs, kept visible even with the
// dialog closed.
const HANDS_OFF = "Don't click in the browser window";

/** Headline per way a run ended early. */
const INCOMPLETE_MAIN = {
  cancelled: "Scrape aborted",
  failed: "Scrape failed",
  interrupted: "Scrape interrupted",
};

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** "Scraping page 3 of 39", or without "of M" when the pager wasn't readable. */
function scrapingLine(status) {
  const page = status?.current?.page ?? (status?.pages_completed ?? 0) + 1;
  const total = status?.total_pages;
  return total ? `Scraping page ${page} of ${total}` : `Scraping page ${page}`;
}

/** Everything the chip renders, per state. */
function describe(status) {
  const state = status?.state || "idle";
  const jobCount = status?.job_count ?? 0;

  switch (state) {
    case "starting":
      return { tone: "running", spinner: "accent", main: "Opening browser…", sub: "" };
    case "waiting_for_login":
      return {
        tone: "running",
        spinner: "warn",
        main: "Waiting for you to log in",
        sub: "In the browser window",
      };
    case "scraping":
      return {
        tone: "running",
        spinner: "accent",
        main: scrapingLine(status),
        sub: HANDS_OFF,
        warn: true,
      };
    case "cancelling":
      return {
        tone: "running",
        spinner: "warn",
        main: "Aborting scrape…",
        sub: "Closing the browser window",
      };
    default:
      break;
  }

  // Before the lines below, so a half-finished job list still warns once the
  // state is back to "idle" — after a restart there is nothing else left.
  const incomplete = incompleteRun(status);
  if (incomplete) {
    return {
      tone: "warn",
      main: INCOMPLETE_MAIN[incomplete.state],
      sub: `${plural(jobCount, "job")} · may be incomplete`,
      warn: true,
    };
  }

  // Only reached with no jobs saved: the run left nothing to warn about.
  if (state === "cancelled") {
    return { tone: "idle", main: "Last run cancelled", sub: plural(jobCount, "job") + " saved" };
  }
  if (state === "failed") {
    return { tone: "error", main: "Last run failed", sub: "Click for details" };
  }
  // idle or completed
  if (jobCount === 0) {
    return { tone: "idle", main: "No jobs yet", sub: "Click to run the scraper" };
  }
  const last = relativeTime(status?.last_scraped_at);
  return {
    tone: "success",
    main: `${plural(jobCount, "job")} saved`,
    sub: last ? `Updated ${last}` : "Never scraped",
  };
}

export default function StatusChip({ status, onClick }) {
  const state = status?.state || "idle";
  const view = describe(status);
  // Same maths as the dialog's Total bar; while the page count isn't known
  // yet, fall back to progress through the current page (and colour it like
  // the dialog's This-page donut instead of the Total bar's blue).
  // Stays up while aborting, so the chip doesn't shrink before the run ends —
  // but only if there is real progress behind it, or an abort during login
  // would pop an empty bar into the sidebar.
  const cancelling = state === "cancelling";
  const total = state === "scraping" || cancelling ? totalPercent(status) : null;
  const showBar =
    state === "scraping" || (cancelling && (total != null || Boolean(status?.current)));
  const usingPageFallback = showBar && total == null;
  const percent = showBar ? (total ?? pagePercent(status)) : null;

  return (
    <div className="status-chip-block">
      <span className="status-chip__section">Scraper</span>

      <button type="button" className="status-chip" onClick={onClick} aria-haspopup="dialog">
        {view.spinner ? (
          <Spinner tone={view.spinner} size={12} />
        ) : (
          <span
            className={`status-chip__dot status-chip__dot--${view.tone}`}
            aria-hidden="true"
          />
        )}
        <span className="status-chip__text">
          <span className="status-chip__line">{view.main}</span>
          {view.sub && (
            <span className={`status-chip__sub ${view.warn ? "status-chip__sub--warn" : ""}`}>
              {view.warn ? "⚠ " : ""}
              {view.sub}
            </span>
          )}
        </span>
      </button>

      {percent !== null && (
        <div
          className="status-chip__progress"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Scrape progress"
        >
          <span
            className={`status-chip__progress-bar ${usingPageFallback ? "status-chip__progress-bar--page" : ""}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
