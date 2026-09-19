# CoopJobs

A lightweight scraper for uOttawa co-op job postings. Single Python process with Flask REST API, SQLite database, and a React UI. Selenium opens a real Chrome window where you log in; scraping runs in a background thread.

## Quick start

```powershell
.\start.ps1
```

Opens http://127.0.0.1:8000. Click the status chip on the left panel and select "Start scrape". A Chrome window opens; log in to the uOttawa portal. Scraping starts automatically. Login is saved in `data/browser-profile` for next time.

## Requirements

- **Python** 3.12+
- **Node.js** 20+ (only for building the UI)
- **Chrome** or **Edge** (installed and in PATH)

## Building a distributable .exe

```powershell
.\build.ps1
```

Creates `dist\CoopJobs.exe`. Data stored in `%LOCALAPPDATA%\CoopJobs` when frozen.

## Configuration

Optional environment variables (defaults shown):

- `COOPJOBS_PORT=8000` — API and UI server port
- `COOPJOBS_DATA_DIR` — data directory (default: `data/` in repo, or `%LOCALAPPDATA%\CoopJobs` if frozen)
- `COOPJOBS_SEARCH_URL=https://experiential-learning.uottawa.ca/search`
- `COOPJOBS_DEBUG=1` — saves panel HTML snapshots to `data/debug` for diagnosing parsing issues
- `COOPJOBS_NO_BROWSER=1` — skip auto-opening the UI in your default browser on startup

## Development

UI dev server (hot reload on 5173, proxies `/api` to 8000):

```powershell
cd web
npm run dev
```

Run tests:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

## Project layout

```
app/
  __main__.py           Entry point, logging, DB init, Flask startup
  config.py             Constants and env overrides
  schema.sql            SQLite schema
  db.py                 Database functions
  deadlines.py          Parse deadline strings
  server.py             Flask app and HTTP API
  scraper/
    browser.py          Selenium WebDriver setup
    panel_parser.py     Parse job HTML
    portal.py           Portal navigation
    runner.py           Threaded scraper state machine
tests/                  pytest tests
web/                    React UI (Vite)
run_app.py              PyInstaller entry point (used by build.ps1)
.gitignore, requirements*.txt, start.ps1, build.ps1
```

## API endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/jobs` | Filtered/sorted jobs (query, filters, deadline, sort params) |
| GET | `/api/jobs/<id>` | Full job detail or 404 |
| GET | `/api/facets` | Field value counts (employer, location, etc.) |
| DELETE | `/api/jobs` | Clear database (409 if scrape running) |
| GET | `/api/scraper/status` | Scraper state + job_count, last_scraped_at |
| POST | `/api/scraper/start` | Start scrape (202 or 409 if already running/DB not empty) |
| POST | `/api/scraper/cancel` | Cancel scrape (200, no-op if not running) |
| GET | `/api/export/json` | Export jobs as JSON file |
| GET | `/api/health` | Server health check |
| GET | `/` | Serve UI (web/dist/index.html fallback) |