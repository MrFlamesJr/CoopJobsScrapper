"""Background thread that runs a scrape and exposes its progress/state.

Owns exactly one worker thread at a time. The worker opens its own sqlite
connection (db.connect is not thread-safe to share) and drives JobPortalScraper,
writing each job to the database as soon as its `scraped` event arrives, so the
UI can watch jobs come in while the scrape is still running.

Every status change bumps `version` and notifies a threading.Condition, so a
reader can block on wait_for_change() instead of polling -- that is what the
/api/scraper/stream SSE route in server.py streams to the browser.
"""

import logging
import sqlite3
import threading
from collections import deque
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

# "cancelling" counts as running: the worker is still unwinding, so starting a new
# scrape (or clearing the jobs) stays blocked until it reaches "cancelled".
_RUNNING_STATES = {"starting", "waiting_for_login", "scraping", "cancelling"}

# How many lines of the human-readable activity log are kept (oldest dropped).
EVENT_LOG_MAX = 200

# Level for the `events` log, per portal event type; anything else is "info".
_EVENT_LEVELS = {"retry": "warn", "skipped": "error"}

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


def _event_message(event: dict, save_error: str = "") -> str:
    """One short, readable line for the `events` log.

    Deliberately never includes the `job` dict a `scraped` event carries: the log
    is meant to be read, and the job itself is already on its way to the database.
    `save_error` turns a `scraped` line into the reason the job did NOT land in
    the database (see ScrapeRunner._run's save_job).
    """
    kind = event.get("type", "")
    where = f"p{event.get('page')} · {event.get('index')}/{event.get('total')} · {event.get('title', '')}"
    if kind == "pages_found":
        total_pages = event.get("total_pages")
        if total_pages is None:
            return "Could not read the portal's page count; scraping anyway."
        return f"Found {total_pages} page(s), {event.get('cards_per_page') or 0} job(s) per page."
    if kind == "page":
        last_page = event.get("last_page")
        return f"Scraping page {event.get('page')}" + (f" of {last_page}." if last_page else ".")
    if kind == "retry_pass":
        return f"Retrying {event.get('cards')} skipped card(s) across {event.get('pages')} page(s)."
    if kind == "scraped":
        if save_error:
            return f"{where}: could not be saved ({save_error[:120]})."
        return f"{where}: saved."
    if kind == "retry":
        return f"{where}: retry {event.get('attempt')} ({event.get('reason', '')[:120]})."
    if kind == "skipped":
        return f"{where}: skipped ({event.get('reason', '')[:120]})."
    return kind or "event"


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
        # A Condition, not a plain Lock, so readers can block on wait_for_change();
        # it still guards self._status exactly like the Lock it replaced.
        self._lock = threading.Condition()
        self._version = 0
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
            "retries": 0,
            # Live progress: the card being scraped right now, the portal's page
            # count read up front, and total_pages x cards-on-page-1. The last two
            # stay None when the portal's pager could not be read.
            "current": None,
            "total_pages": None,
            "estimated_jobs": None,
            "events": deque(maxlen=EVENT_LOG_MAX),
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
            return self._snapshot()

    def wait_for_change(self, last_version: int, timeout: float = 15.0) -> tuple[int, dict]:
        """Block until the status changes, then return (version, snapshot).

        Returns at once when `last_version` is already out of date, and returns the
        unchanged version and snapshot when `timeout` passes with no change (the
        SSE route turns that into a heartbeat).
        """
        with self._lock:
            if self._version == last_version:
                self._lock.wait(timeout)
            return self._version, self._snapshot()

    def _snapshot(self) -> dict:
        """JSON-serialisable copy of the status. The lock must be held."""
        snapshot = dict(self._status)
        snapshot["events"] = list(snapshot["events"])
        snapshot["version"] = self._version
        return snapshot

    def _bump(self) -> None:
        """Mark the status as changed and wake wait_for_change. Lock must be held."""
        self._version += 1
        self._lock.notify_all()

    def _append_event(self, message: str, level: str = "info") -> None:
        """Add one line to the activity log. Lock must be held."""
        self._status["events"].append({"time": _now(), "level": level, "message": message})

    def _update(self, **fields) -> None:
        with self._lock:
            self._status.update(fields)
            self._bump()

    def _set_state(self, state: str, message: str, level: str = "info", **fields) -> None:
        """Like _update, but for a state change: the message is logged to `events`
        too, so the activity log tells the whole story of the run."""
        with self._lock:
            if state in _RUNNING_STATES and self._status["state"] == "cancelling":
                # An abort is already under way; a running state arriving late (an
                # on_ready fired while cancel() ran) must not undo it. Terminal
                # states still apply -- that is how the run ends.
                return
            self._status.update(state=state, message=message, **fields)
            if state not in _RUNNING_STATES:
                self._status["current"] = None  # nothing is being scraped any more
            self._append_event(message, level)
            self._bump()

    def _save_last_run(self, conn: sqlite3.Connection, state: str) -> None:
        """Persist the run under `state` ("running" until it ends), so the UI still
        knows an aborted or interrupted run left an incomplete job list behind,
        even after a restart. A database problem here must never fail the run."""
        status = self.status()
        try:
            db.set_last_run(
                conn,
                {
                    "state": state,
                    "started_at": status["started_at"],
                    "finished_at": status["finished_at"],
                    "pages_completed": status["pages_completed"],
                    "total_pages": status["total_pages"],
                    "jobs_saved": status["jobs_saved"],
                },
            )
        except sqlite3.Error as exc:
            logger.warning("Could not record the last run: %s", exc)

    def start(self) -> dict:
        with self._lock:
            if self._status["state"] in _RUNNING_STATES:
                raise AlreadyRunning("A scrape is already running.")
            conn = db.connect(self.db_path)
            try:
                db.init_db(conn)
                if db.count_jobs(conn) > 0:
                    raise DatabaseNotEmpty("The database already has jobs in it.")

                self._cancel_event = threading.Event()
                self._status = self._initial_status()
                self._status.update(
                    state="starting", message="Starting the scraper browser.", started_at=_now()
                )
                self._append_event(self._status["message"])
                self._bump()
                # Recorded before the worker starts: if the app is killed mid-scrape,
                # this unfinished record is all that says the job list is incomplete.
                self._save_last_run(conn, "running")
            finally:
                conn.close()

        self._thread = threading.Thread(target=self._run, name="scraper-worker", daemon=True)
        self._thread.start()
        return self.status()

    def cancel(self) -> dict:
        self._cancel_event.set()
        with self._lock:
            # Say so before the driver is quit, so the snapshot this returns (and the
            # SSE stream) already reads "cancelling" instead of "scraping"; the worker
            # only reaches "cancelled" once it has unwound, seconds later.
            if self._status["state"] in _RUNNING_STATES:
                self._set_state("cancelling", "Aborting the scrape.", level="warn")
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
            self._set_state(
                "waiting_for_login", "Log in to the portal in the browser window that opened."
            )

            def on_ready() -> None:
                self._set_state("scraping", "Portal login detected. Scraping jobs now.")

            def sync_accounting() -> None:
                """Copy the scraper's own counters into the status. Lock must be held.

                Live progress only -- these are pre-retry, and the retry pass only runs
                once the whole portal has been paged through (see JobPortalScraper.run),
                so "anomalies" is left alone here and only set once, from the final
                post-retry count below.
                """
                self._status["cards_seen"] = scraper.cards_seen
                self._status["duplicates"] = scraper.duplicates
                self._status["failed"] = len(scraper.failed)
                self._status["failed_jobs"] = scraper.failed[:50]

            def save_job(job: dict) -> str:
                """Write one freshly scraped job on the worker's own connection.

                Returns "" when the row landed, otherwise why it did not -- the
                scrape carries on either way, but the activity log must say so
                instead of claiming the job was saved.
                """
                try:
                    if db.insert_jobs(conn, [job]) == 1:
                        return ""
                    # The portal's own duplicate check already ran, so this is the
                    # unique index rejecting a job number we thought was new.
                    return "the database already has that job number"
                except sqlite3.Error as exc:
                    logger.warning("Could not save job %r: %s", job.get("job_number", ""), exc)
                    return str(exc)

            def on_event(event: dict) -> None:
                """Live progress from the scraper: keep the counters and the activity
                log, and save each accepted job right away so the grid can show jobs
                arriving during the scrape."""
                kind = event.get("type", "")
                save_error = save_job(event["job"]) if kind == "scraped" and event.get("job") else ""
                with self._lock:
                    if kind == "pages_found":
                        total_pages = event.get("total_pages")
                        cards_per_page = event.get("cards_per_page") or 0
                        self._status["total_pages"] = total_pages
                        self._status["estimated_jobs"] = (
                            total_pages * cards_per_page if total_pages and cards_per_page else None
                        )
                    elif kind == "card":
                        self._status["current"] = {
                            "page": event.get("page"),
                            "index": event.get("index"),
                            "total": event.get("total"),
                            "title": event.get("title", ""),
                        }
                    elif kind == "scraped":
                        if not save_error:
                            self._status["jobs_saved"] += 1
                    elif kind == "retry":
                        self._status["retries"] += 1
                    sync_accounting()
                    if kind != "card":
                        # `card` is live status only (`current` above): logging it too
                        # would spend two of the 200 lines on every single job.
                        level = "error" if save_error else _EVENT_LEVELS.get(kind, "info")
                        self._append_event(_event_message(event, save_error), level)
                    self._bump()

            def on_page(page_number: int, jobs: list) -> None:
                # Page counters only: every job here was already written to the
                # database by its own `scraped` event, in the main sweep and in the
                # retry pass alike. Inserting again would duplicate any job with a
                # blank job number, which the unique index does not cover.
                with self._lock:
                    self._status["pages_completed"] += 1
                    sync_accounting()
                    self._status["message"] = f"Finished page {page_number} ({len(jobs)} job(s))."
                    self._bump()

            scraper = JobPortalScraper(
                driver,
                self.search_url,
                cancel_event=self._cancel_event,
                page_callback=on_page,
                debug_dir=debug_dir,
                snapshot_all=config.DEBUG_SNAPSHOTS,
                ready_callback=on_ready,
                on_event=on_event,
            )
            scraper.run()

            # scraper.run() has already completed its own end-of-run retry pass, so
            # scraper.failed/anomalies are the final, authoritative counts here --
            # not the intermediate ones on_page saw while pages were still in flight.
            failed_jobs = scraper.failed
            jobs_saved = self.status()["jobs_saved"]
            self._set_state(
                "completed",
                (
                    f"Saved {jobs_saved} of {scraper.cards_seen} jobs "
                    f"({scraper.duplicates} duplicates, {len(failed_jobs)} failed)."
                ),
                cards_seen=scraper.cards_seen,
                duplicates=scraper.duplicates,
                failed=len(failed_jobs),
                failed_jobs=failed_jobs[:50],
                anomalies=len(failed_jobs),
                finished_at=_now(),
            )
        except Cancelled:
            self._set_state("cancelled", "Scrape was cancelled.", level="warn", finished_at=_now())
        except (BrowserClosed, InvalidSessionIdException, NoSuchWindowException):
            message = "Scrape was cancelled." if self._cancel_event.is_set() else "Browser window was closed."
            self._set_state("cancelled", message, level="warn", finished_at=_now())
        except Exception as exc:  # noqa: BLE001 -- top-level worker boundary, must not crash the thread
            if self._cancel_event.is_set():  # cancel() quits the browser, which surfaces as a driver error
                self._set_state("cancelled", "Scrape was cancelled.", level="warn", finished_at=_now())
            elif self._is_browser_closed(exc):
                self._set_state("cancelled", "Browser window was closed.", level="warn", finished_at=_now())
            else:
                logger.exception("Scrape failed.")
                self._set_state("failed", str(exc), level="error", error=str(exc), finished_at=_now())
        finally:
            # One write for every way the run can end -- including a driver_factory
            # that never returned a browser: every branch above has already set its
            # terminal state, so this records the run as it really finished.
            self._save_last_run(conn, self.status()["state"])
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
