"""Flask app: JSON API for the scraped jobs plus static hosting of the built UI."""

import json as jsonlib
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_from_directory
from werkzeug.utils import safe_join

from app import config, db

logger = logging.getLogger(__name__)


def create_app(db_path, runner=None) -> Flask:
    app = Flask(__name__)
    app.config["DB_PATH"] = Path(db_path)

    if runner is None:
        from app.scraper.runner import ScrapeRunner

        runner = ScrapeRunner(db_path=db_path, search_url=config.SEARCH_URL)
    app.extensions["runner"] = runner

    def get_conn() -> sqlite3.Connection:
        if "db" not in g:
            g.db = db.connect(app.config["DB_PATH"])
        return g.db

    @app.teardown_appcontext
    def close_conn(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    def error(code: str, message: str, status: int):
        return jsonify({"error": code, "message": message}), status

    @app.errorhandler(404)
    def handle_not_found(_exc):
        return error("not_found", "No such route.", 404)

    @app.errorhandler(500)
    def handle_server_error(_exc):
        logger.exception("Unhandled error handling %s %s", request.method, request.path)
        return error("internal_error", "Something went wrong.", 500)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @app.get("/api/jobs")
    def list_jobs():
        conn = get_conn()
        filters = {
            field: values
            for field in db.FACET_FIELDS
            if (values := request.args.getlist(field))
        }
        jobs = db.query_jobs(
            conn,
            q=request.args.get("q", ""),
            filters=filters,
            deadline=request.args.get("deadline") or None,
            sort=request.args.get("sort", "deadline"),
        )
        return jsonify({"jobs": jobs, "total": db.count_jobs(conn)})

    @app.get("/api/jobs/<int:job_id>")
    def get_job_detail(job_id: int):
        job = db.get_job(get_conn(), job_id)
        if job is None:
            return error("not_found", "No job with that id.", 404)
        return jsonify(job)

    @app.get("/api/facets")
    def facets():
        return jsonify(db.get_facets(get_conn()))

    @app.delete("/api/jobs")
    def delete_jobs():
        if runner.is_running:
            return error("scrape_running", "Cannot clear jobs while a scrape is running.", 409)
        conn = get_conn()
        deleted = db.count_jobs(conn)
        db.clear_jobs(conn)
        return jsonify({"deleted": deleted})

    @app.get("/api/scraper/status")
    def scraper_status():
        conn = get_conn()
        status = runner.status()
        status["job_count"] = db.count_jobs(conn)
        status["last_scraped_at"] = db.last_scraped_at(conn)
        return jsonify(status)

    @app.post("/api/scraper/start")
    def scraper_start():
        conn = get_conn()
        if db.count_jobs(conn) > 0:
            return error("database_not_empty", "Clear the existing jobs before scraping again.", 409)
        try:
            status = runner.start()
        except Exception as exc:  # noqa: BLE001 - duck-typed ScraperError from runner
            code = getattr(exc, "code", None)
            if code is None:
                raise
            return error(code, str(exc), 409)
        return jsonify(status), 202

    @app.post("/api/scraper/cancel")
    def scraper_cancel():
        return jsonify(runner.cancel())

    @app.get("/api/export/json")
    def export_json():
        conn = get_conn()
        payload = {
            "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "jobs": db.export_jobs(conn),
        }
        return Response(
            jsonlib.dumps(payload),
            mimetype="application/json",
            headers={"Content-Disposition": "attachment; filename=coop-jobs.json"},
        )

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def serve_spa(path: str):
        if path.startswith("api/"):
            return error("not_found", "No such API route.", 404)

        dist_dir = config.WEB_DIST_DIR
        if not dist_dir.is_dir():
            return Response(
                "web UI is not built; run `npm run build` in web/\n",
                mimetype="text/plain",
            )

        safe_path = path and safe_join(str(dist_dir), path)
        if safe_path and Path(safe_path).is_file():
            return send_from_directory(dist_dir, path)
        return send_from_directory(dist_dir, "index.html")

    return app
