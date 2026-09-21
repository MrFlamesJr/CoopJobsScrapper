import { useEffect, useRef, useState } from "react";
import "./AboutModal.css";

const TABS = [
  { key: "general", label: "General" },
  { key: "advanced", label: "Advanced" },
];

export default function AboutModal({ open, onClose }) {
  const dialogRef = useRef(null);
  const tabRefs = useRef([]);
  const [activeTab, setActiveTab] = useState("general");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Defaults back to General every time the dialog is (re)opened.
  useEffect(() => {
    if (open) setActiveTab("general");
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  const handleBackdropClick = (e) => {
    if (e.target === dialogRef.current) dialogRef.current.close();
  };

  const selectTab = (index) => {
    const next = TABS[(index + TABS.length) % TABS.length];
    setActiveTab(next.key);
    tabRefs.current[(index + TABS.length) % TABS.length]?.focus();
  };

  const handleTabKeyDown = (e, index) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        selectTab(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        selectTab(index - 1);
        break;
      case "Home":
        e.preventDefault();
        selectTab(0);
        break;
      case "End":
        e.preventDefault();
        selectTab(TABS.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="about-modal"
      aria-label="About the web app"
      onClick={handleBackdropClick}
    >
      <div className="about-modal__header">
        <h2>About</h2>
        <button
          type="button"
          className="about-modal__close"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="about-modal__tabbar" role="tablist" aria-label="About sections">
        {TABS.map((tab, i) => (
          <button
            key={tab.key}
            ref={(el) => (tabRefs.current[i] = el)}
            type="button"
            role="tab"
            id={`about-modal-tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={`about-modal-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className={`about-modal__tab ${activeTab === tab.key ? "about-modal__tab--active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
            onKeyDown={(e) => handleTabKeyDown(e, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="about-modal__body">
        {activeTab === "general" && (
          <div
            id="about-modal-panel-general"
            role="tabpanel"
            aria-labelledby="about-modal-tab-general"
            tabIndex={0}
            className="about-modal__panel"
          >
            <section className="about-modal__section">
              <h3>What this is</h3>
              <p>
                A viewer for University of Ottawa co-op job postings. You scrape the postings
                yourself from the co-op portal, and this web app reads them back to you in a form
                that is easier to search and compare than the portal is. Everything stays in your
                browser and nothing gets uploaded. Scrape a round once, then use this web app to
                cut a few hundred postings down to the ones you will actually apply to.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>How to use it</h3>
              <ol className="about-modal__list about-modal__list--steps">
                <li>Install the extension and start a scrape from <strong>Data → Scraper</strong>.</li>
                <li>Log in when the browser window opens and leave it alone.</li>
                <li>When it finishes, narrow the list with search and filters.</li>
                <li>Go through the results once with thumbs up and thumbs down. (Sort by "My Ratings" or filter to easily find your rated jobs.)</li>
                <li>You can download the database as a backup.</li>
                <li>Re-scrape at any time to update your list.</li>
              </ol>
            </section>

            <section className="about-modal__section">
              <h3>Scraping</h3>
              <ul className="about-modal__list">
                <li>
                  The extension opens the co-op portal in its own window at{" "}
                  {/* URL duplicates SEARCH_URL at extension/src/background/index.js:41; keep in step */}
                  <a href="https://experiential-learning.uottawa.ca/search" target="_blank" rel="noreferrer">
                    experiential-learning.uottawa.ca/search
                  </a>
                  .
                </li>
                <li>You log in yourself. After that, do not click around in that window. Jobs arrive here as the extension finds them.</li>
                <li>A scrape only starts on an empty database. To scrape again, delete all jobs first (<strong>Data → Scraper</strong>, slide to delete). Your ratings are kept.</li>
                <li><strong>Run in background</strong> minimizes the dialog and the scrape keeps going. <strong>Abort scrape</strong> closes the window and keeps the jobs saved so far, but a scrape cannot be resumed, so getting the rest means deleting all jobs and starting from page one.</li>
                <li>The report at the end shows how long it took, how many were saved, and how many were retried, skipped or duplicates. Hover a count to see which jobs it covers.</li>
              </ul>
            </section>

            <section className="about-modal__section">
              <h3>Filtering</h3>
              <ul className="about-modal__list">
                <li>The search box matches across title, employer, location, term, salary, description, requirements and qualifications, and highlights the matching words.</li>
                <li>The filter groups are Employer, Location, Work model, Term, Duration and Round. Each value shows how many jobs it covers.</li>
                <li>Picking more than one value inside a group widens the list (either one counts). Picking values in two different groups narrows it (both have to be true). So Location: Ottawa + Toronto with Work model: Remote means remote jobs in either city.</li>
                <li><strong>Hide closed</strong> drops anything past its application deadline.</li>
                <li>The chips across the top are everything currently on. The × on a chip removes just that one, and <strong>Clear all</strong> resets the lot.</li>
              </ul>
            </section>

            <section className="about-modal__section">
              <h3>Sorting</h3>
              <ul className="about-modal__list">
                <li><strong>+ Add sort</strong> stacks sorts. The top one decides the order and the ones under it break ties, so Employer then Deadline groups by employer and puts each employer's soonest deadline first.</li>
                <li>Drag a row to change which sort wins. At least one sort is always required.</li>
                <li>Click a sort's direction to flip it: A→Z or Z→A, Soonest or Latest, Oldest or Newest, Liked first or Disliked first.</li>
                <li>The fields are Employer, Title, Location, Deadline, Added and My rating.</li>
              </ul>
            </section>

            <section className="about-modal__section">
              <h3>My rating</h3>
              <ul className="about-modal__list">
                <li>Thumbs up or thumbs down on any card, or in the open posting.</li>
                <li>Ratings are stored against the job number rather than the posting, so they survive a re-scrape. Delete every job, scrape again, and your shortlist is still there.</li>
                <li>The <strong>Ratings</strong> control in the sidebar is Liked, All, or Hidden: Liked shows only what you liked, Hidden drops what you disliked, All shows everything.</li>
                <li><strong>Sort by My rating</strong> puts Liked first, then jobs you have not rated, then Disliked. Flip it to bring Disliked to the top.</li>
                <li>The intended pass: go through everything once and thumbs down whatever is out, switch Ratings to <strong>Hidden</strong> so those disappear, then thumbs up the keepers. From there set Ratings to <strong>Liked</strong> and sort by Deadline, Soonest, to apply in the order things close. Sort by My rating is for when you want to see everything at once with the liked ones at the top.</li>
              </ul>
            </section>

            <section className="about-modal__section">
              <h3>Data → Database</h3>
              <dl className="about-modal__cards">
                <div className="about-modal__card">
                  <dt>Export JSON</dt>
                  <dd>
                    A snapshot of the job list for a spreadsheet or a script. You cannot load it
                    back in.
                  </dd>
                </div>
                <div className="about-modal__card">
                  <dt>Download database</dt>
                  <dd>
                    Saves everything, jobs and ratings and the scrape record, as one{" "}
                    <code>coopjobs.db</code> file. Use it as a backup before you delete jobs, to
                    move your data to another browser or computer, or to keep scrapes from
                    different terms side by side.
                  </dd>
                </div>
                <div className="about-modal__card">
                  <dt>Open database</dt>
                  <dd>
                    Loads a <code>coopjobs.db</code> file back in. You have to delete all your
                    jobs first, so the button stays disabled while there is anything here to lose.
                    Once the list is empty, pick a file and it becomes your data.
                  </dd>
                </div>
              </dl>
            </section>

            <section className="about-modal__section">
              <h3>Where the data lives</h3>
              <p>
                In your browser's own storage (OPFS) for this site. If you clear site data, the
                jobs go with it. Download database is the insurance against that.
              </p>
            </section>
          </div>
        )}

        {activeTab === "advanced" && (
          <div
            id="about-modal-panel-advanced"
            role="tabpanel"
            aria-labelledby="about-modal-tab-advanced"
            tabIndex={0}
            className="about-modal__panel"
          >
            <section className="about-modal__section">
              <h3>No server at all</h3>
              <p>
                SQLite compiled to WebAssembly (<code>@sqlite.org/sqlite-wasm</code>) runs in a
                Web Worker on OPFS. A real relational database inside the page, with queries off
                the main thread so the UI never stalls. It replaced a Flask backend, which is why{" "}
                <code>web/src/api.js</code> still has REST-shaped functions. That seam turned out
                to be worth keeping.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>Why it needs an extension</h3>
              <p>
                The portal sits behind university SSO and is a MudBlazor single-page application, so there
                is nothing to fetch. The only way in is to drive a browser that is already logged
                in. A content script reads the pages, a background service worker owns the run.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>The service worker falls asleep</h3>
              <p>
                The sharpest constraint in MV3, and it shapes everything else. Run state lives in{" "}
                <code>ScrapeRunner</code> and is written to <code>chrome.storage</code> on every
                change, so a scrape picks up where it left off when the worker wakes. Timers that
                would be throttled in the page run from the worker instead.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>Getting jobs across without losing or duplicating them</h3>
              <p>
                Jobs travel over a <code>postMessage</code> bridge carrying sequence numbers and
                acknowledgements. Anything unacknowledged stays in an outbox that rides along in
                every status snapshot, so reloading the page mid-scrape means the reconnecting tab
                drains exactly what it missed.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>Never trust your own page counter</h3>
              <p>
                The portal has been seen to reset its pagination back to page one partway through
                a session. The scraper reads MudBlazor's own "Current page N" button instead of
                counting its own clicks, notices when the two disagree, and clicks its way back.
                The kind of thing you only find by running it against the real site.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>Search ranking</h3>
              <p>
                A lowercase LIKE over a prebuilt <code>search_text</code> column gets the
                candidates, then JavaScript re-ranks them into tiers: all words in the title, all
                words visible on the card, everything else. Each result gets a snippet from
                whichever field matched first.
              </p>
            </section>

            <section className="about-modal__section">
              <h3>Database schema</h3>
              <ul className="about-modal__list">
                <li>
                  <code>jobs</code>. One row per posting, unique on <code>job_number</code>, with
                  a prebuilt <code>search_text</code> column and a parsed <code>deadline_date</code>.
                </li>
                <li>
                  <code>favorites</code>. The ratings: <code>job_number</code> + <code>rating</code>{" "}
                  of 1 or -1. Kept separately so deleting every job and scraping fresh does not
                  throw your shortlist away.
                </li>
                <li>
                  <code>scrape_meta</code>. Key/value, holds the last run record.
                </li>
                <li>
                  <code>job_facets</code>. A view that powers the sidebar counts.
                </li>
              </ul>
            </section>

            <section className="about-modal__section">
              <h3>The file is just SQLite</h3>
              <p>
                <code>coopjobs.db</code> is a plain SQLite database, readable by any SQLite tool
                and interchangeable with the older Python desktop version of this project.
              </p>
            </section>
          </div>
        )}
      </div>
    </dialog>
  );
}
