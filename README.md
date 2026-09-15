# Coop Jobs Scraper

The scraper saves jobs in MySQL. It does not create JSON files.

## Project structure

```text
app/
	main.py                 Application entry point
	database/               MySQL connection and job writer
	scraper/                Selenium scraping code
	ui/                     Startup menu
server/
	app.py                  Small read-only API for jobs
	Dockerfile              API server image
database/
	schema.sql              MySQL table definitions
legacy/                   Older scripts kept for reference
docker-compose.yml        Local MySQL and API containers
```

## 1. Start everything

Install Docker Desktop and Chrome once. After that, start MySQL and the local scraper with one command:

```powershell
.\start.ps1
```

The script starts Docker Desktop, starts MySQL, waits until it is ready, and launches the local Python scraper. Selenium opens a normal Chrome window for login.

The database data is stored in a Docker volume, so it remains available after the container stops.

To stop MySQL:

```powershell
docker compose down
```

The program creates the `coop_jobs` tables automatically if they do not exist.

## 4. Start the API server

Start MySQL and the small database API container with:

```powershell
docker compose up -d --build mysql server
```

The API is available at `http://localhost:8000`. It currently exposes:

- `GET /health` to check the server and database connection.
- `GET /api/jobs` to return all scraped jobs.

The empty React web app is built with Vite and runs in the `web` Docker Compose
service at [http://localhost:5173](http://localhost:5173). Select `Open the jobs
web app` from the startup menu, or choose to open it when prompted after a
successful scrape.

## 2. Set the connection values

Copy `.env.example` as a reference and set these environment variables in PowerShell:

```powershell
$env:MYSQL_HOST = "127.0.0.1"
$env:MYSQL_PORT = "3306"
$env:MYSQL_DATABASE = "coop_jobs"
$env:MYSQL_USER = "root"
$env:MYSQL_PASSWORD = "your_mysql_password"
```

## 3. Dependencies

Install the Python dependencies once:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Log in to the portal in the Chrome window that opens. Scraped jobs are stored in the `jobs` table.

When the program starts:

- If no database exists or it is empty, choose `1` to scrape.
- If the database already contains jobs, choose `1` to scrape or `2` to open the jobs web app.

## Web app setup references

- [Vite Getting Started](https://vite.dev/guide/)
- [Docker Node.js container guide](https://docs.docker.com/guides/nodejs/containerize/)