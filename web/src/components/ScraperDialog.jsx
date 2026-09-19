import { useEffect, useRef, useState } from "react";
import Spinner from "./Spinner.jsx";
import SlideToConfirm from "./SlideToConfirm.jsx";
import useScrapeRate from "../hooks/useScrapeRate.js";
import { totalPercent, pagePercent, incompleteRun, runPageLabel } from "../scrapeProgress.js";
import "./ScraperDialog.css";

const STEPS = [
  { key: "starting", label: "Opening browser" },
  { key: "login", label: "Log in" },
  { key: "counting", label: "Counting pages" },
  { key: "scraping", label: "Scraping" },
  { key: "done", label: "Done" },
];

const RUNNING_STATES = new Set(["starting", "waiting_for_login", "scraping", "cancelling"]);

// Shown as the hover tooltip and read out as the button's description, so the
// two can't drift apart.
const STOP_TIP =
  "Closes the Chrome window and keeps the jobs saved so far. The scrape can't be resumed afterward.";

function fmt(n) {
  return (n ?? 0).toLocaleString();
}

/** The page count isn't in yet and no card has started: still counting. */
function isCounting(status) {
  return status?.state === "scraping" && status.total_pages == null && !status.current;
}

function stepIndex(status) {
  switch (status?.state) {
    case "starting":
      return 0;
    case "waiting_for_login":
      return 1;
    case "scraping":
      return isCounting(status) ? 2 : 3;
    default:
      return 4;
  }
}

function formatScrapedAt(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/** "4 min 12 s" between the two ISO stamps, or "" when either is missing. */
function formatDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return "";
  const seconds = Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** First sentence of the incomplete-run callout, per how the run ended. */
function incompleteHeadline(run) {
  const where = runPageLabel(run);
  switch (run.state) {
    case "failed":
      return `The last scrape failed on ${where}.`;
    case "interrupted":
      return `The last scrape was interrupted on ${where} (the app closed while it was running).`;
    default:
      return `The last scrape was aborted on ${where}.`;
  }
}

/** A small horizontal-line glyph, the usual "minimize to background" icon. */
function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="10.5" width="10" height="1.4" rx="0.7" fill="currentColor" />
    </svg>
  );
}

/** Titled, striped "Total" bar: pages completed / total_pages, indeterminate
    stripes while the page count isn't known yet. */
function TotalBar({ status, rate }) {
  const percent = totalPercent(status);
  const indeterminate = percent == null;
  return (
    <div className="scraper-dialog__total">
      <div className="scraper-dialog__total-head">
        <span className="scraper-dialog__total-title">Total</span>
        {!indeterminate && <span className="scraper-dialog__total-value">{Math.round(percent)}%</span>}
      </div>
      <div
        className="scraper-dialog__total-bar"
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Total pages scraped"
      >
        <span
          className={`scraper-dialog__total-fill ${indeterminate ? "scraper-dialog__total-fill--indeterminate" : ""} ${
            !indeterminate && percent >= 100 ? "scraper-dialog__total-fill--settle" : ""
          }`}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
      {rate.rateText && (
        <p className="scraper-dialog__rate">
          {rate.rateText}
          {rate.timeLeftText ? ` · ${rate.timeLeftText}` : ""}
        </p>
      )}
    </div>
  );
}

/** 52px "This page" donut, keyed on the page number so it starts empty on a
    new page. `pathLength="100"` makes the dash maths match the percent 1:1. */
function PageDonut({ status }) {
  const target = pagePercent(status);
  const [percent, setPercent] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPercent(target));
    return () => cancelAnimationFrame(id);
  }, [target]);
  const offset = 100 - Math.max(0, Math.min(100, percent));
  const label = status?.current ? `${status.current.index}/${status.current.total}` : "";
  return (
    <div className="scraper-dialog__donut" aria-hidden="true">
      <svg viewBox="0 0 52 52" width="52" height="52" className="scraper-dialog__donut-svg">
        <circle className="scraper-dialog__donut-track" cx="26" cy="26" r="22" pathLength="100" />
        <circle
          className={`scraper-dialog__donut-value ${percent >= 100 ? "scraper-dialog__donut-value--settle" : ""}`}
          cx="26"
          cy="26"
          r="22"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={offset}
        />
      </svg>
      <span className="scraper-dialog__donut-label">{label}</span>
    </div>
  );
}

