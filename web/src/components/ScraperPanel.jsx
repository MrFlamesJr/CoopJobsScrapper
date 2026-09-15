import { useEffect, useState } from "react";
import ConfirmationModal from "./ConfirmationModal";
import "./ScraperPanel.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const ACTIVE_STATES = new Set(["starting", "waiting_for_login", "scraping"]);

function ScraperPanel({ onCompleted }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [confirmScrape, setConfirmScrape] = useState(false);
  const [hasExistingData, setHasExistingData] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${API_URL}/api/scraper/status`);
        if (!response.ok) throw new Error("The scraper service is unavailable.");
        const nextStatus = await response.json();
        if (active) {
          setStatus(nextStatus);
          setError("");
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    };
    refresh();
    const interval = window.setInterval(() => {
      refresh();
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/api/jobs`)
      .then((response) => {
        if (!response.ok) throw new Error("Could not check existing jobs.");
        return response.json();
      })
      .then((jobs) => {
        if (active) setHasExistingData(jobs.length > 0);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  async function start() {
    setError("");
    setConfirmScrape(false);
    setBrowserOpen(true);
    try {
      const response = await fetch(`${API_URL}/api/scraper/scrape`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start the scraper.");
      setStatus(data);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    if (status?.state === "completed") onCompleted();
  }, [status?.state]);

  useEffect(() => {
    if (!browserOpen) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === "Escape") setBrowserOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [browserOpen]);

  const active = status && ACTIVE_STATES.has(status.state);
  const label = {
    login_required: "Login required",
    idle: "Not started",
    starting: "Starting browser",
    waiting_for_login: "Waiting for portal login",
    scraping: "Scraping jobs",
    completed: "Scrape complete",
    failed: "Scrape failed",
    stopped: "Scrape stopped",
  }[status?.state] || "Connecting to scraper";

  return (
    <section className="scraper-panel" aria-labelledby="scraper-heading">
      <div className="scraper-panel__heading">
        <div>
          <p className="eyebrow">Scraper control</p>
          <h2 id="scraper-heading">Collect fresh opportunities</h2>
          <p>Open the browser session, log in to the portal, and start a collection run.</p>
        </div>
        <div className="scraper-panel__heading-actions">
          <span className={`scraper-panel__state scraper-panel__state--${status?.state || "idle"}`}>
            {label}
          </span>
        </div>
      </div>

      {browserOpen && status?.browser_url && (
        <div
          className="scraper-viewer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scraper-viewer-heading"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBrowserOpen(false);
          }}
        >
          <div className="scraper-viewer__window" onMouseDown={(event) => event.stopPropagation()}>
            <div className="scraper-viewer__header">
              <strong id="scraper-viewer-heading">Portal login</strong>
              <button type="button" onClick={() => setBrowserOpen(false)} aria-label="Close scraper browser">Close</button>
            </div>
            <div className="scraper-viewer__viewport">
              <iframe className="scraper-viewer__frame" src={status.browser_url} title="Scraper browser" />
            </div>
          </div>
        </div>
      )}

      <div className="scraper-panel__details" aria-live="polite">
        <strong>{status?.message || "Loading scraper status..."}</strong>
        {status?.state === "scraping" && (
          <span>{status.pages_completed} page(s), {status.jobs_saved} jobs saved</span>
        )}
        {status?.steps?.length > 0 && (
          <ol className="scraper-panel__steps">
            {status.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        )}
        {status?.error && <span className="scraper-panel__error">{status.error}</span>}
        {error && <span className="scraper-panel__error">{error}</span>}
      </div>

      <div className="scraper-panel__actions">
        {active ? (
          <button type="button" onClick={() => setBrowserOpen(true)}>
            Open scraper browser
          </button>
        ) : (
          <button type="button" onClick={() => (hasExistingData ? setConfirmScrape(true) : start())}>
            Scrape
          </button>
        )}
      </div>
      <ConfirmationModal
        open={confirmScrape}
        title="Existing jobs found"
        message="Jobs already exist. Scraping will add another collection to the database. Do you want to continue?"
        confirmLabel="Continue scrape"
        onConfirm={start}
        onCancel={() => setConfirmScrape(false)}
      />
    </section>
  );
}

export default ScraperPanel;