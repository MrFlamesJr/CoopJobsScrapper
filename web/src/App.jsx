import JobList from "./components/JobList";
import { useState } from "react";
import ScraperPanel from "./components/ScraperPanel";

const API_URL = import.meta.env.VITE_API_URL || "";

function App() {
  const [tab, setTab] = useState("jobs");
  const [jobsVersion, setJobsVersion] = useState(0);

  async function downloadJson() {
    try {
      const response = await fetch(`${API_URL}/api/export/json`);

      if (!response.ok) {
        throw new Error("Could not export the database.");
      }

      const data = await response.json();

      const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: "application/json" }
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = "coop-jobs.json";

      document.body.appendChild(link);
      link.click();
      link.remove();

      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("JSON export failed:", error);
    }
  }

  return (
    <main className="page-shell">
      <header className="page-header">
          <button type="button" onClick={downloadJson}>
          Download JSON
        </button>
        <div>
          <p className="eyebrow">Co-op jobs</p>
          <h1>Available opportunities</h1>
          <p className="intro">
            Browse the latest positions collected from the job portal.
          </p>
        </div>

        <span className="header-mark" aria-hidden="true">
          Jobs
        </span>
      </header>

      <nav className="app-tabs" aria-label="Application views">
        <button
          className={tab === "jobs" ? "app-tabs__active" : ""}
          onClick={() => setTab("jobs")}
        >
          Jobs
        </button>

        <button
          className={tab === "scraper" ? "app-tabs__active" : ""}
          onClick={() => setTab("scraper")}
        >
          Scraper
        </button>


      </nav>

      {tab === "scraper" ? (
        <ScraperPanel
          onCompleted={() => setJobsVersion((version) => version + 1)}
        />
      ) : (
        <JobList key={jobsVersion} />
      )}
    </main>
  );
}

export default App;