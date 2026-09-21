import { useEffect, useRef, useState } from "react";
import { downloadDatabase, exportJobsJson, importDatabase } from "../api.js";
import Spinner from "./Spinner.jsx";
import "./DatabasePanel.css";

/**
 * The "Database" tab of the Data dialog (see ScraperDialog.jsx). Everything
 * here used to live in TopBar.jsx's button row; it moved here so the
 * database actions get room for an explanation each, and so "Open database"
 * can be gated on an empty database instead of just a scrape-in-progress
 * check (opening one now REPLACES the current database rather than merging,
 * so it only makes sense once there is nothing to lose -- see api.js's
 * importDatabase, which throws "database_not_empty" as a backstop for the
 * same rule).
 */
export default function DatabasePanel({ jobCount, scraperRunning, onDatabaseImported, onGoToScraperTab }) {
  const fileInputRef = useRef(null);
  const confirmDialogRef = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);

  const canOpen = jobCount === 0 && !scraperRunning;

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

  const handleExport = async () => {
    setError(null);
    try {
      await exportJobsJson();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDownload = async () => {
    setError(null);
    try {
      await downloadDatabase();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setError(null);
      setPendingFile(file);
    }
  };

  const handleConfirmOpen = async () => {
    if (!pendingFile) return;
    setImporting(true);
    setError(null);
    try {
      await importDatabase(pendingFile);
      onDatabaseImported?.();
      setPendingFile(null);
    } catch (err) {
      // Surfaces importDatabase's "database_not_empty" backstop too, e.g. a
      // scrape or import in another tab landed a job between this panel
      // enabling the button and the file picker closing.
      setError(err.message);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCancelOpen = () => {
    confirmDialogRef.current?.close();
  };

  return (
    <div className="database-panel">
      <div className="database-panel__action">
        <button
          type="button"
          className="database-panel__button"
          onClick={handleExport}
          disabled={jobCount === 0}
          aria-describedby="database-panel-export-hint"
        >
          Export JSON
        </button>
        <p className="database-panel__hint" id="database-panel-export-hint">
          {jobCount === 0 ? "No jobs to export yet." : "Every job in the database, as a .json file."}
        </p>
      </div>

      <div className="database-panel__action">
        <button type="button" className="database-panel__button" onClick={handleDownload}>
          Download database
        </button>
        <p className="database-panel__hint">
          A .db file you can back up or open in the desktop app.
        </p>
      </div>

      <div className="database-panel__action">
        <button
          type="button"
          className="database-panel__button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canOpen}
          aria-describedby="database-panel-open-hint"
        >
          Open database
        </button>
        {canOpen ? (
          <p className="database-panel__hint" id="database-panel-open-hint">
            Replace this browser's database with a .db file.
          </p>
        ) : (
          <p className="database-panel__hint" id="database-panel-open-hint">
            Opening a database replaces everything, so delete all jobs first.{" "}
            <button type="button" className="database-panel__link" onClick={onGoToScraperTab}>
              Go to the Scraper tab
            </button>
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".db,.sqlite,.sqlite3"
          className="database-panel__file-input"
          onChange={handleFileChange}
        />
      </div>

      {error && <p className="database-panel__error">{error}</p>}

      <dialog
        ref={confirmDialogRef}
        className="database-panel__confirm-dialog"
        aria-label="Open database"
        onClick={(e) => {
          if (e.target === confirmDialogRef.current) handleCancelOpen();
        }}
      >
        <div className="database-panel__confirm-body">
          {importing ? (
            <p className="database-panel__confirm-text">
              <Spinner size={18} /> Opening database...
            </p>
          ) : (
            <>
              <p className="database-panel__confirm-text">
                <strong>Open {pendingFile?.name}?</strong> This replaces the database in this browser.
              </p>
              <div className="database-panel__confirm-actions">
                <button
                  type="button"
                  className="database-panel__confirm-cancel"
                  onClick={handleCancelOpen}
                  disabled={importing}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="database-panel__confirm-open"
                  onClick={handleConfirmOpen}
                  disabled={importing}
                >
                  Open
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </div>
  );
}
