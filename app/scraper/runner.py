"""Background thread that runs a scrape and exposes its progress/state.

Owns exactly one worker thread at a time. The worker opens its own sqlite
connection (db.connect is not thread-safe to share) and drives JobPortalScraper,
writing each finished page to the database immediately so progress is visible
while the scrape is still running.
"""

import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from selenium.common.exceptions import (
    InvalidSessionIdException,
    NoSuchWindowException,
    WebDriverException,
)

from app import config, db
from app.scraper.browser import create_driver
from app.scraper.portal import BrowserClosed, Cancelled, JobPortalScraper

logger = logging.getLogger(__name__)

_RUNNING_STATES = {"starting", "waiting_for_login", "scraping"}

_BROWSER_CLOSED_MARKERS = (
    "invalid session id",
    "not connected to devtools",
    "target window already closed",
    "no such window",
    "connection refused",
    "browser window was closed",
)


class ScraperError(Exception):
    code = "scraper_error"


class AlreadyRunning(ScraperError):
    code = "already_running"


class DatabaseNotEmpty(ScraperError):
    code = "database_not_empty"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ScrapeRunner:
    def __init__(
        self,
        db_path: Path | str,
        search_url: str,
        driver_factory: Callable = create_driver,
        debug_dir: Optional[Path] = None,
    ):
        self.db_path = db_path
        self.search_url = search_url
        self.driver_factory = driver_factory
        self.debug_dir = debug_dir
        self._lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._driver = None
        self._status = self._initial_status()

    @staticmethod
    def _initial_status() -> dict:
        return {
            "state": "idle",
            "message": "",
            "pages_completed": 0,
            "jobs_saved": 0,
            "cards_seen": 0,
            "duplicates": 0,
            "failed": 0,
            "failed_jobs": [],
            # Final failures only, set once the run (and its retry pass) is done --
            # see JobPortalScraper._retry_failed_cards and the module docstring there.
            "anomalies": 0,
            "error": None,
            "started_at": None,
            "finished_at": None,
        }

    @property
    def is_running(self) -> bool:
        with self._lock:
            return self._status["state"] in _RUNNING_STATES

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    def _update(self, **fields) -> None:
        with self._lock:
            self._status.update(fields)

    def start(self) -> dict:
        with self._lock:
            if self._status["state"] in _RUNNING_STATES:
                raise AlreadyRunning("A scrape is already running.")
            conn = db.connect(self.db_path)
            try:
                db.init_db(conn)
                if db.count_jobs(conn) > 0:
                    raise DatabaseNotEmpty("The database already has jobs in it.")
            finally:
                conn.close()

            self._cancel_event = threading.Event()
            self._status = self._initial_status()
            self._status.update(state="starting", message="Starting the scraper browser.", started_at=_now())

        self._thread = threading.Thread(target=self._run, name="scraper-worker", daemon=True)
        self._thread.start()
        return self.status()

    def cancel(self) -> dict:
        self._cancel_event.set()
        driver = self._driver
        if driver is not None:
            try:
                driver.quit()
            except WebDriverException as exc:
                logger.debug("Ignoring error while quitting the browser during cancel: %s", exc)
        return self.status()

    def _run(self) -> None:
        driver = None
        debug_dir = self.debug_dir if self.debug_dir is not None else config.DEBUG_DIR
        conn = db.connect(self.db_path)
        try:
            driver = self.driver_factory()
            self._driver = driver
            self._update(state="waiting_for_login", message="Log in to the portal in the browser window that opened.")

            def on_ready() -> None:
                self._update(state="scraping", message="Portal login detected. Scraping jobs now.")

            def on_page(page_number: int, jobs: list) -> None:
                inserted = db.insert_jobs(conn, jobs)
                with self._lock:
                    self._status["pages_completed"] += 1
                    self._status["jobs_saved"] += inserted
                    self._status["cards_seen"] = scraper.cards_seen
                    self._status["duplicates"] = scraper.duplicates
                    # Live progress only -- these are pre-retry, and the retry pass only
                    # runs once the whole portal has been paged through (see
                    # JobPortalScraper.run), so "anomalies" itself is left alone here
                    # and only set once, from the final post-retry count below.
                    self._status["failed"] = len(scraper.failed)
                    self._status["failed_jobs"] = scraper.failed[:50]
                    self._status["message"] = f"Saved page {page_number} ({inserted} job(s))."

            scraper = JobPortalScraper(
                driver,
                self.search_url,
                cancel_event=self._cancel_event,
                page_callback=on_page,
                debug_dir=debug_dir,
                snapshot_all=config.DEBUG_SNAPSHOTS,
                ready_callback=on_ready,
            )
            scraper.run()

            # scraper.run() has already completed its own end-of-run retry pass, so
            # scraper.failed/anomalies are the final, authoritative counts here --
            # not the intermediate ones on_page saw while pages were still in flight.
            failed_jobs = scraper.failed
            jobs_saved = self.status()["jobs_saved"]
            self._update(
                state="completed",
                cards_seen=scraper.cards_seen,
                duplicates=scraper.duplicates,
                failed=len(failed_jobs),
                failed_jobs=failed_jobs[:50],
                anomalies=len(failed_jobs),
                message=(
                    f"Saved {jobs_saved} of {scraper.cards_seen} jobs "
                    f"({scraper.duplicates} duplicates, {len(failed_jobs)} failed)."
                ),
                finished_at=_now(),
            )
        except Cancelled:
            self._update(state="cancelled", message="Scrape was cancelled.", finished_at=_now())
        except (BrowserClosed, InvalidSessionIdException, NoSuchWindowException):
            message = "Scrape was cancelled." if self._cancel_event.is_set() else "Browser window was closed."
            self._update(state="cancelled", message=message, finished_at=_now())
        except Exception as exc:  # noqa: BLE001 -- top-level worker boundary, must not crash the thread
            if self._cancel_event.is_set():  # cancel() quits the browser, which surfaces as a driver error
                self._update(state="cancelled", message="Scrape was cancelled.", finished_at=_now())
            elif self._is_browser_closed(exc):
                self._update(state="cancelled", message="Browser window was closed.", finished_at=_now())
            else:
                logger.exception("Scrape failed.")
                self._update(state="failed", error=str(exc), message=str(exc), finished_at=_now())
        finally:
            conn.close()
            self._driver = None
            if driver is not None:
                try:
                    driver.quit()
                except WebDriverException as exc:
                    logger.debug("Ignoring error while quitting the browser during cleanup: %s", exc)

    @staticmethod
    def _is_browser_closed(exception: Exception) -> bool:
        message = str(exception).lower()
        return any(marker in message for marker in _BROWSER_CLOSED_MARKERS)
