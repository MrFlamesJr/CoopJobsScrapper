import logging
import os
import subprocess
import threading
import uuid
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

from app.database.mysql_database import MySQLDatabase
from app.database.mysql_job_writer import MySQLJobWriter
from app.scraper.browser_status_monitor import BrowserStatusMonitor
from app.scraper.job_portal_scraper import JobPortalScraper


SEARCH_URL = "https://experiential-learning.uottawa.ca/search"
DATABASE_NAME = "coop_jobs"


class ScraperController:
    """Run at most one scraper job and expose its state to the web API."""

    def __init__(self, database, logger=None, webdriver_factory=None, search_url=SEARCH_URL):
        self.database = database
        self.logger = logger or logging.getLogger("job_scraper")
        self.webdriver_factory = webdriver_factory or create_webdriver
        self.search_url = search_url
        self._lock = threading.Lock()
        self._status = {
            "state": "login_required",
            "run_id": None,
            "mode": None,
            "ready_for_scrape": False,
            "pages_completed": 0,
            "jobs_saved": 0,
            "message": "Portal login is required before scraping.",
            "steps": [
                "Click Scrape to open the contained portal browser.",
                "Sign in to the portal.",
                "Leave the jobs page visible; scraping starts automatically.",
            ],
            "error": None,
        }

    def status(self):
        with self._lock:
            return dict(self._status)

    def start(self, mode="scrape"):
        if mode != "scrape":
            raise ValueError("Unknown scrape mode.")

        with self._lock:
            if self._status["state"] in {"starting", "waiting_for_login", "scraping", "completed"}:
                if self._status["state"] != "completed":
                    raise RuntimeError("A scrape is already running.")
            run_id = str(uuid.uuid4())
            self._status = {
                "state": "starting",
                "run_id": run_id,
                "mode": mode,
                "ready_for_scrape": False,
                "pages_completed": 0,
                "jobs_saved": 0,
                "message": "Starting the scraper browser.",
                "steps": [
                    "The contained portal browser is opening.",
                    "Sign in when the portal login appears.",
                    "Leave the jobs page visible so scraping can continue.",
                ],
                "error": None,
            }

        thread = threading.Thread(target=self._run, args=(mode, run_id), name="scraper-worker", daemon=True)
        thread.start()
        return self.status()

    def _run(self, mode, run_id):
        driver = None
        browser_monitor = None
        output_writer = None
        completed = False
        try:
            self.database.ensure()

            output_writer = MySQLJobWriter(
                host=self.database.host,
                port=self.database.port,
                database=self.database.database,
                user=self.database.user,
                password=self.database.password,
                search_url=self.search_url,
            )
            self._update(
                run_id,
                state="waiting_for_login",
                message="Log in using the scraper browser, then leave the jobs page open.",
                steps=[
                    "The portal browser is open.",
                    "Sign in to the portal.",
                    "Keep the jobs page open; scraping starts when jobs are visible.",
                ],
            )
            driver = self.webdriver_factory()
            browser_monitor = BrowserStatusMonitor(driver, self.logger)
            browser_monitor.start()
            scraper = JobPortalScraper(
                driver,
                output_writer,
                self.logger,
                self.search_url,
                browser_monitor,
                progress_callback=lambda **details: self._progress(run_id, **details),
            )
            scraper.run()
            completed = True
            self._update(
                run_id,
                state="completed",
                ready_for_scrape=False,
                message="Scrape completed successfully.",
                steps=["Review the saved jobs or start another scrape when needed."],
            )
        except Exception as exc:
            self.logger.exception("Scrape failed: %s", exc)
            state = "stopped" if "browser" in str(exc).lower() else "failed"
            self._update(
                run_id,
                state=state,
                ready_for_scrape=False,
                message=str(exc),
                steps=["Check the browser and portal login, then start another scrape."],
                error=str(exc),
            )
        finally:
            if output_writer is not None:
                output_writer.close(completed=completed)
            if browser_monitor is not None:
                browser_monitor.close_browser()
            elif driver is not None:
                try:
                    driver.quit()
                except WebDriverException:
                    self.logger.warning("The scraper browser was already closed.")

    def _progress(self, run_id, **details):
        event = details.pop("event", None)
        with self._lock:
            details["jobs_saved"] = self._status.get("jobs_saved", 0) + details.get("jobs_saved", 0)
        updates = {"state": "scraping", "ready_for_scrape": True, **details}
        if event == "portal_ready":
            updates.update(
                message="Portal login detected. Scraping jobs now.",
                steps=[
                    "Portal login is complete.",
                    "Scraping the visible job pages.",
                    "Keep the browser open until the run finishes.",
                ],
            )
        self._update(run_id, **updates)

    def _update(self, run_id, **updates):
        with self._lock:
            if self._status.get("run_id") == run_id:
                self._status.update(updates)


def create_webdriver():
    options = Options()
    options.add_argument("--kiosk")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    selenium_url = os.getenv("SELENIUM_URL")
    if selenium_url:
        return webdriver.Remote(command_executor=selenium_url, options=options)
    creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    return webdriver.Chrome(options=options, service=Service(popen_kw={"creation_flags": creation_flags}))


def create_database():
    return MySQLDatabase(
        host=os.environ.get("MYSQL_HOST", "127.0.0.1"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        database=os.environ.get("MYSQL_DATABASE", DATABASE_NAME),
        user=os.environ["MYSQL_USER"],
        password=os.environ["MYSQL_PASSWORD"],
        schema_path=Path(__file__).resolve().parents[2] / "database" / "schema.sql",
    )