import Spinner from "./Spinner.jsx";
import { ThumbUpIcon, ThumbDownIcon } from "./RatingButtons.jsx";
import { incompleteRun, runPageLabel } from "../scrapeProgress.js";
import { relativeTime } from "../relativeTime.js";
import "./TopBar.css";

/** "39 of 50" only when the last run stopped short, else null (complete runs don't show Pages). */
function pagesLabel(lastRun) {
  if (!lastRun || !lastRun.pages_completed) return null;
  // Show only when incomplete: pages_completed < total_pages. Hides the Pages
  // stat after a clean scrape, since "50 of 50" carries no information.
  if (lastRun.total_pages && lastRun.pages_completed < lastRun.total_pages) {
    return `${lastRun.pages_completed} of ${lastRun.total_pages}`;
  }
  return null;
}

/** "page 3 of 39", dropping "of M" when the portal's pager wasn't readable. */
function pageLabel(status) {
  const page = status?.current?.page ?? (status?.pages_completed ?? 0) + 1;
  return status?.total_pages ? `page ${page} of ${status.total_pages}` : `page ${page}`;
}

function liveLine(status) {
  const state = status?.state;
  if (state === "scraping") {
    const saved = (status.jobs_saved ?? 0).toLocaleString();
    return `Scraping live · ${saved} jobs so far · ${pageLabel(status)}`;
  }
  if (state === "waiting_for_login") return "Waiting for you to log in to the portal in the browser window…";
  if (state === "cancelling") return "Aborting the scrape…";
  return "Starting the scraper…";
}

/** How a run that ended early is named in the warning line. */
const INCOMPLETE_WORD = {
  cancelled: "aborted",
  failed: "failed",
  interrupted: "interrupted",
};

/** Plain phrase for a run's abort reason; omitted (undefined) for "failed",
 * since the error message elsewhere already says what happened. */
const REASON_TEXT = {
  browser_closed: "browser window was closed",
  user_cancelled: "you stopped it",
};

/** "⚠ Incomplete: scrape aborted on page 3 of 39, browser window was closed". */
function incompleteLine(run) {
  const base = `⚠ Incomplete: scrape ${INCOMPLETE_WORD[run.state]} on ${runPageLabel(run)}`;
  const reasonText = REASON_TEXT[run.reason];
  return reasonText ? `${base}, ${reasonText}` : base;
}

/**
 * The one sticky bar above the grid: count and the live-scrape line on the
 * left, a row of triage/freshness stats and Collapse all pinned right.
 * Always rendered (replaces JobGrid's old toolbar), so everything lines up
 * in one row instead of several separately-positioned pieces. Export/
 * database actions moved to the Data dialog's Database tab
 * (DatabasePanel.jsx); Favorites moved out of the top bar entirely.
 */
export default function TopBar({
  shown,
  total,
  stats,
  scraperRunning,
  scraperStatus,
  onOpenScraper,
  expandedCount,
  onCollapseAll,
}) {
  // Same slot as the live line, so only one of the two is ever in the row.
  const incomplete = scraperRunning ? null : incompleteRun(scraperStatus);
  // Only one of these three ever fills the flexible middle slot; when neither
  // line is showing, a plain spacer keeps the stats/Collapse all right-aligned.
  const hasLiveLine = scraperRunning || Boolean(incomplete);

  const liked = stats?.liked ?? 0;
  const disliked = stats?.disliked ?? 0;
  const triagedPercent = total > 0 ? Math.round(((liked + disliked) / total) * 100) : 0;
  const updated = relativeTime(scraperStatus?.last_scraped_at);
  const pages = pagesLabel(scraperStatus?.last_run);

  return (
    <div className="top-bar">
      {total > 0 && (
        <p className="top-bar__count" title="Jobs matching your filters, out of every job saved">
          <strong>{shown}</strong> job{shown === 1 ? "" : "s"} of {total}
        </p>
      )}

      {pages && (
        <span className="top-bar__stat top-bar__stat--warn" title="Pages the last scrape finished, out of the pages it found">
          <span className="top-bar__stat-label">Pages</span>
          <span className="top-bar__stat-value top-bar__stat-value--pages">{pages}</span>
        </span>
      )}

      {scraperRunning && (
        <button
          type="button"
          className="top-bar__live"
          onClick={onOpenScraper}
          title="Open the scraper window"
        >
          <Spinner size={12} tone={scraperStatus?.state === "cancelling" ? "warn" : "accent"} />
          <span>{liveLine(scraperStatus)}</span>
        </button>
      )}

      {incomplete && (
        <button
          type="button"
          className="top-bar__live top-bar__live--warn"
          onClick={onOpenScraper}
          title="Open the scraper window"
        >
          <span>{incompleteLine(incomplete)}</span>
        </button>
      )}

      {!hasLiveLine && <div className="top-bar__spacer" />}

      {/* Kept in the row (hidden, not unmounted) so it holds a fixed slot to the
          left of the stats: neither the stats nor the button move when it appears. */}
      <button
        type="button"
        className={`top-bar__button ${expandedCount > 1 ? "" : "top-bar__button--hidden"}`}
        onClick={onCollapseAll}
        aria-hidden={expandedCount <= 1}
        tabIndex={expandedCount > 1 ? 0 : -1}
        title="Collapse every open posting"
      >
        Collapse all ({expandedCount})
      </button>

      {/* Reserved-width cells so numbers in the right-hand stats never shift
          as data changes; see the min-width/tabular-nums rules in TopBar.css. */}
      {total > 0 && (
        <div className="top-bar__stats">
          <span className="top-bar__stat" title="Liked jobs">
            <ThumbUpIcon className="top-bar__stat-icon top-bar__stat-icon--liked" />
            <span className="top-bar__stat-value top-bar__stat-value--count">{liked}</span>
          </span>
          <span className="top-bar__stat" title="Disliked jobs">
            <ThumbDownIcon className="top-bar__stat-icon top-bar__stat-icon--disliked" />
            <span className="top-bar__stat-value top-bar__stat-value--count">{disliked}</span>
          </span>
          <span className="top-bar__stat" title="Share of jobs you have liked or disliked">
            <span className="top-bar__stat-label">Triaged</span>
            <span className="top-bar__stat-value top-bar__stat-value--percent">{triagedPercent}%</span>
          </span>
          {updated && (
            <span className="top-bar__stat" title="When you last scraped">
              <span className="top-bar__stat-label">Last updated</span>
              <span className="top-bar__stat-value top-bar__stat-value--time">{updated}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
