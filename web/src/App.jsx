import JobList from "./components/JobList";

function App() {
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
      <JobList />
    </main>
  );
}

export default App;
