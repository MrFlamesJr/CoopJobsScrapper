"""SQLite access layer. Every function takes an open sqlite3.Connection;
callers own the connection's lifetime (one per thread/request)."""

import json
import logging
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from app.deadlines import parse_deadline

logger = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

FACET_FIELDS = ("employer", "location", "work_model", "term", "duration", "round")

_COVER_COLUMNS = (
    "id",
    "job_number",
    "title",
    "employer",
    "location",
    "duration",
    "work_model",
    "term",
    "deadline_text",
    "deadline_date",
)

_JOB_FIELDS = (
    "job_number",
    "title",
    "employer",
    "location",
    "duration",
    "work_model",
    "term",
    "round",
    "salary",
    "deadline_text",
    "description",
)

_SORTS = {
    "deadline": "deadline_date IS NULL, deadline_date ASC, title ASC",
    "title": "title ASC",
    "employer": "employer ASC, title ASC",
    "newest": "id DESC",
}


def connect(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()


def _search_text(job: dict[str, Any]) -> str:
    parts = [str(job.get(field, "")) for field in _JOB_FIELDS]
    parts.extend(job.get("requirements") or [])
    for qualification in job.get("qualifications") or []:
        parts.append(str(qualification.get("name", "")))
        parts.append(str(qualification.get("value", "")))
    return " ".join(parts).lower()


def insert_jobs(conn: sqlite3.Connection, jobs: list[dict[str, Any]]) -> int:
    inserted = 0
    for job in jobs:
        deadline_text = job.get("deadline_text", "") or ""
        deadline_date = parse_deadline(deadline_text)
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO jobs (
                job_number, title, employer, location, duration, work_model, term,
                round, salary, deadline_text, deadline_date, description,
                requirements, qualifications, search_text, page_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job.get("job_number", "") or "",
                job.get("title", "") or "",
                job.get("employer", "") or "",
                job.get("location", "") or "",
                job.get("duration", "") or "",
                job.get("work_model", "") or "",
                job.get("term", "") or "",
                job.get("round", "") or "",
                job.get("salary", "") or "",
                deadline_text,
                deadline_date.isoformat() if deadline_date else None,
                job.get("description", "") or "",
                json.dumps(job.get("requirements") or []),
                json.dumps(job.get("qualifications") or []),
                _search_text(job),
                job.get("page_number"),
            ),
        )
        inserted += cursor.rowcount
    conn.commit()
    return inserted


def count_jobs(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()
    return row["n"]


def last_scraped_at(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT MAX(scraped_at) AS latest FROM jobs").fetchone()
    latest = row["latest"] if row else None
    if not latest:
        return None
    return datetime.strptime(latest, "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%dT%H:%M:%SZ")


def _escape_like(word: str) -> str:
    return word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def query_jobs(
    conn: sqlite3.Connection,
    q: str = "",
    filters: dict[str, list[str]] | None = None,
    deadline: str | None = None,
    sort: str = "deadline",
    today: date | None = None,
) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []

    for word in q.split():
        where.append("search_text LIKE ? ESCAPE '\\'")
        params.append(f"%{_escape_like(word.lower())}%")

    for field, values in (filters or {}).items():
        if field not in FACET_FIELDS or not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        where.append(f"{field} IN ({placeholders})")
        params.extend(values)

    today = today or date.today()
    today_str = today.isoformat()
    if deadline == "open":
        where.append("(deadline_date >= ? OR deadline_date IS NULL)")
        params.append(today_str)
    elif deadline == "week":
        where.append("(deadline_date >= ? AND deadline_date <= ?)")
        params.append(today_str)
        params.append((today + timedelta(days=7)).isoformat())
    elif deadline == "closed":
        where.append("deadline_date < ?")
        params.append(today_str)

    order_by = _SORTS.get(sort, _SORTS["deadline"])
    sql = f"SELECT {', '.join(_COVER_COLUMNS)} FROM jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {order_by}"

    rows = conn.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def _decode_job(row: sqlite3.Row) -> dict[str, Any]:
    """Turn a raw `jobs` row into the API/export shape: drop search_text, decode JSON lists."""
    job = dict(row)
    job.pop("search_text", None)
    job["requirements"] = json.loads(job["requirements"])
    job["qualifications"] = json.loads(job["qualifications"])
    return job


def get_job(conn: sqlite3.Connection, job_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _decode_job(row) if row is not None else None


def get_facets(conn: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    facets: dict[str, list[dict[str, Any]]] = {field: [] for field in FACET_FIELDS}
    rows = conn.execute(
        "SELECT field, value, job_count FROM job_facets ORDER BY field, job_count DESC, value ASC"
    ).fetchall()
    for row in rows:
        if row["field"] in facets:
            facets[row["field"]].append({"value": row["value"], "count": row["job_count"]})
    return facets


def clear_jobs(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM jobs")
    conn.commit()


def export_jobs(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM jobs ORDER BY id").fetchall()
    return [_decode_job(row) for row in rows]
