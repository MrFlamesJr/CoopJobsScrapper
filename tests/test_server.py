import json
import sqlite3
import threading
from pathlib import Path

import pytest

from app import config, db
from app.server import create_app


class FakeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class FakeRunner:
    def __init__(self):
        self.is_running = False
        self.start_error: Exception | None = None
        self.cancel_calls = 0
        self._changed = threading.Event()
        self._status = {
            "state": "idle",
            "message": "",
            "pages_completed": 0,
            "jobs_saved": 0,
            "anomalies": 0,
            "events": [],
            "version": 1,
            "error": None,
            "started_at": None,
            "finished_at": None,
        }

    def start(self):
        if self.start_error is not None:
            raise self.start_error
        self.is_running = True
        self._status["state"] = "scraping"
        return dict(self._status)

    def cancel(self):
        self.cancel_calls += 1
        self.is_running = False
        self._status["state"] = "cancelled"
        return dict(self._status)

    def status(self):
        return dict(self._status)

    def wait_for_change(self, last_version, timeout=15.0):
        """Same contract as ScrapeRunner.wait_for_change: blocks until something
        changes, and returns the unchanged version once `timeout` passes."""
        self._changed.wait(timeout)
        return self._status["version"], dict(self._status)


@pytest.fixture
def runner():
    return FakeRunner()


@pytest.fixture
def app(tmp_path, runner):
    db_path = tmp_path / "jobs.db"
    setup_conn = db.connect(db_path)
    db.init_db(setup_conn)
    setup_conn.close()
    flask_app = create_app(db_path, runner=runner)
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def seed(app):
    def _seed(jobs):
        conn = db.connect(app.config["DB_PATH"])
        inserted = db.insert_jobs(conn, jobs)
        conn.close()
        return inserted

    return _seed


def make_job(**overrides):
    job = {
        "job_number": "J1",
        "title": "Software Developer",
        "employer": "Acme",
        "location": "Ottawa, ON",
        "duration": "4 months",
        "work_model": "Hybrid",
        "term": "Winter 2026",
        "round": "Round 1",
        "salary": "$20/hr",
        "deadline_text": "",
        "description": "Build things",
        "requirements": ["Python"],
        "qualifications": [{"name": "Year", "value": "3rd"}],
        "page_number": 1,
    }
    job.update(overrides)
    return job


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


def test_list_jobs_empty(client):
    resp = client.get("/api/jobs")
    assert resp.status_code == 200
    assert resp.get_json() == {"jobs": [], "total": 0}


def test_list_jobs_with_query_and_total(client, seed):
    seed([make_job(job_number="1", title="Backend Dev"), make_job(job_number="2", title="Frontend Dev")])
    resp = client.get("/api/jobs", query_string={"q": "backend"})
    data = resp.get_json()
    assert data["total"] == 2
    assert len(data["jobs"]) == 1
    assert data["jobs"][0]["title"] == "Backend Dev"


def test_list_jobs_without_q_has_no_match_key(client, seed):
    seed([make_job(job_number="1")])
    resp = client.get("/api/jobs")
    assert "match" not in resp.get_json()["jobs"][0]


def test_list_jobs_with_query_includes_match(client, seed):
    seed(
        [
            make_job(
                job_number="1",
                title="Backend Dev",
                description="Build things",
                requirements=[],
                qualifications=[],
            )
        ]
    )
    resp = client.get("/api/jobs", query_string={"q": "backend"})
    job = resp.get_json()["jobs"][0]
    assert job["match"] == {"fields": ["title"], "snippet": None}


def test_list_jobs_with_query_includes_description_snippet(client, seed):
    seed(
        [
            make_job(
                job_number="1",
                title="Backend Dev",
                description="Requires strong Python skills",
                requirements=[],
                qualifications=[],
            )
        ]
    )
    resp = client.get("/api/jobs", query_string={"q": "python"})
    job = resp.get_json()["jobs"][0]
    assert job["match"]["fields"] == ["description"]
    assert job["match"]["snippet"]["field"] == "description"
    assert "Python" in job["match"]["snippet"]["text"]
    for column in ("round", "salary", "description", "requirements", "qualifications"):
        assert column not in job


def test_list_jobs_with_filters_and_sort(client, seed):
    seed(
        [
            make_job(job_number="1", employer="Acme", title="B"),
            make_job(job_number="2", employer="Beta", title="A"),
        ]
    )
    resp = client.get("/api/jobs", query_string=[("employer", "Acme"), ("sort", "title")])
    data = resp.get_json()
    assert [job["job_number"] for job in data["jobs"]] == ["1"]


def test_get_job_detail_found(client, seed):
    seed([make_job(job_number="1")])
    resp = client.get("/api/jobs")
    job_id = resp.get_json()["jobs"][0]["id"]
    detail = client.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200
    body = detail.get_json()
    assert body["job_number"] == "1"
    assert body["requirements"] == ["Python"]
    assert "search_text" not in body


