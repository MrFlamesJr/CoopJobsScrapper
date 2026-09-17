import os

import mysql.connector
from flask import Flask, jsonify

from app.scraper.controller import ScraperController, create_database
from typing import Any, cast


app = Flask(__name__)


@app.after_request
def allow_web_app_requests(response):
    response.headers["Access-Control-Allow-Origin"] = "http://localhost:5300"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def database_config():
    return {
        "host": os.getenv("MYSQL_HOST", "mysql"),
        "port": int(os.getenv("MYSQL_PORT", "3306")),
        "database": os.getenv("MYSQL_DATABASE", "coop_jobs"),
        "user": os.getenv("MYSQL_USER", "root"),
        "password": os.getenv("MYSQL_PASSWORD", "rootpassword"),
    }


database = create_database()
scraper_controller = ScraperController(database)


@app.get("/health")
def health():
    try:
        connection = mysql.connector.connect(**database_config())
        connection.close()
        return jsonify({"status": "ok", "database": "ok"})
    except mysql.connector.Error:
        return jsonify({"status": "error", "database": "unavailable"}), 503


@app.get("/api/jobs")
def jobs():
    connection = None
    cursor = None
    try:
        connection = mysql.connector.connect(**database_config())
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT id, title, employer, job_number, work_model, location, deadline, scraped_at
            FROM jobs
            ORDER BY scraped_at DESC, id DESC
            """
        )
        return jsonify(cursor.fetchall())
    except mysql.connector.Error:
        return jsonify({"error": "database unavailable"}), 503
    finally:
        if cursor is not None:
            cursor.close()
        if connection is not None:
            connection.close()


@app.get("/api/scraper/status")
def scraper_status():
    status = scraper_controller.status()
    status["browser_url"] = os.getenv(
        "BROWSER_URL",
        "http://localhost:7900/vnc_lite.html?scale=true",
    )
    return jsonify(status)


@app.post("/api/scraper/scrape")
def start_scraper():
    try:
        status = scraper_controller.start("scrape")
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 409
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    status["browser_url"] = os.getenv(
        "BROWSER_URL",
        "http://localhost:7900/vnc_lite.html?scale=true",
    )
    return jsonify(status), 202

@app.get("/api/export/json")
def export_database():
    connection = None
    cursor = None

    try:
        connection = mysql.connector.connect(**database_config())
        cursor = connection.cursor(dictionary=True)

        # ---------------------------------------------------------
        # Get scrape runs
        # ---------------------------------------------------------

        cursor.execute("""
            SELECT *
            FROM scrape_runs
            ORDER BY id
        """)

        scrape_runs = cast(
            list[dict[str, Any]],
            cursor.fetchall()
        )

        # ---------------------------------------------------------
        # Get jobs
        # ---------------------------------------------------------

        cursor.execute("""
            SELECT *
            FROM jobs
            ORDER BY id
        """)

        jobs = cast(
            list[dict[str, Any]],
            cursor.fetchall()
        )

        # ---------------------------------------------------------
        # Get qualifications
        # ---------------------------------------------------------

        cursor.execute("""
            SELECT *
            FROM job_qualifications
            ORDER BY job_id, qualification_order
        """)

        qualifications = cast(
            list[dict[str, Any]],
            cursor.fetchall()
        )

        # ---------------------------------------------------------
        # Get requirements
        # ---------------------------------------------------------

        cursor.execute("""
            SELECT *
            FROM job_requirements
            ORDER BY job_id, requirement_order
        """)

        requirements = cast(
            list[dict[str, Any]],
            cursor.fetchall()
        )

        # ---------------------------------------------------------
        # Associate qualifications with jobs
        # ---------------------------------------------------------

        qualifications_by_job: dict[int, list[dict[str, Any]]] = {}

        for qualification in qualifications:
            job_id = qualification["job_id"]

            qualifications_by_job.setdefault(
                job_id,
                []
            ).append(qualification)

        # ---------------------------------------------------------
        # Associate requirements with jobs
        # ---------------------------------------------------------

        requirements_by_job: dict[int, list[dict[str, Any]]] = {}

        for requirement in requirements:
            job_id = requirement["job_id"]

            requirements_by_job.setdefault(
                job_id,
                []
            ).append(requirement)

        # ---------------------------------------------------------
        # Associate jobs with scrape runs
        # ---------------------------------------------------------

        jobs_by_run: dict[int, list[dict[str, Any]]] = {}

        for job in jobs:
            job_id = job["id"]
            run_id = job["run_id"]

            job["qualifications"] = qualifications_by_job.get(
                job_id,
                []
            )

            job["requirements"] = requirements_by_job.get(
                job_id,
                []
            )

            jobs_by_run.setdefault(
                run_id,
                []
            ).append(job)

        # ---------------------------------------------------------
        # Associate jobs with scrape runs
        # ---------------------------------------------------------

        for scrape_run in scrape_runs:
            run_id = scrape_run["id"]

            scrape_run["jobs"] = jobs_by_run.get(
                run_id,
                []
            )

        # ---------------------------------------------------------
        # Return complete database structure
        # ---------------------------------------------------------

        return jsonify({
            "scrape_runs": scrape_runs
        })

    except mysql.connector.Error:
        return jsonify({
            "error": "database unavailable"
        }), 503

    finally:
        if cursor is not None:
            cursor.close()

        if connection is not None:
            connection.close()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("SERVER_PORT", "8000")))