export default function ScraperDialog({ open, onClose, scraper, onJobsChanged }) {
  const dialogRef = useRef(null);
  const keepScrapingRef = useRef(null);
  const lastStepRef = useRef(0);
  const { status, connection, start, cancel, deleteAll } = scraper;

  const [localError, setLocalError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  // The log follows the newest line only while the user is already at the
  // bottom, so scrolling up to read isn't yanked back.
  const logRef = useRef(null);
  const followLogRef = useRef(true);

  const rate = useScrapeRate(status);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      setConfirmingStop(false);
      onClose();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  // Escape closes the native <dialog> by firing "cancel" first. While the
  // stop-confirmation panel is open, Escape should dismiss *that* instead of
  // minimizing the whole dialog — never let it reach the "close" handler.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleCancel = (e) => {
      if (confirmingStop) {
        e.preventDefault();
        setConfirmingStop(false);
      }
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [confirmingStop]);

  useEffect(() => {
    if (confirmingStop) keepScrapingRef.current?.focus();
  }, [confirmingStop]);

  const state = status?.state || "idle";
  const running = RUNNING_STATES.has(state);
  const cancelling = state === "cancelling";
  const jobCount = status?.job_count ?? 0;
  const events = status?.events || [];
  // From the persisted `last_run`, so it shows after a restart too, when
  // there is no in-memory report.
  const incomplete = running ? null : incompleteRun(status);

  useEffect(() => {
    const el = logRef.current;
    if (el && followLogRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length, open]);

  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    followLogRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
  };

  // Clicking the backdrop reads the same as the header button: minimize
  // while running, plain close otherwise. Never reaches the scraper's
  // cancel endpoint.
  const handleBackdropClick = (e) => {
    if (e.target === dialogRef.current) dialogRef.current.close();
  };

  const handleStart = async () => {
    setLocalError(null);
    try {
      await start();
    } catch (err) {
      setLocalError(err.message);
    }
  };

  const handleStopConfirm = async () => {
    setStopping(true);
    setLocalError(null);
    try {
      await cancel();
      setConfirmingStop(false);
    } catch (err) {
      setLocalError(err.message);
      throw err; // lets SlideToConfirm spring back
    } finally {
      setStopping(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    setLocalError(null);
    try {
      await deleteAll();
      onJobsChanged?.();
    } catch (err) {
      setLocalError(err.message);
      throw err; // lets SlideToConfirm spring back
    } finally {
      setDeleting(false);
    }
  };

  // "cancelling" has no step of its own: hold the step the scrape had reached
  // so the list doesn't jump to "Done" while the Chrome window closes.
  if (!cancelling) lastStepRef.current = stepIndex(status);
  const currentStep = lastStepRef.current;
  // While aborting the block stays up only if it was already up: step 2 and
  // later are the "scraping" states. Aborting during login has nothing to show.
  const showProgress = state === "scraping" || (cancelling && currentStep >= 2);
  const failedJobs = status?.failed_jobs || [];
  // A run happened in this session, so there is something to report on.
  const hasReport = Boolean(status?.finished_at);

  const logLines = (
    <>
      {events.map((event, i) => (
        <div key={i} className={`scraper-dialog__log-line scraper-dialog__log-line--${event.level}`}>
          <span className="scraper-dialog__log-time">{formatClock(event.time)}</span>
          {event.message}
        </div>
      ))}
    </>
  );

  return (
    <dialog ref={dialogRef} className="scraper-dialog" aria-label="Scraper" onClick={handleBackdropClick}>
      <div className="scraper-dialog__header">
        <h2>Scraper</h2>
        <button
          type="button"
          className="scraper-dialog__close"
          onClick={() => dialogRef.current?.close()}
          aria-label={running ? "Minimize" : "Close"}
          title={running ? "Minimize — the scrape keeps running in the background" : "Close"}
        >
          {running ? <MinimizeIcon /> : "×"}
        </button>
      </div>

      <div className="scraper-dialog__body">
        {!status && <p className="scraper-dialog__muted">Loading status…</p>}

        {status && connection === "reconnecting" && (
          <p className="scraper-dialog__muted">Reconnecting to the server…</p>
        )}

        {status && !running && (
          <>
            {incomplete && (
              <div className="scraper-dialog__callout" role="note">
                <span className="scraper-dialog__callout-icon" aria-hidden="true">
                  ⚠
                </span>
                <span>
                  <strong>{incompleteHeadline(incomplete)}</strong> The {fmt(jobCount)} jobs saved
                  may not be the full list. Delete all jobs and run a new scrape to get everything.
                </span>
              </div>
            )}

            {jobCount > 0 && (
              <div className="scraper-dialog__summary">
                <p>
                  <strong>{fmt(jobCount)}</strong> job{jobCount === 1 ? "" : "s"} scraped
                  {status.last_scraped_at ? ` ${formatScrapedAt(status.last_scraped_at)}` : ""}.
                </p>
                <SlideToConfirm
                  label="Slide to delete all jobs"
                  busyLabel="Deleting…"
                  busy={deleting}
                  onConfirm={handleDeleteConfirm}
                />
              </div>
            )}

            {/* Report on the run that just ended. */}
            {hasReport && (
              <div className="scraper-dialog__report">
                {state === "completed" && (
                  <p className="scraper-dialog__success">
                    Scrape complete — {fmt(status.jobs_saved)} jobs saved.
                  </p>
                )}
                {/* Nothing for "cancelled": the amber callout above already
                    says where the run stopped and what to do about it. */}
                {state === "failed" && (
                  <p className="scraper-dialog__error">{status.error || "The scrape failed."}</p>
                )}

                <dl className="scraper-dialog__report-stats">
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(status.started_at, status.finished_at) || "—"}</dd>
                  </div>
                  <div>
                    <dt>Pages</dt>
                    <dd>
                      {fmt(status.pages_completed)}
                      {status.total_pages ? ` of ${fmt(status.total_pages)}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Saved</dt>
                    <dd>{fmt(status.jobs_saved)}</dd>
                  </div>
                  <div>
                    <dt>Retries</dt>
                    <dd>{fmt(status.retries)}</dd>
                  </div>
                  <div>
                    <dt>Skipped</dt>
                    <dd className={status.anomalies > 0 ? "scraper-dialog__bad" : ""}>
                      {fmt(status.anomalies)}
                    </dd>
                  </div>
                  <div>
                    <dt>Speed</dt>
                    <dd>{rate.averageText || "—"}</dd>
                  </div>
                </dl>

                {failedJobs.length > 0 ? (
                  <ul className="scraper-dialog__failed-list">
                    {failedJobs.map((job, i) => (
                      <li key={i}>
                        <span className="scraper-dialog__failed-page">page {job.page}</span>
                        {job.title || "Untitled"} · {job.employer || "Unknown employer"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="scraper-dialog__success">All jobs scraped, 0 skipped.</p>
                )}

                {events.length > 0 && (
                  <details className="scraper-dialog__log-details">
                    <summary>Full log ({events.length} lines)</summary>
                    <div className="scraper-dialog__log">{logLines}</div>
                  </details>
                )}
              </div>
            )}

            <button
              type="button"
              className="scraper-dialog__primary"
              onClick={handleStart}
              disabled={jobCount > 0}
              aria-describedby={jobCount > 0 ? "scraper-start-hint" : undefined}
            >
              Start scrape
            </button>
            {jobCount > 0 ? (
              <div className="scraper-dialog__callout" role="note" id="scraper-start-hint">
                <span className="scraper-dialog__callout-icon" aria-hidden="true">
                  ⚠
                </span>
                <span>
                  <strong>Can't start a new scrape yet.</strong> There are already {fmt(jobCount)} jobs
                  in the database and a scrape needs an empty one. Delete all jobs first (slider above),
                  then start again.
                </span>
              </div>
            ) : (
              <p className="scraper-dialog__muted">
                A Chrome window will open. Log in, then leave it alone until the scrape finishes.
              </p>
            )}

            {state === "completed" && (
              <button
                type="button"
                className="scraper-dialog__secondary"
                onClick={() => dialogRef.current?.close()}
              >
                View jobs
              </button>
            )}

            {localError && <p className="scraper-dialog__error">{localError}</p>}
          </>
        )}

        {status && running && (
          <>
            {(state === "starting" || state === "waiting_for_login") && (
              <div className="scraper-dialog__callout scraper-dialog__callout--info" role="note">
                <span className="scraper-dialog__callout-icon" aria-hidden="true">
                  ℹ
                </span>
                <span>
                  <strong>A Chrome window is opening.</strong> Log in there, then leave it alone until
                  the scrape finishes.
                </span>
              </div>
            )}
            {state === "scraping" && (
              <div className="scraper-dialog__callout" role="note">
                <span className="scraper-dialog__callout-icon" aria-hidden="true">
                  ⚠
                </span>
                <span>
                  <strong>Don't touch the scraper's Chrome window.</strong> Clicking, scrolling or
                  resizing it can mix up job data. You can keep using this page, or minimize the
                  Chrome window.
                </span>
              </div>
            )}

            <ol className="scraper-dialog__steps">
              {STEPS.map((step, i) => {
                const stepState = i < currentStep ? "done" : i === currentStep ? "active" : "pending";
                return (
                  <li key={step.key} className={`scraper-dialog__step scraper-dialog__step--${stepState}`}>
                    <span className="scraper-dialog__step-index">
                      {stepState === "active" ? <Spinner size={12} /> : i + 1}
                    </span>
                    <span className="scraper-dialog__step-label">
                      {step.label}
                      {step.key === "login" && stepState === "active" && (
                        <span className="scraper-dialog__step-hint">
                          {" "}
                          Log in to the portal in the Chrome window. Once you're in, don't click or
                          scroll in it. Scraping starts automatically.
                        </span>
                      )}
                      {step.key === "counting" && stepState !== "pending" && (
                        <span className="scraper-dialog__step-hint">
                          {" "}
                          {status.total_pages
                            ? `Found ${fmt(status.total_pages)} pages${
                                status.estimated_jobs ? ` (about ${fmt(status.estimated_jobs)} jobs)` : ""
                              }`
                            : stepState === "done"
                              ? "Couldn't read the page count; scraping anyway"
                              : "Reading the portal's page list…"}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>

            {/* Kept up while aborting too, so the dialog doesn't collapse to a
                smaller layout in the seconds before the worker unwinds. */}
            {showProgress && (
              <div className="scraper-dialog__progress">
                <div className="scraper-dialog__progress-line">
                  <PageDonut key={status.current?.page ?? "pending"} status={status} />
                  <span className="scraper-dialog__progress-text">
                    Page {status.current?.page ?? (status.pages_completed ?? 0) + 1}
                    {status.total_pages ? ` of ${fmt(status.total_pages)}` : ""}
                    {status.current
                      ? ` · job ${status.current.index} of ${status.current.total}`
                      : ""}
                    {status.current?.title ? ` · ${status.current.title}` : ""}
                  </span>
                </div>
                <TotalBar status={status} rate={rate} />
                <p className="scraper-dialog__muted">
                  {status.estimated_jobs
                    ? `${fmt(status.jobs_saved)} of ~${fmt(status.estimated_jobs)} jobs saved`
                    : `${fmt(status.jobs_saved)} jobs saved`}
                </p>
              </div>
            )}

            <div className="scraper-dialog__counters">
              <span>
                <strong>{fmt(status.jobs_saved)}</strong> saved
              </span>
              <span>
                <strong>{fmt(status.retries)}</strong> retries
              </span>
              <span className={status.failed > 0 ? "scraper-dialog__bad" : ""}>
                <strong>{fmt(status.failed)}</strong> skipped
              </span>
              {status.duplicates > 0 && (
                <span>
                  <strong>{fmt(status.duplicates)}</strong> duplicates
                </span>
              )}
            </div>

            <div className="scraper-dialog__log" ref={logRef} onScroll={handleLogScroll}>
              {events.length === 0 ? (
                <div className="scraper-dialog__log-line">Waiting for the first event…</div>
              ) : (
                logLines
              )}
            </div>

            {cancelling ? (
              <p className="scraper-dialog__aborting">
                <Spinner size={14} tone="warn" />
                Aborting… closing the Chrome window
              </p>
            ) : !confirmingStop ? (
              <>
                <div className="scraper-dialog__actions">
                  <button
                    type="button"
                    className="scraper-dialog__primary"
                    onClick={() => dialogRef.current?.close()}
                  >
                    Run in background
                  </button>
                  <button
                    type="button"
                    className="scraper-dialog__danger"
                    onClick={() => setConfirmingStop(true)}
                    aria-describedby="scraper-stop-tip"
                    data-tooltip={STOP_TIP}
                    data-tooltip-placement="top-start"
                  >
                    Abort scrape
                  </button>
                  {/* The bubble itself is the shared top-layer tooltip, which
                      no screen reader sees; this is its spoken twin. */}
                  <span id="scraper-stop-tip" className="scraper-dialog__tip-text">
                    {STOP_TIP}
                  </span>
                </div>
                <p className="scraper-dialog__muted">
                  Minimizing doesn't stop the scrape. Only Abort scrape does.
                </p>
              </>
            ) : (
              <div className="scraper-dialog__stop-confirm">
                <p className="scraper-dialog__stop-confirm-text">
                  <strong>Abort this scrape?</strong> The Chrome window closes and the{" "}
                  {fmt(status.jobs_saved)} jobs saved so far are kept, but a scrape can't be resumed.
                  To get the rest you'll have to delete all jobs and start again from page 1.
                </p>
                <div className="scraper-dialog__stop-confirm-actions">
                  <button
                    type="button"
                    ref={keepScrapingRef}
                    className="scraper-dialog__secondary"
                    onClick={() => setConfirmingStop(false)}
                  >
                    Keep scraping
                  </button>
                  <SlideToConfirm
                    label="Slide to abort the scrape"
                    busyLabel="Aborting…"
                    busy={stopping}
                    onConfirm={handleStopConfirm}
                  />
                </div>
              </div>
            )}

            {localError && <p className="scraper-dialog__error">{localError}</p>}
          </>
        )}
      </div>
    </dialog>
  );
}