def test_get_job_detail_not_found(client):
    resp = client.get("/api/jobs/999")
    assert resp.status_code == 404
    assert resp.get_json()["error"] == "not_found"


def test_facets(client, seed):
    seed([make_job(job_number="1", employer="Acme"), make_job(job_number="2", employer="Acme")])
    resp = client.get("/api/facets")
    data = resp.get_json()
    assert {"value": "Acme", "count": 2} in data["employer"]


def test_delete_jobs_clears_and_returns_count(client, seed):
    seed([make_job(job_number="1"), make_job(job_number="2")])
    resp = client.delete("/api/jobs")
    assert resp.status_code == 200
    assert resp.get_json() == {"deleted": 2}
    assert client.get("/api/jobs").get_json()["total"] == 0


def test_delete_jobs_blocked_while_scraping(client, runner):
    runner.is_running = True
    resp = client.delete("/api/jobs")
    assert resp.status_code == 409
    assert resp.get_json()["error"] == "scrape_running"


def test_scraper_status_includes_job_count_and_last_scraped(client, seed):
    seed([make_job(job_number="1")])
    resp = client.get("/api/scraper/status")
    data = resp.get_json()
    assert data["state"] == "idle"
    assert data["job_count"] == 1
    assert data["last_scraped_at"] is not None


def _write_last_run(app, **overrides):
    run = {
        "state": "cancelled",
        "started_at": "2026-01-10T12:00:00+00:00",
        "finished_at": "2026-01-10T12:04:30+00:00",
        "pages_completed": 3,
        "total_pages": 39,
        "jobs_saved": 57,
    }
    run.update(overrides)
    conn = db.connect(app.config["DB_PATH"])
    db.set_last_run(conn, run)
    conn.close()
    return run


def test_scraper_status_last_run_is_null_without_a_record(client):
    assert client.get("/api/scraper/status").get_json()["last_run"] is None


def test_scraper_status_includes_the_last_run(client, app):
    run = _write_last_run(app)
    data = client.get("/api/scraper/status").get_json()
    assert data["last_run"] == run


def test_a_stale_running_last_run_is_reported_as_interrupted(client, app, runner):
    """Nothing is running, so the record will never be finished: the app was killed
    mid-scrape. Only the report changes -- the stored row is left alone."""
    _write_last_run(app, state="running", finished_at=None)
    runner.is_running = False

    data = client.get("/api/scraper/status").get_json()
    assert data["last_run"]["state"] == "interrupted"
    assert data["last_run"]["pages_completed"] == 3

    conn = db.connect(app.config["DB_PATH"])
    assert db.get_last_run(conn)["state"] == "running"
    conn.close()


def test_a_running_last_run_stays_running_while_the_scrape_runs(client, app, runner):
    _write_last_run(app, state="running", finished_at=None)
    runner.is_running = True

    data = client.get("/api/scraper/status").get_json()
    assert data["last_run"]["state"] == "running"


def test_scraper_start_success(client):
    resp = client.post("/api/scraper/start")
    assert resp.status_code == 202
    assert resp.get_json()["state"] == "scraping"


def test_scraper_start_blocked_when_database_not_empty(client, seed):
    seed([make_job(job_number="1")])
    resp = client.post("/api/scraper/start")
    assert resp.status_code == 409
    assert resp.get_json()["error"] == "database_not_empty"


def test_scraper_start_propagates_runner_error_code(client, runner):
    runner.start_error = FakeError("already_running", "A scrape is already running.")
    resp = client.post("/api/scraper/start")
    assert resp.status_code == 409
    body = resp.get_json()
    assert body["error"] == "already_running"
    assert body["message"] == "A scrape is already running."


def test_scraper_start_reraises_unexpected_errors(client, runner):
    runner.start_error = RuntimeError("boom")
    with pytest.raises(RuntimeError):
        client.post("/api/scraper/start")


def test_scraper_cancel(client, runner):
    resp = client.post("/api/scraper/cancel")
    assert resp.status_code == 200
    assert resp.get_json()["state"] == "cancelled"
    assert runner.cancel_calls == 1


def test_scraper_stream_sends_the_full_status_first(client, seed):
    """Only the first message is read: the stream stays open forever by design, so
    draining it would hang the test."""
    seed([make_job(job_number="1")])
    resp = client.get("/api/scraper/stream", buffered=False)
    assert resp.status_code == 200
    assert resp.mimetype == "text/event-stream"
    assert resp.headers["Cache-Control"] == "no-cache"
    assert resp.headers["X-Accel-Buffering"] == "no"

    chunk = next(resp.iter_encoded())
    resp.close()

    assert chunk.startswith(b"data: ")
    payload = json.loads(chunk[len(b"data: ") :])
    assert payload["state"] == "idle"
    assert payload["job_count"] == 1
    assert payload["last_scraped_at"] is not None


