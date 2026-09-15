import { useEffect, useState } from "react";
import JobCard from "./JobCard";
import "./JobList.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function JobList() {
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let active = true;

    fetch(`${API_URL}/api/jobs`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Could not load jobs");
        }
        return response.json();
      })
      .then((data) => {
        if (active) {
          setJobs(data);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          setStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (status === "loading") {
    return <p className="job-list__message">Loading jobs...</p>;
  }

  if (status === "error") {
    return (
      <section className="job-list__message" aria-live="polite">
        <h2>Jobs are unavailable</h2>
        <p>Start the API server and refresh this page to try again.</p>
      </section>
    );
  }

  if (jobs.length === 0) {
    return <p className="job-list__message">No jobs have been scraped yet.</p>;
  }

  return (
    <section aria-label="Available jobs">
      <div className="job-list__summary">
        <span>{jobs.length} opportunities</span>
        <span>Updated from your latest scrape</span>
      </div>
      <div className="job-list">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>
    </section>
  );
}

export default JobList;
