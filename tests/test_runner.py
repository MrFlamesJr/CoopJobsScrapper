import json
import threading
import time

import pytest

from app import db
from app.scraper.portal import BrowserClosed, Cancelled
from app.scraper.runner import AlreadyRunning, DatabaseNotEmpty, ScrapeRunner


class FakeDriver:
    def __init__(self):
        self.quit_called = False

    def quit(self):
        self.quit_called = True


class FakeScraper:
    """Stands in for JobPortalScraper: records how it was built and what run() did."""

    instances = []

    def __init__(
        self,
        driver,
        search_url,
        cancel_event=None,
        page_callback=None,
        debug_dir=None,
        snapshot_all=False,
        ready_callback=None,
        on_event=None,
    ):
        self.driver = driver
        self.search_url = search_url
        self.cancel_event = cancel_event
        self.page_callback = page_callback
        self.on_event = on_event
        self.debug_dir = debug_dir
        self.snapshot_all = snapshot_all
        self.anomalies = 0
        self.cards_seen = 0
        self.duplicates = 0
        self.failed = []
        self.behavior = "complete"
        FakeScraper.instances.append(self)

    def scrape(self, page, index, total, job):
        """One accepted job, exactly as the real portal reports it: a `scraped`
        event carrying the job (which is what the runner saves), then the page
        callback at the end of the page carrying the same jobs again."""
        self.on_event(
            {
                "type": "scraped",
                "page": page,
                "index": index,
                "total": total,
                "title": job.get("title", ""),
                "employer": job.get("employer", ""),
                "job_number": job.get("job_number", ""),
                "job": job,
            }
        )

    def run(self):
        if self.behavior == "one_page":
            job = {"job_number": "J1", "title": "Dev", "employer": "Acme"}
            self.scrape(1, 1, 1, job)
            self.page_callback(1, [job])
        elif self.behavior == "with_accounting":
            # Mimics what a real JobPortalScraper.run() leaves behind after its own
            # end-of-run retry pass: some duplicates, one card that never recovered.
            self.cards_seen = 3
            self.duplicates = 1
            self.failed = [{"page": 2, "title": "Data Analyst Intern", "employer": "Acme"}]
            job = {"job_number": "J1", "title": "Dev", "employer": "Acme"}
            self.scrape(1, 1, 3, job)
            self.page_callback(1, [job])
        elif self.behavior == "raise":
            raise RuntimeError("boom")
        elif self.behavior == "browser_closed":
            raise BrowserClosed("Browser window was closed.")
        elif self.behavior == "browser_closed_by_message":
            # Some Selenium failures surface as plain exceptions with a telling message
            # instead of a dedicated exception type; the runner must still recognise them.
            raise RuntimeError("invalid session id: session deleted as the browser was closed")
        elif self.behavior == "events":
            # The live-progress events the real portal emits, in run order.
            self.on_event({"type": "pages_found", "total_pages": 39, "cards_per_page": 20})
            self.on_event({"type": "page", "page": 1, "last_page": 39})
            self.on_event({"type": "card", "page": 1, "index": 5, "total": 20, "title": "Data Analyst"})
            self.on_event(
                {"type": "retry", "page": 1, "index": 5, "total": 20, "title": "Data Analyst",
                 "attempt": 1, "reason": "panel did not match"}
            )
            job = {"job_number": "J5", "title": "Data Analyst", "employer": "Acme"}
            self.scrape(1, 5, 20, job)
            self.on_event(
                {"type": "skipped", "page": 1, "index": 6, "total": 20, "title": "Gone",
                 "employer": "Acme", "reason": "timed out"}
            )
            self.page_callback(1, [job])
        elif self.behavior == "blank_job_numbers":
            # Jobs the unique index cannot deduplicate: they must still be inserted
            # exactly once -- by their `scraped` event, never again by on_page.
            jobs = [
                {"job_number": "", "title": "Unnumbered A", "employer": "Acme"},
                {"job_number": "", "title": "Unnumbered B", "employer": "Acme"},
            ]
            for index, job in enumerate(jobs, start=1):
                self.scrape(1, index, len(jobs), job)
            self.page_callback(1, jobs)
            # The retry pass reports its recovered jobs the same way.
            retried = {"job_number": "J9", "title": "Recovered", "employer": "Acme"}
            self.scrape(2, 1, 20, retried)
            self.page_callback(2, [retried])
        elif self.behavior == "card_then_wait":
            self.on_event({"type": "card", "page": 2, "index": 5, "total": 20, "title": "Data Analyst"})
            while not self.cancel_event.is_set():
                time.sleep(0.01)
            raise Cancelled("cancelled")
        elif self.behavior == "many_events":
            for index in range(250):
                self.on_event(
                    {"type": "retry", "page": 1, "index": index, "total": 250,
                     "title": f"Job {index}", "attempt": 1, "reason": "slow panel"}
                )
        elif self.behavior == "save_fails":
            # The same job number twice: the second insert is ignored by the unique
            # index, so the job did NOT land in the database.
            job = {"job_number": "J1", "title": "Dev", "employer": "Acme"}
            self.scrape(1, 1, 2, job)
            self.scrape(1, 2, 2, dict(job, title="Dev (again)"))
            self.page_callback(1, [job])
        elif self.behavior == "cancel_during_run":
            self.page_callback(1, [{"job_number": "J1", "title": "Dev", "employer": "Acme"}])
            # Simulate the scraper noticing the cancel Event between pages.
            while not self.cancel_event.is_set():
                time.sleep(0.01)
            raise Cancelled("cancelled")


