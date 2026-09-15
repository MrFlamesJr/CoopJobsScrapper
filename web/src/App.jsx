import JobList from "./components/JobList";
import { useState } from "react";
import ScraperPanel from "./components/ScraperPanel";

function App() {
  const [tab, setTab] = useState("jobs");
  const [jobsVersion, setJobsVersion] = useState(0);

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Co-op jobs</p>
          <h1>Available opportunities</h1>
          <p className="intro">Browse the latest positions collected from the job portal.</p>
        </div>
        <span className="header-mark" aria-hidden="true">Jobs</span>
      </header>
      <nav className="app-tabs" aria-label="Application views">
        <button className={tab === "jobs" ? "app-tabs__active" : ""} onClick={() => setTab("jobs")}>Jobs</button>
        <button className={tab === "scraper" ? "app-tabs__active" : ""} onClick={() => setTab("scraper")}>Scraper</button>
      </nav>
      {tab === "scraper" ? (
        <ScraperPanel onCompleted={() => setJobsVersion((version) => version + 1)} />
      ) : (
        <JobList key={jobsVersion} />
      )}
    </main>
  );
}

export default App;
