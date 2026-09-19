import { useEffect, useRef, useState } from "react";
import "./ScraperDialog.css";

const RUNNING_STEPS = [
  { key: "starting", label: "Opening browser" },
  { key: "waiting_for_login", label: "Log in to the portal in the Chrome window that opened" },
  { key: "scraping", label: "Scraping" },
];

const DELETE_CONFIRM_MS = 4000;

function formatScrapedAt(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function ScraperDialog({ open, onClose, scraper, onJobsChanged }) {
  const dialogRef = useRef(null);
  const { status, start, cancel, deleteAll } = scraper;

  const [localError, setLocalError] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimerRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

  const state = status?.state || "idle";
  const running = state === "starting" || state === "waiting_for_login" || state === "scraping";
  const jobCount = status?.job_count ?? 0;

  const handleStart = async () => {
    setLocalError(null);
    try {
      await start();
    } catch (err) {
      setLocalError(err.message);
    }
  };

  const handleCancel = async () => {
    try {
      await cancel();
    } catch (err) {
      setLocalError(err.message);
    }
  };

  const handleDeleteClick = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimerRef.current = setTimeout(() => setConfirmingDelete(false), DELETE_CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimerRef.current);
    setConfirmingDelete(false);
    setDeleting(true);
    try {
      await deleteAll();
      onJobsChanged?.();
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const currentStepIndex = RUNNING_STEPS.findIndex((s) => s.key === state);

  return (
    <dialog ref={dialogRef} className="scraper-dialog" aria-label="Scraper">
      <div className="scraper-dialog__header">
        <h2>Scraper</h2>
        <button
          type="button"
          className="scraper-dialog__close"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="scraper-dialog__body">
        {!status && <p className="scraper-dialog__muted">Loading status…</p>}

        {status && !running && (state === "idle" || state === "completed" || state === "cancelled" || state === "failed") && (
          <>
            {jobCount > 0 && (
              <div className="scraper-dialog__summary">
                <p>
                  <strong>{jobCount}</strong> job{jobCount === 1 ? "" : "s"} scraped
                  {status.last_scraped_at ? ` ${formatScrapedAt(status.last_scraped_at)}` : ""}.
                </p>
                <p className="scraper-dialog__muted">
                  A new scrape needs an empty database. Delete the current jobs first if you want
                  to run it again.
                </p>
                <button
                  type="button"
                  className={`scraper-dialog__danger ${confirmingDelete ? "scraper-dialog__danger--confirm" : ""}`}
                  onClick={handleDeleteClick}
                  disabled={deleting}
                >
                  {deleting
                    ? "Deleting…"
                    : confirmingDelete
                      ? "Click again to confirm"
                      : "Delete all jobs"}
                </button>
              </div>
            )}

            {state === "completed" && (
              <>
                <p className="scraper-dialog__success">
                  {status.message || `Scrape completed: ${status.jobs_saved ?? 0} jobs saved.`}
                </p>
                {status.failed > 0 && (
                  <ul className="scraper-dialog__failed-list">
                    {(status.failed_jobs || []).map((job, i) => (
                      <li key={i}>
                        {job.title} — {job.employer}, page {job.page}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {state === "cancelled" && (
              <p className="scraper-dialog__muted">
                {status.message || "The scrape was cancelled."}
              </p>
            )}
            {state === "failed" && (
              <p className="scraper-dialog__error">{status.error || "The scrape failed."}</p>
            )}

            <button
              type="button"
              className="scraper-dialog__primary"
              onClick={handleStart}
              disabled={jobCount > 0}
              title={jobCount > 0 ? "Delete the existing jobs before starting a new scrape" : ""}
            >
              Start scrape
            </button>

            {state === "completed" && (
              <button type="button" className="scraper-dialog__secondary" onClick={() => dialogRef.current?.close()}>
                View jobs
              </button>
            )}

            {localError && <p className="scraper-dialog__error">{localError}</p>}
          </>
        )}

        {status && running && (
          <>
            <ol className="scraper-dialog__steps">
              {RUNNING_STEPS.map((step, i) => {
                const stepState =
                  i < currentStepIndex ? "done" : i === currentStepIndex ? "active" : "pending";
                return (
                  <li key={step.key} className={`scraper-dialog__step scraper-dialog__step--${stepState}`}>
                    <span className="scraper-dialog__step-index">{i + 1}</span>
                    <span className="scraper-dialog__step-label">
                      {step.label}
                      {step.key === "waiting_for_login" && stepState === "active" && (
                        <span className="scraper-dialog__step-hint">
                          {" "}
                          Scraping starts automatically once you're logged in.
                        </span>
                      )}
                      {step.key === "scraping" && stepState === "active" && (
                        <span className="scraper-dialog__step-hint">
                          {" "}
                          page {status.pages_completed ?? 0} · {status.jobs_saved ?? 0} jobs saved
                          {status.duplicates > 0 ? ` · ${status.duplicates} duplicates` : ""}
                          {status.failed > 0 ? ` · ${status.failed} failed` : ""}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
              <li className="scraper-dialog__step scraper-dialog__step--pending">
                <span className="scraper-dialog__step-index">4</span>
                <span className="scraper-dialog__step-label">Done</span>
              </li>
            </ol>
            <button type="button" className="scraper-dialog__danger" onClick={handleCancel}>
              Cancel
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