@pytest.fixture(autouse=True)
def _reset_fake_scraper_instances():
    FakeScraper.instances = []
    yield
    FakeScraper.instances = []


def _make_runner(tmp_path, monkeypatch, behavior="complete"):
    monkeypatch.setattr("app.scraper.runner.JobPortalScraper", FakeScraper)
    db_path = tmp_path / "jobs.db"

    def driver_factory():
        driver = FakeDriver()
        return driver

    runner = ScrapeRunner(db_path=db_path, search_url="https://example.test/search", driver_factory=driver_factory)
    return runner, db_path


def _set_behavior(monkeypatch, behavior):
    """Make the next FakeScraper (built inside runner._run) use `behavior`."""
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = behavior

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)


def _wait_until_not_running(runner, timeout=5):
    deadline = time.monotonic() + timeout
    while runner.is_running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not runner.is_running, "runner did not finish in time"


def _wait_for_current_card(runner, timeout=5):
    """Block until the worker is far enough in to report the card it is scraping."""
    deadline = time.monotonic() + timeout
    while runner.status()["current"] is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert runner.status()["current"] is not None, "no card was reported in time"


def _last_run(db_path):
    conn = db.connect(db_path)
    try:
        return db.get_last_run(conn)
    finally:
        conn.close()


def test_start_raises_when_database_not_empty(tmp_path, monkeypatch):
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    conn = db.connect(db_path)
    db.init_db(conn)
    db.insert_jobs(conn, [{"job_number": "EXISTING", "title": "Old job"}])
    conn.close()

    with pytest.raises(DatabaseNotEmpty):
        runner.start()


