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
    ):
        self.driver = driver
        self.search_url = search_url
        self.cancel_event = cancel_event
        self.page_callback = page_callback
        self.debug_dir = debug_dir
        self.snapshot_all = snapshot_all
        self.anomalies = 0
        self.cards_seen = 0
        self.duplicates = 0
        self.failed = []
        self.behavior = "complete"
        FakeScraper.instances.append(self)

    def run(self):
        if self.behavior == "one_page":
            self.page_callback(1, [{"job_number": "J1", "title": "Dev", "employer": "Acme"}])
        elif self.behavior == "with_accounting":
            # Mimics what a real JobPortalScraper.run() leaves behind after its own
            # end-of-run retry pass: some duplicates, one card that never recovered.
            self.cards_seen = 3
            self.duplicates = 1
            self.failed = [{"page": 2, "title": "Data Analyst Intern", "employer": "Acme"}]
            self.page_callback(1, [{"job_number": "J1", "title": "Dev", "employer": "Acme"}])
        elif self.behavior == "raise":
            raise RuntimeError("boom")
        elif self.behavior == "browser_closed":
            raise BrowserClosed("Browser window was closed.")
        elif self.behavior == "browser_closed_by_message":
            # Some Selenium failures surface as plain exceptions with a telling message
            # instead of a dedicated exception type; the runner must still recognise them.
            raise RuntimeError("invalid session id: session deleted as the browser was closed")
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


def _wait_until_not_running(runner, timeout=5):
    deadline = time.monotonic() + timeout
    while runner.is_running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not runner.is_running, "runner did not finish in time"


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
