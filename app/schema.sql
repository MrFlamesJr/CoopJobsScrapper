CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  job_number TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  employer TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  work_model TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL DEFAULT '',
  round TEXT NOT NULL DEFAULT '',
  salary TEXT NOT NULL DEFAULT '',
  deadline_text TEXT NOT NULL DEFAULT '',
  deadline_date TEXT,
  description TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL DEFAULT '[]',
  qualifications TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL DEFAULT '',
  page_number INTEGER,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_job_number ON jobs(job_number) WHERE job_number <> '';

-- Favorites outlive the jobs table: `clear_jobs` never touches them, and they
-- re-link to a re-scraped job through job_number.
CREATE TABLE IF NOT EXISTS favorites (
  job_number TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',      -- snapshot, shown if the job disappears after a re-scrape
  employer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value store for facts about the scraper itself, not the jobs.
-- `last_run` holds the JSON record of the latest run, so the UI still knows an
-- aborted (or never finished) run left an incomplete job list behind after a restart.
CREATE TABLE IF NOT EXISTS scrape_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS job_facets AS
  SELECT 'employer' AS field, employer AS value, COUNT(*) AS job_count FROM jobs WHERE employer <> '' GROUP BY employer
  UNION ALL
  SELECT 'location' AS field, location AS value, COUNT(*) AS job_count FROM jobs WHERE location <> '' GROUP BY location
  UNION ALL
  SELECT 'work_model' AS field, work_model AS value, COUNT(*) AS job_count FROM jobs WHERE work_model <> '' GROUP BY work_model
  UNION ALL
  SELECT 'term' AS field, term AS value, COUNT(*) AS job_count FROM jobs WHERE term <> '' GROUP BY term
  UNION ALL
  SELECT 'duration' AS field, duration AS value, COUNT(*) AS job_count FROM jobs WHERE duration <> '' GROUP BY duration
  UNION ALL
  SELECT 'round' AS field, round AS value, COUNT(*) AS job_count FROM jobs WHERE round <> '' GROUP BY round;