def test_scraper_stream_sends_a_whole_snapshot_on_every_change(client, runner):
    resp = client.get("/api/scraper/stream", buffered=False)
    stream = resp.iter_encoded()
    next(stream)  # the initial snapshot

    runner._status.update(state="scraping", message="Scraping page 3 of 39.", version=2)
    runner._changed.set()
    chunk = next(stream)
    resp.close()

    payload = json.loads(chunk[len(b"data: ") :])
    assert payload["state"] == "scraping"
    assert payload["message"] == "Scraping page 3 of 39."
    assert payload["job_count"] == 0  # every message is the full status


def test_scraper_stream_pings_when_nothing_changes(client, monkeypatch):
    monkeypatch.setattr("app.server.STREAM_PING_SECONDS", 0.05)
    resp = client.get("/api/scraper/stream", buffered=False)
    stream = resp.iter_encoded()
    next(stream)

    chunk = next(stream)
    resp.close()

    assert chunk == b": ping\n\n"


def test_scraper_stream_closes_its_own_connection_when_the_client_goes_away(client, monkeypatch):
    """The generator outlives the request context, so it owns its connection -- and
    must close it when the browser disconnects."""
    opened = []
    real_connect = db.connect

    def tracking_connect(path):
        conn = real_connect(path)
        opened.append(conn)
        return conn

    monkeypatch.setattr(db, "connect", tracking_connect)

    resp = client.get("/api/scraper/stream", buffered=False)
    next(resp.iter_encoded())
    resp.close()

    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError):
        opened[0].execute("SELECT 1")


def test_favorites_add_list_and_remove(client, seed):
    seed([make_job(job_number="1", title="Backend Dev")])
    assert client.get("/api/favorites").get_json() == {"favorites": []}

    added = client.put("/api/favorites/1")
    assert added.status_code == 200
    favorites = added.get_json()["favorites"]
    assert len(favorites) == 1
    assert favorites[0]["job_number"] == "1"
    assert favorites[0]["job"]["title"] == "Backend Dev"

    # idempotent
    assert client.put("/api/favorites/1").status_code == 200
    assert len(client.get("/api/favorites").get_json()["favorites"]) == 1

    removed = client.delete("/api/favorites/1")
    assert removed.status_code == 200
    assert removed.get_json() == {"favorites": []}


def test_favorites_add_unknown_job_is_404(client):
    resp = client.put("/api/favorites/nope")
    assert resp.status_code == 404
    assert resp.get_json()["error"] == "not_found"


def test_favorites_order_route_is_gone(client, seed):
    seed([make_job(job_number="1")])
    client.put("/api/favorites/1")
    resp = client.put("/api/favorites/order", json={"ordered": ["1"]})
    assert resp.status_code == 404


def test_favorites_survive_delete_all_jobs(client, seed):
    seed([make_job(job_number="1", title="Backend Dev")])
    client.put("/api/favorites/1")
    client.delete("/api/jobs")

    favorites = client.get("/api/favorites").get_json()["favorites"]
    assert len(favorites) == 1
    assert favorites[0]["job"] is None
    assert favorites[0]["title"] == "Backend Dev"


def test_export_json(client, seed):
    seed([make_job(job_number="1")])
    resp = client.get("/api/export/json")
    assert resp.status_code == 200
    assert "attachment" in resp.headers["Content-Disposition"]
    assert "coop-jobs.json" in resp.headers["Content-Disposition"]
    data = json.loads(resp.data)
    assert "exported_at" in data
    assert len(data["jobs"]) == 1
    assert data["jobs"][0]["job_number"] == "1"


def test_unknown_api_route_is_404(client):
    resp = client.get("/api/does-not-exist")
    assert resp.status_code == 404
    assert resp.get_json()["error"] == "not_found"


def test_spa_missing_dist_returns_hint(client, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WEB_DIST_DIR", tmp_path / "nonexistent")
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"npm run build" in resp.data


def test_spa_serves_index_and_assets_and_fallback(client, monkeypatch, tmp_path):
    dist_dir = tmp_path / "dist"
    (dist_dir / "assets").mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>SPA shell</html>", encoding="utf-8")
    (dist_dir / "assets" / "app.js").write_text("console.log('hi')", encoding="utf-8")
    monkeypatch.setattr(config, "WEB_DIST_DIR", dist_dir)

    root = client.get("/")
    assert root.status_code == 200
    assert b"SPA shell" in root.data

    asset = client.get("/assets/app.js")
    assert asset.status_code == 200
    assert b"console.log" in asset.data

    fallback = client.get("/some/client/route")
    assert fallback.status_code == 200
    assert b"SPA shell" in fallback.data
