import { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "./Spinner.jsx";
import SlideToConfirm from "./SlideToConfirm.jsx";
import DatabasePanel from "./DatabasePanel.jsx";
import InfoDot from "./InfoDot.jsx";
import useScrapeRate from "../hooks/useScrapeRate.js";
import { totalPercent, pagePercent, incompleteRun, runPageLabel } from "../scrapeProgress.js";
import { downloadDebugBundle, openExtensionsPage } from "../api.js";
import { EDGE_STORE_URL, EXTENSION_ZIP_URL, detectBrowser } from "../extensionInfo.js";
import "./ScraperDialog.css";

// The dialog's two tabs, in order -- also the roving-tabindex/arrow-key
// sequence (see handleTabKeyDown).
const TABS = [
  { key: "scraper", label: "Scraper" },
  { key: "database", label: "Database" },
];

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
  "Closes the browser window and keeps the jobs saved so far. The scrape can't be resumed afterward.";

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

/** Format tooltip text for skipped/failed jobs: list up to 10 items, then "and N more". */
function formatCountTooltip(items, formatter) {
  if (!items || items.length === 0) return "";
  const shown = items.slice(0, 10);
  const lines = shown.map(formatter);
  if (items.length > 10) {
    lines.push(`and ${items.length - 10} more`);
  }
  return lines.join("\n");
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

const DEVELOPER_MODE_TIP =
  "Chrome and Edge only allow extensions from their stores. Developer mode is the switch that also lets you load one from a folder. " +
  "Nothing else about your browsing changes, and you can switch it back off once it's installed. Chrome may nag you about it at startup. " +
  "Like any extension, it can read the pages it's allowed to. Here that's the co-op portal and this site, nothing else. The zip holds all of its code, and you can remove it any time.";

/** "chrome://extensions" (or "edge://extensions"): a browser-internal URL
    can't be turned into a working link from a web page, so it's shown as
    copyable text instead. */
function CopyableCode({ text }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      },
      () => {
        // Clipboard permission denied/unavailable: nothing else to do.
      },
    );
  };
  return (
    <button type="button" className="scraper-dialog__copy-code" onClick={copy}>
      <code>{text}</code>
      <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** The 4 manual "Load unpacked" steps, shared by the missing/outdated panels
    and by both browsers -- only the internal extensions-page URL differs. */
function InstallSteps({ browser, canOpen }) {
  const extensionsUrl = browser === "edge" ? "edge://extensions" : "chrome://extensions";
  return (
    <ol className="scraper-dialog__install-steps">
      <li>Unzip the downloaded file.</li>
      <li>
        Open{" "}
        {canOpen ? (
          <button
            type="button"
            className="scraper-dialog__copy-code"
            onClick={() => openExtensionsPage(extensionsUrl)}
          >
            <code>{extensionsUrl}</code>
            <span aria-hidden="true">Open in a new tab</span>
          </button>
        ) : (
          <CopyableCode text={extensionsUrl} />
        )}
      </li>
      <li>
        Turn on <strong>Developer mode</strong> (top right){" "}
        <InfoDot
          tip={DEVELOPER_MODE_TIP}
          label="Why Developer mode is needed"
          long
          placement="top-start"
          className="scraper-dialog__info-dot"
        />
      </li>
      <li>
        Click <strong>Load unpacked</strong> and select the unzipped folder.
      </li>
    </ol>
  );
}

/** "Step 1 – Install the CoopJobs extension" (extension === "missing") or
    "Update the extension" (extension === "outdated"), shown before the Start
    button. Browsing an imported database never needs any of this -- only
    starting a scrape does. */
function ExtensionGate({ variant, browser }) {
  const blocked = variant === "missing" && browser === "other";
  return (
    <div className="scraper-dialog__install">
      <h3 className="scraper-dialog__install-title">
        {variant === "outdated" ? "Update the extension" : "Step 1 – Install the CoopJobs extension"}
      </h3>
      {variant === "outdated" && (
        <div className="scraper-dialog__callout" role="note">
          <span className="scraper-dialog__callout-icon" aria-hidden="true">
            ⚠
          </span>
          <span><strong>Your extension is out of date.</strong> Download the new version below and install it again to keep scraping.</span>
        </div>
      )}
      {browser === "other" && (
        <div className="scraper-dialog__callout" role="note">
          <span className="scraper-dialog__callout-icon" aria-hidden="true">
            ⚠
          </span>
          <span>The scraper only works in Google Chrome and Microsoft Edge on a computer.</span>
        </div>
      )}

      {blocked ? (
        <p className="scraper-dialog__muted">
          Scraping isn't available in this browser. Browsing an imported database still works.
          use "Open database" above to load a <code>.db</code> file.
        </p>
      ) : (
        <>
          {browser === "edge" ? (
            <a
              className="scraper-dialog__primary scraper-dialog__install-link"
              href={EDGE_STORE_URL}
              target="_blank"
              rel="noreferrer"
            >
              Get it from Microsoft Edge Add-ons
            </a>
          ) : (
            <a className="scraper-dialog__primary scraper-dialog__install-link" href={EXTENSION_ZIP_URL} download>
              Download extension (.zip)
            </a>
          )}

          {browser === "edge" ? (
            <details className="scraper-dialog__install-manual">
              <summary>Or install it manually</summary>
              <a className="scraper-dialog__install-link" href={EXTENSION_ZIP_URL} download>
                Download extension (.zip)
              </a>
              <InstallSteps browser={browser} canOpen={variant === "outdated"} />
            </details>
          ) : (
            <InstallSteps browser={browser} canOpen={variant === "outdated"} />
          )}

          <p className="scraper-dialog__reload-note"><strong>{variant === "outdated" ? "Once you've updated the extension, reload this page." : "Once you've installed the extension, reload this page."}</strong></p>
        </>
      )}
    </div>
  );
}

export default function ScraperDialog({
  open,
  onClose,
  scraper,
  onJobsChanged,
  onDatabaseImported,
  statusChipRef,
}) {
  const dialogRef = useRef(null);
  const keepScrapingRef = useRef(null);
  const lastStepRef = useRef(0);
  const tabRefs = useRef({});
  const { status, connection, extension, recheckExtension, start, cancel, deleteAll } = scraper;
  const browser = useMemo(() => detectBrowser(), []);

  const [activeTab, setActiveTab] = useState("scraper");
  const [localError, setLocalError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [debugDownloading, setDebugDownloading] = useState(false);

  // The log follows the newest line only while the user is already at the
  // bottom, so scrolling up to read isn't yanked back.
  const logRef = useRef(null);
  const followLogRef = useRef(true);

  const rate = useScrapeRate(status);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // The dialog's CSS animates in from a transform origin expressed as
      // --origin-x/--origin-y, which default to 50% (the viewport centre,
      // where a modal <dialog> always sits via the UA's margin: auto). A
      // modal dialog has no box until it's shown, so it can't be measured --
      // but the status chip's own centre can be expressed as an offset from
      // that (as-yet-unknown) centre without ever measuring the dialog
      // itself. This must happen before showModal(), or the @starting-style
      // first frame scales from the centre and visibly jumps once the real
      // origin is applied a frame later.
      const t = statusChipRef?.current?.getBoundingClientRect();
      if (t) {
        const dx = Math.round(t.left + t.width / 2 - window.innerWidth / 2);
        const dy = Math.round(t.top + t.height / 2 - window.innerHeight / 2);
        dialog.style.setProperty("--origin-x", `calc(50% + ${dx}px)`);
        dialog.style.setProperty("--origin-y", `calc(50% + ${dy}px)`);
      }
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, statusChipRef]);

  // Always opens back on the Scraper tab -- Database is a quick errand
  // (export/back up/open), not somewhere to land on the next open.
  useEffect(() => {
    if (open) setActiveTab("scraper");
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

  // Refocusing the tab is the moment a user comes back from installing the
  // extension in a new tab, which auto-rechecks its status.
  useEffect(() => {
    if (!open) return undefined;
    const handleFocus = () => recheckExtension();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [open, recheckExtension]);

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

  // Roving-tabindex arrow-key navigation between the two tabs (Home/End jump
  // to the ends; Left/Right wrap around, matching the usual tablist pattern).
  const handleTabKeyDown = (e) => {
    const currentIndex = TABS.findIndex((tab) => tab.key === activeTab);
    let nextIndex = null;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    else if (e.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const nextTab = TABS[nextIndex];
    setActiveTab(nextTab.key);
    tabRefs.current[nextTab.key]?.focus();
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


  const handleDownloadDebug = async () => {
    setDebugDownloading(true);
    setLocalError(null);
    try {
      await downloadDebugBundle();
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setDebugDownloading(false);
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
    <dialog ref={dialogRef} className="scraper-dialog" aria-label="Data" onClick={handleBackdropClick}>
      <div className="scraper-dialog__header">
        <h2>Data</h2>
        <button
          type="button"
          className="scraper-dialog__close"
          onClick={() => dialogRef.current?.close()}
          aria-label={running ? "Minimize" : "Close"}
          title={running ? "Minimize. The scrape keeps running in the background." : "Close"}
        >
          {running ? <MinimizeIcon /> : "×"}
        </button>
      </div>

      <div className="scraper-dialog__tabs" role="tablist" aria-label="Data sections" onKeyDown={handleTabKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el;
            }}
            type="button"
            role="tab"
            id={`scraper-dialog-tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={`scraper-dialog-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="scraper-dialog__tab"
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className="scraper-dialog__body"
        role="tabpanel"
        id="scraper-dialog-panel-database"
        aria-labelledby="scraper-dialog-tab-database"
        hidden={activeTab !== "database"}
      >
        <DatabasePanel
          jobCount={status?.job_count ?? 0}
          scraperRunning={running}
          onDatabaseImported={onDatabaseImported}
          onGoToScraperTab={() => setActiveTab("scraper")}
        />
      </div>

      <div
        className="scraper-dialog__body"
        role="tabpanel"
        id="scraper-dialog-panel-scraper"
        aria-labelledby="scraper-dialog-tab-scraper"
        hidden={activeTab !== "scraper"}
      >
        {!status && <p className="scraper-dialog__muted">Loading status…</p>}

        {status && connection === "reconnecting" && extension === "ready" && (
          <p className="scraper-dialog__muted">Lost contact with the extension, reconnecting…</p>
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
                    Scrape complete. {fmt(status.jobs_saved)} jobs saved.
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
                  {/* Only when the run stopped short: after a full scrape
                      "50 of 50" says nothing, so the stat is dropped. */}
                  {status.total_pages > 0 && status.pages_completed < status.total_pages && (
                    <div>
                      <dt>Pages</dt>
                      <dd className="scraper-dialog__warn">
                        {fmt(status.pages_completed)} of {fmt(status.total_pages)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Saved</dt>
                    <dd>{fmt(status.jobs_saved)}</dd>
                  </div>
                  <div>
                    <dt>Retries</dt>
                    <dd>
                      {status.retry_events && status.retry_events.length > 0 ? (
                        <span
                          className="scraper-dialog__hoverable-count"
                          data-tooltip={formatCountTooltip(status.retry_events, (e) => e)}
                          tabIndex={0}
                        >
                          {fmt(status.retries)}
                        </span>
                      ) : (
                        fmt(status.retries)
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Skipped</dt>
                    <dd className={status.anomalies > 0 ? "scraper-dialog__bad" : ""}>
                      {status.failed_jobs && status.failed_jobs.length > 0 ? (
                        <span
                          className="scraper-dialog__hoverable-count"
                          data-tooltip={formatCountTooltip(
                            status.failed_jobs,
                            (job) => `${job.title || "Untitled"} · ${job.employer || "Unknown employer"} (page ${job.page})`
                          )}
                          tabIndex={0}
                        >
                          {fmt(status.anomalies)}
                        </span>
                      ) : (
                        fmt(status.anomalies)
                      )}
                    </dd>
                  </div>
                  {status.duplicates > 0 && (
                    <div>
                      <dt>Duplicates</dt>
                      <dd>
                        {status.duplicate_jobs && status.duplicate_jobs.length > 0 ? (
                          <span
                            className="scraper-dialog__hoverable-count"
                            data-tooltip={formatCountTooltip(
                              status.duplicate_jobs,
                              (job) => `${job.title || "Untitled"} · ${job.employer || "Unknown employer"} (#${job.job_number}, page ${job.page}) was already saved`
                            )}
                            tabIndex={0}
                          >
                            {fmt(status.duplicates)}
                          </span>
                        ) : (
                          fmt(status.duplicates)
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Speed</dt>
                    <dd>{rate.averageText || "—"}</dd>
                  </div>
                </dl>

                {failedJobs.length > 0 ? (
                  <div className="scraper-dialog__failed">
                    {/* These are the jobs the scraper saw but could not save,
                        which is what the "Skipped" stat counts. */}
                    <p className="scraper-dialog__failed-title">
                      Skipped <span className="scraper-dialog__failed-count">{fmt(failedJobs.length)}</span>
                    </p>
                    <ul className="scraper-dialog__failed-list">
                      {failedJobs.map((job, i) => (
                        <li key={i}>
                          <span className="scraper-dialog__failed-job">
                            {job.title || "Untitled"} · {job.employer || "Unknown employer"}
                          </span>
                          <span className="scraper-dialog__failed-page">p{job.page}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  // Only a run that finished on its own can claim nothing was
                  // skipped. A cancelled, interrupted or failed run has pages it
                  // never reached, so an empty skip list proves nothing; the
                  // amber callout above already says where it stopped.
                  state === "completed" && (
                    <p className="scraper-dialog__success">All jobs scraped, 0 skipped.</p>
                  )
                )}

                {(status.anomalies > 0 || state === "failed") && (
                  <button
                    type="button"
                    className="scraper-dialog__secondary"
                    onClick={handleDownloadDebug}
                    disabled={debugDownloading}
                  >
                    {debugDownloading ? "Preparing debug bundle…" : "Download debug bundle"}
                  </button>
                )}

                {events.length > 0 && (
                  <details className="scraper-dialog__log-details">
                    <summary>Full log ({events.length} lines)</summary>
                    <div className="scraper-dialog__log">{logLines}</div>
                  </details>
                )}
              </div>
            )}

            {extension === "checking" && (
              <p className="scraper-dialog__muted">
                <Spinner size={12} /> Checking for the CoopJobs extension…
              </p>
            )}

            {(extension === "missing" || extension === "outdated") && (
              <ExtensionGate variant={extension} browser={browser} />
            )}

            {!(extension === "missing" && browser === "other") && (
              <>
                <button
                  type="button"
                  className="scraper-dialog__primary"
                  onClick={handleStart}
                  disabled={jobCount > 0 || extension !== "ready"}
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
                      <strong>Can't start a new scrape yet.</strong> There are already {fmt(jobCount)}{" "}
                      jobs in the database and a scrape needs an empty one. Delete all jobs first
                      (slider above), then start again.
                    </span>
                  </div>
                ) : extension === "ready" ? (
                  <p className="scraper-dialog__muted">
                    A browser window will open. Log in, then leave it alone until the scrape finishes.
                  </p>
                ) : null}
              </>
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
                  <strong>A browser window is opening.</strong> Log in there, then leave it alone until
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
                  <strong>Don't click around in the scraper's browser window.</strong> It can cause
                  errors or skipped jobs.
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
                          Log in to the portal in the browser window. Once you're in, don't click
                          around in it. Scraping starts automatically.
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
                {status.retry_events && status.retry_events.length > 0 ? (
                  <span
                    className="scraper-dialog__hoverable-count"
                    data-tooltip={formatCountTooltip(status.retry_events, (e) => e)}
                    tabIndex={0}
                  >
                    <strong>{fmt(status.retries)}</strong> retries
                  </span>
                ) : (
                  <>
                    <strong>{fmt(status.retries)}</strong> retries
                  </>
                )}
              </span>
              <span className={status.failed > 0 ? "scraper-dialog__bad" : ""}>
                {status.failed_jobs && status.failed_jobs.length > 0 ? (
                  <span
                    className="scraper-dialog__hoverable-count"
                    data-tooltip={formatCountTooltip(
                      status.failed_jobs,
                      (job) => `${job.title || "Untitled"} · ${job.employer || "Unknown employer"} (page ${job.page})`
                    )}
                    tabIndex={0}
                  >
                    <strong>{fmt(status.failed)}</strong> skipped
                  </span>
                ) : (
                  <>
                    <strong>{fmt(status.failed)}</strong> skipped
                  </>
                )}
              </span>
              {status.duplicates > 0 && (
                <span>
                  {status.duplicate_jobs && status.duplicate_jobs.length > 0 ? (
                    <span
                      className="scraper-dialog__hoverable-count"
                      data-tooltip={formatCountTooltip(
                        status.duplicate_jobs,
                        (job) => `${job.title || "Untitled"} · ${job.employer || "Unknown employer"} (#${job.job_number}, page ${job.page}) was already saved`
                      )}
                      tabIndex={0}
                    >
                      <strong>{fmt(status.duplicates)}</strong> duplicates
                    </span>
                  ) : (
                    <>
                      <strong>{fmt(status.duplicates)}</strong> duplicates
                    </>
                  )}
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
                Aborting… closing the browser window
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
                  <strong>Abort this scrape?</strong> The browser window closes and the{" "}
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
