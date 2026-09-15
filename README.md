# Coop Jobs Scraper

The web app controls the scraper and displays jobs saved in MySQL. It does not create JSON files.

## Project structure

```text
app/
	database/               MySQL connection and job writer
	scraper/                Selenium scraping code and controller
server/
	app.py                  Jobs and scraper API
	Dockerfile              API server image
database/
	schema.sql              MySQL table definitions
legacy/                   Older scripts kept for reference
docker-compose.yml        MySQL, Selenium, API, and web containers
```

## 1. Start everything

Install Docker Desktop once. Then start the complete application with one command:

```powershell
.\start.ps1
```

The script starts MySQL, the Selenium browser, the API, and the web app. Open the web app at [http://localhost:5300](http://localhost:5300). Starting a scrape opens the remote browser in a contained viewer over the web app; Chromium runs in kiosk mode, so it shows only the portal page without tabs, an address bar, a second browser window, or noVNC controls. Log in to the portal there. The noVNC session is configured for automatic passwordless local connection.

The database data is stored in a Docker volume, so it remains available after the container stops.

To stop MySQL:

```powershell
docker compose down
```

The program creates the `coop_jobs` tables automatically if they do not exist.

## API

The API is started by `start.ps1`. Its endpoints are:

- `GET /health` to check the server and database connection.
- `GET /api/jobs` to return all scraped jobs.
- `GET /api/scraper/status` to inspect the current scraper run.
- `POST /api/scraper/scrape` to start a normal scrape.

Scrapes run in the background. Use the scraper tab to open the remote browser,
complete portal login, and monitor progress. Only one scrape can run at a time.
If jobs already exist, the Scrape action asks for confirmation before adding a
new collection to the database.

## 2. Set the connection values

Copy `.env.example` as a reference and set these environment variables in PowerShell:

```powershell
$env:MYSQL_HOST = "127.0.0.1"
$env:MYSQL_PORT = "3306"
$env:MYSQL_DATABASE = "coop_jobs"
$env:MYSQL_USER = "root"
$env:MYSQL_PASSWORD = "your_mysql_password"
```

## Local development dependencies

Install the Python dependencies once:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The Python dependencies are still useful for local scraper development. Normal
application startup runs the scraper inside the Selenium Docker service.

## Web app setup references

- [Vite Getting Started](https://vite.dev/guide/)
- [Docker Node.js container guide](https://docs.docker.com/guides/nodejs/containerize/)