def test_start_raises_when_already_running(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    with runner._lock:
        runner._status["state"] = "scraping"

    with pytest.raises(AlreadyRunning):
        runner.start()


def test_completed_run_saves_jobs_and_updates_status(tmp_path, monkeypatch):
    runner, db_path = _make_runner(tmp_path, monkeypatch)

    # Configure the next FakeScraper instance (created inside runner._run) to save one page.
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "one_page"

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    status = runner.start()
    assert status["state"] in {"starting", "waiting_for_login", "scraping"}
    _wait_until_not_running(runner)

    final = runner.status()
    assert final["state"] == "completed"
    assert final["pages_completed"] == 1
    assert final["jobs_saved"] == 1
    assert final["finished_at"] is not None

    conn = db.connect(db_path)
    assert db.count_jobs(conn) == 1
    conn.close()


def test_completed_run_exposes_accounting_fields(tmp_path, monkeypatch):
    """status() must surface cards_seen/duplicates/failed/failed_jobs, and
    "anomalies" must equal the FINAL (post-retry) failed count, not whatever an
    intermediate on_page callback saw while pages were still in flight."""
    runner, _ = _make_runner(tmp_path, monkeypatch)
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "with_accounting"

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    runner.start()
    _wait_until_not_running(runner)

    final = runner.status()
    assert final["state"] == "completed"
    assert final["cards_seen"] == 3
    assert final["duplicates"] == 1
    assert final["failed"] == 1
    assert final["failed_jobs"] == [{"page": 2, "title": "Data Analyst Intern", "employer": "Acme"}]
    assert final["anomalies"] == 1
    assert final["message"] == "Saved 1 of 3 jobs (1 duplicates, 1 failed)."


def test_failed_jobs_list_is_capped_at_50(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "one_page"
        self.failed = [{"page": 1, "title": f"Job {i}", "employer": "Acme"} for i in range(75)]

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    runner.start()
    _wait_until_not_running(runner)

    final = runner.status()
    assert final["failed"] == 75
    assert len(final["failed_jobs"]) == 50


def test_cancel_sets_state_to_cancelled(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "cancel_during_run"

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    runner.start()
    # Give the worker thread time to enter its "waiting for cancel" loop.
    time.sleep(0.1)
    runner.cancel()
    _wait_until_not_running(runner)

    assert runner.status()["state"] == "cancelled"


def test_cancel_reports_cancelling_before_the_worker_has_unwound(tmp_path, monkeypatch):
    """The response to an abort must already say the scrape is being aborted --
    the worker only reaches "cancelled" once its Selenium calls have failed."""
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "card_then_wait")

    runner.start()
    _wait_for_current_card(runner)
    status = runner.cancel()

    assert status["state"] == "cancelling"
    assert runner.is_running  # still unwinding: no new scrape, no clearing jobs yet
    assert status["current"] is not None  # the card being abandoned is still shown
    _wait_until_not_running(runner)
    assert runner.status()["state"] == "cancelled"


def test_a_late_running_state_cannot_undo_cancelling(tmp_path, monkeypatch):
    """on_ready can fire just after cancel(); it must not put the state back."""
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "card_then_wait")

    runner.start()
    _wait_for_current_card(runner)
    runner.cancel()
    runner._set_state("scraping", "Portal login detected. Scraping jobs now.")

    assert runner.status()["state"] == "cancelling"
    _wait_until_not_running(runner)
    assert runner.status()["state"] == "cancelled"


def test_cancel_while_idle_leaves_the_state_alone(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)

    status = runner.cancel()

    assert status["state"] == "idle"
    assert status["events"] == []


def test_browser_closed_by_user_is_reported_as_cancelled(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "browser_closed"

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    runner.start()
    _wait_until_not_running(runner)

    status = runner.status()
    assert status["state"] == "cancelled"
    assert "closed" in status["message"].lower()


def test_browser_closed_message_without_dedicated_exception_type_is_cancelled(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "browser_closed_by_message"

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    runner.start()
    _wait_until_not_running(runner)

    status = runner.status()
    assert status["state"] == "cancelled"


def test_unexpected_exception_is_reported_as_failed(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    original_init = FakeScraper.__init__

    def init_with_behavior(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.behavior = "raise"

    monkeypatch.setattr(FakeScraper, "__init__", init_with_behavior)

    runner.start()
    _wait_until_not_running(runner)

    status = runner.status()
    assert status["state"] == "failed"
    assert "boom" in status["error"]


# -- The persisted last_run record ---------------------------------------------


def test_last_run_says_running_while_the_scrape_is_in_flight(tmp_path, monkeypatch):
    """Written before the worker starts: if the app is killed now, this unfinished
    record is what tells the UI the job list is incomplete (server.py reports it
    as "interrupted")."""
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "card_then_wait")

    runner.start()
    _wait_for_current_card(runner)
    run = _last_run(db_path)
    runner.cancel()
    _wait_until_not_running(runner)

    assert run["state"] == "running"
    assert run["started_at"] is not None
    assert run["finished_at"] is None


def test_last_run_is_recorded_for_a_completed_run(tmp_path, monkeypatch):
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "one_page")

    runner.start()
    _wait_until_not_running(runner)

    run = _last_run(db_path)
    assert run["state"] == "completed"
    assert run["pages_completed"] == 1
    assert run["jobs_saved"] == 1
    assert run["started_at"] is not None
    assert run["finished_at"] is not None


def test_last_run_is_recorded_when_the_scrape_is_cancelled(tmp_path, monkeypatch):
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "cancel_during_run")

    runner.start()
    time.sleep(0.1)  # let the worker reach its "waiting for cancel" loop
    runner.cancel()
    _wait_until_not_running(runner)

    run = _last_run(db_path)
    assert run["state"] == "cancelled"
    assert run["pages_completed"] == 1
    assert run["finished_at"] is not None


def test_last_run_is_recorded_when_the_scrape_fails(tmp_path, monkeypatch):
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "raise")

    runner.start()
    _wait_until_not_running(runner)

    assert _last_run(db_path)["state"] == "failed"


def test_last_run_is_recorded_when_the_browser_never_opens(tmp_path, monkeypatch):
    """driver_factory raising is still a finished run, and must be recorded."""
    runner, db_path = _make_runner(tmp_path, monkeypatch)

    def no_browser():
        raise RuntimeError("chromedriver is missing")

    runner.driver_factory = no_browser

    runner.start()
    _wait_until_not_running(runner)

    assert runner.status()["state"] == "failed"
    assert _last_run(db_path)["state"] == "failed"


# -- Live status: on_event, the activity log, and wait_for_change ---------------


def test_jobs_are_saved_when_scraped_events_arrive_not_by_on_page(tmp_path, monkeypatch):
    """Each job is written as soon as its `scraped` event arrives, so the grid can
    show it during the run -- and on_page, which reports the same jobs again at the
    end of a page (and again for the retry pass), must not insert them a second
    time. Blank job numbers make that visible: the unique index does not cover them.
    """
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "blank_job_numbers")

    runner.start()
    _wait_until_not_running(runner)

    conn = db.connect(db_path)
    assert db.count_jobs(conn) == 3
    conn.close()
    final = runner.status()
    assert final["jobs_saved"] == 3
    assert final["pages_completed"] == 2


