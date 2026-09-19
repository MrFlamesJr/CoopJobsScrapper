import json
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
        self._status = {
            "state": "idle",
            "message": "",
            "pages_completed": 0,
            "jobs_saved": 0,
            "anomalies": 0,
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
