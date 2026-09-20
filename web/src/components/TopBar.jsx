import { useEffect, useRef, useState } from "react";
import Spinner from "./Spinner.jsx";
import SlideToConfirm from "./SlideToConfirm.jsx";
import { HeartIcon } from "./FavoriteButton.jsx";
import { downloadDatabase, exportJobsJson, importDatabase } from "../api.js";
import { incompleteRun, runPageLabel } from "../scrapeProgress.js";
import "./TopBar.css";

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

/** "⚠ Incomplete: scrape aborted on page 3 of 39". */
function incompleteLine(run) {
  return `⚠ Incomplete: scrape ${INCOMPLETE_WORD[run.state]} on ${runPageLabel(run)}`;
}

/**
 * The one sticky bar above the grid: count and the live-scrape line on the
 * left, Collapse all / Export / Favorites pinned right. Always rendered
 * (replaces JobGrid's old toolbar and the favorites drawer's fixed edge
 * tab), so Favorites works even with an empty grid and everything lines up
 * in one row instead of three separately-positioned pieces.
 */
export default function TopBar({
  shown,
  total,
  scraperRunning,
  scraperStatus,
  onOpenScraper,
  expandedCount,
  onCollapseAll,
  favoritesCount,
  pulseKey,
  onOpenFavorites,
  onDatabaseImported,
}) {
  // Same slot as the live line, so only one of the two is ever in the row.
  const incomplete = scraperRunning ? null : incompleteRun(scraperStatus);

  const fileInputRef = useRef(null);
  const confirmDialogRef = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [dbError, setDbError] = useState(null);

  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return;
    if (pendingFile && !dialog.open) dialog.showModal();
    if (!pendingFile && dialog.open) dialog.close();
  }, [pendingFile]);

  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, []);

  const handleDownloadDatabase = async () => {
    setDbError(null);
    try {
      await downloadDatabase();
    } catch (err) {
      setDbError(err.message);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setDbError(null);
      setPendingFile(file);
    }
  };

  const handleImportConfirm = async () => {
    if (!pendingFile) return;
    setImporting(true);
    setDbError(null);
    try {
      await importDatabase(pendingFile);
      onDatabaseImported?.();
      setPendingFile(null);
    } catch (err) {
      setDbError(err.message);
      throw err; // lets SlideToConfirm spring back
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCancelImport = () => {
    confirmDialogRef.current?.close();
  };

  return (
    <div className="top-bar">
      {total > 0 && (
        <p className="top-bar__count">
          <strong>{shown}</strong> job{shown === 1 ? "" : "s"} of {total}
        </p>
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

      <div className="top-bar__spacer" />

      {/* Only worth showing once closing them one by one is a chore. */}
      {expandedCount > 1 && (
        <button type="button" className="top-bar__button" onClick={onCollapseAll}>
          Collapse all ({expandedCount})
        </button>
      )}

      {total > 0 && (
        <button
          type="button"
          className="top-bar__button top-bar__button--export"
          onClick={() => exportJobsJson()}
        >
          <svg className="top-bar__icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1.5v8.6M4.6 6.8 8 10.2l3.4-3.4M2.5 12v1.3c0 .7.6 1.2 1.2 1.2h8.6c.7 0 1.2-.6 1.2-1.2V12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="top-bar__label">Export JSON</span>
        </button>
      )}

      <button type="button" className="top-bar__button" onClick={handleDownloadDatabase}>
        <span className="top-bar__label">Download database</span>
      </button>

      <button
        type="button"
        className="top-bar__button"
        onClick={() => fileInputRef.current?.click()}
        disabled={scraperRunning}
        title={scraperRunning ? "Can't open a database while a scrape is running" : undefined}
      >
        <span className="top-bar__label">Open database</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".db,.sqlite,.sqlite3"
        className="top-bar__file-input"
        onChange={handleFileChange}
      />

      {dbError && <span className="top-bar__db-error">{dbError}</span>}

      <dialog
        ref={confirmDialogRef}
        className="top-bar__confirm-dialog"
        aria-label="Replace database"
        onClick={(e) => {
          if (e.target === confirmDialogRef.current) handleCancelImport();
        }}
      >
        <div className="top-bar__confirm-body">
          <p className="top-bar__confirm-text">
            <strong>Replace the current database?</strong> This replaces all jobs and favorites in
            this browser.
          </p>
          <div className="top-bar__confirm-actions">
            <button
              type="button"
              className="top-bar__confirm-cancel"
              onClick={handleCancelImport}
              disabled={importing}
            >
              Cancel
            </button>
            <SlideToConfirm
              label="Slide to replace database"
              busyLabel="Replacing…"
              busy={importing}
              onConfirm={handleImportConfirm}
            />
          </div>
        </div>
      </dialog>

      <button
        type="button"
        className="top-bar__button top-bar__button--favorites"
        onClick={onOpenFavorites}
        aria-label={`Open favorites (${favoritesCount})`}
      >
        {/* Keyed on pulseKey so the pop restarts on each save; 0 on first
            render, so nothing pops on load. */}
        <span
          key={pulseKey}
          className={`top-bar__heart ${pulseKey > 0 ? "top-bar__heart--pulse" : ""}`}
        >
          <HeartIcon />
        </span>
        <span className="top-bar__label">Favorites</span>
        <span className="top-bar__count-badge">{favoritesCount}</span>
      </button>
    </div>
  );
}