def test_events_track_progress_without_carrying_the_job_dict(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "events")

    runner.start()
    _wait_until_not_running(runner)

    final = runner.status()
    assert final["total_pages"] == 39
    assert final["estimated_jobs"] == 39 * 20
    assert final["retries"] == 1
    assert final["jobs_saved"] == 1
    # "current" follows the card events and is cleared once the run is over.
    assert final["current"] is None

    events = final["events"]
    assert isinstance(events, list)
    assert all(set(event) == {"time", "level", "message"} for event in events)
    assert {event["level"] for event in events} >= {"info", "warn", "error"}
    messages = [event["message"] for event in events]
    assert any("Found 39 page(s)" in message for message in messages)
    assert any("retry 1" in message for message in messages)
    assert any("skipped" in message for message in messages)
    # `card` updates `current` but must not spend a log line on every job.
    assert any(message.endswith(": saved.") for message in messages)
    assert not any("reading" in message for message in messages)
    # State changes are logged too, and the log is readable text only.
    assert any("Starting the scraper browser." == message for message in messages)
    assert any(message.startswith("Saved 1 of") for message in messages)
    assert all("job_number" not in message for message in messages)


def test_current_card_is_reported_while_the_run_is_in_flight(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "card_then_wait")

    runner.start()
    deadline = time.monotonic() + 5
    while runner.status()["current"] is None and time.monotonic() < deadline:
        time.sleep(0.01)
    current = runner.status()["current"]
    runner.cancel()
    _wait_until_not_running(runner)

    assert current == {"page": 2, "index": 5, "total": 20, "title": "Data Analyst"}


def test_card_events_update_current_and_the_version_without_logging_a_line(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "card_then_wait")
    before = runner.status()

    runner.start()
    deadline = time.monotonic() + 5
    while runner.status()["current"] is None and time.monotonic() < deadline:
        time.sleep(0.01)
    during = runner.status()
    runner.cancel()
    _wait_until_not_running(runner)

    assert during["current"]["title"] == "Data Analyst"
    assert during["version"] > before["version"]  # the UI still gets pushed the card
    assert not any("Data Analyst" in event["message"] for event in during["events"])


def test_a_job_that_does_not_reach_the_database_is_logged_as_an_error(tmp_path, monkeypatch):
    """A `scraped` event whose insert saves nothing must not be counted or
    reported as saved -- the log says why instead."""
    runner, db_path = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "save_fails")

    runner.start()
    _wait_until_not_running(runner)

    final = runner.status()
    assert final["jobs_saved"] == 1
    conn = db.connect(db_path)
    assert db.count_jobs(conn) == 1
    conn.close()

    failures = [event for event in final["events"] if "could not be saved" in event["message"]]
    assert len(failures) == 1
    assert failures[0]["level"] == "error"
    assert failures[0]["message"].startswith("p1 · 2/2 · Dev (again): could not be saved (")


def test_events_log_is_capped(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "many_events")

    runner.start()
    _wait_until_not_running(runner)

    assert len(runner.status()["events"]) == 200


def test_status_is_json_serialisable(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    _set_behavior(monkeypatch, "events")

    runner.start()
    _wait_until_not_running(runner)

    json.dumps(runner.status())  # the events deque must come back as a list


def test_wait_for_change_returns_promptly_on_change(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    version = runner.status()["version"]

    threading.Timer(0.05, lambda: runner._update(message="moved on")).start()
    started = time.monotonic()
    new_version, status = runner.wait_for_change(version, timeout=5)

    assert time.monotonic() - started < 2
    assert new_version > version
    assert status["message"] == "moved on"
    assert status["version"] == new_version


def test_wait_for_change_returns_the_same_version_on_timeout(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    version = runner.status()["version"]

    new_version, status = runner.wait_for_change(version, timeout=0.05)

    assert new_version == version
    assert status["version"] == version


def test_wait_for_change_returns_at_once_when_the_version_is_stale(tmp_path, monkeypatch):
    runner, _ = _make_runner(tmp_path, monkeypatch)
    runner._update(message="already changed")

    started = time.monotonic()
    new_version, status = runner.wait_for_change(-1, timeout=5)

    assert time.monotonic() - started < 2
    assert status["message"] == "already changed"
    assert new_version == runner.status()["version"]
