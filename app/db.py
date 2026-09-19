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

# Columns query_jobs adds (on top of _COVER_COLUMNS) only when `q` has words, to
# compute `match` -- stripped back out before the job dicts are returned.
_MATCH_EXTRA_COLUMNS = ("round", "salary", "description", "requirements", "qualifications")

# All fields `match.fields` checks, using the job's real field names.
_MATCH_FIELDS = (
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
    "requirements",
    "qualifications",
)

# What's visible on a (collapsed) job card, without opening it.
_CARD_VISIBLE_FIELDS = ("job_number", "title", "employer", "location", "duration", "work_model")

# Snippet search order for a word that isn't visible on the card.
_SNIPPET_FIELDS = ("term", "round", "salary", "deadline_text", "requirements", "qualifications", "description")

_SNIPPET_RADIUS = 60

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


def _field_text(job: dict[str, Any], field: str) -> str:
    """The searchable text of one field, for a job dict whose `requirements` /
    `qualifications` are already decoded to a list / list of dicts."""
    if field == "requirements":
        return " ".join(job.get("requirements") or [])
    if field == "qualifications":
        return ", ".join(
            f"{q.get('name', '')}: {q.get('value', '')}" for q in job.get("qualifications") or []
        )
    return str(job.get(field, "") or "")


def _find_snippet(field_texts: dict[str, str], word: str) -> dict[str, str] | None:
    """First hit of `word` (lowercase) across `_SNIPPET_FIELDS`, as ~120 chars
    trimmed to word boundaries with an ellipsis on each cut side."""
    for field in _SNIPPET_FIELDS:
        text = " ".join(field_texts[field].split())  # collapse whitespace first
        idx = text.lower().find(word)
        if idx == -1:
            continue

        start = max(0, idx - _SNIPPET_RADIUS)
        end = min(len(text), idx + len(word) + _SNIPPET_RADIUS)
        if start > 0:
            space = text.find(" ", start, idx)
            if space != -1:
                start = space + 1
        if end < len(text):
            space = text.rfind(" ", idx + len(word), end)
            if space != -1:
                end = space

        snippet = text[start:end].strip()
        if start > 0:
            snippet = "…" + snippet
        if end < len(text):
            snippet += "…"
        return {"field": field, "text": snippet}
    return None


def _match_info(job: dict[str, Any], words: list[str]) -> tuple[dict[str, Any], int]:
    """The `match` payload for one job plus its ranking tier (0 best), for a
    job dict whose `requirements` / `qualifications` are already decoded."""
    field_texts = {field: _field_text(job, field) for field in _MATCH_FIELDS}
    lower_texts = {field: text.lower() for field, text in field_texts.items()}

    fields = [field for field in _MATCH_FIELDS if any(word in lower_texts[field] for word in words)]
    card_visible_words = {
        word for word in words if any(word in lower_texts[field] for field in _CARD_VISIBLE_FIELDS)
    }

    snippet = None
    for word in words:
        if word in card_visible_words:
            continue
        snippet = _find_snippet(field_texts, word)
        if snippet is not None:
            break

    if all(word in lower_texts["title"] for word in words):
        tier = 0
    elif all(word in card_visible_words for word in words):
        tier = 1
    else:
        tier = 2

    return {"fields": fields, "snippet": snippet}, tier


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

    words = [word.lower() for word in q.split()]
    for word in words:
        where.append("search_text LIKE ? ESCAPE '\\'")
        params.append(f"%{_escape_like(word)}%")

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
    columns = _COVER_COLUMNS + _MATCH_EXTRA_COLUMNS if words else _COVER_COLUMNS
    sql = f"SELECT {', '.join(columns)} FROM jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {order_by}"

    rows = conn.execute(sql, params).fetchall()
    jobs = [dict(row) for row in rows]
    if not words:
        return jobs

    # Rank on top of the SQL order: a stable sort by tier keeps ties in place.
    decorated: list[tuple[int, dict[str, Any]]] = []
    for job in jobs:
        job["requirements"] = json.loads(job["requirements"])
        job["qualifications"] = json.loads(job["qualifications"])
        match, tier = _match_info(job, words)
        for column in _MATCH_EXTRA_COLUMNS:
            job.pop(column, None)
        job["match"] = match
        decorated.append((tier, job))

    decorated.sort(key=lambda pair: pair[0])
    return [job for _, job in decorated]


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
    # No jobs, nothing that could be incomplete: the last run goes with them.
    conn.execute("DELETE FROM scrape_meta WHERE key = 'last_run'")
    conn.commit()


def set_last_run(conn: sqlite3.Connection, run: dict[str, Any]) -> None:
    """Remember the latest scrape run (state, timings, counters) as JSON."""
    conn.execute(
        """
        INSERT INTO scrape_meta (key, value) VALUES ('last_run', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (json.dumps(run),),
    )
    conn.commit()


def get_last_run(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """The latest run record, or None when there is none. Also None when the row
    cannot be read (a database from before scrape_meta, or unreadable JSON): a
    missing run record must never break the status endpoint."""
    try:
        row = conn.execute("SELECT value FROM scrape_meta WHERE key = 'last_run'").fetchone()
    except sqlite3.Error as exc:
        logger.warning("Could not read the last run: %s", exc)
        return None
    if row is None:
        return None
    try:
        run = json.loads(row["value"])
    except ValueError:
        logger.warning("The stored last run is not valid JSON; ignoring it.")
        return None
    return run if isinstance(run, dict) else None


def list_favorites(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Saved jobs, newest first. `job` is the cover dict, or None while the
    job is missing from the jobs table (cleared or dropped by a re-scrape)."""
    columns = ", ".join(f"j.{column} AS job_{column}" for column in _COVER_COLUMNS)
    rows = conn.execute(
        f"""
        SELECT f.job_number, f.title, f.employer, f.created_at, {columns}
        FROM favorites f LEFT JOIN jobs j ON j.job_number = f.job_number
        ORDER BY f.created_at DESC, f.rowid DESC
        """
    ).fetchall()
    favorites = []
    for row in rows:
        job = None
        if row["job_id"] is not None:
            job = {column: row[f"job_{column}"] for column in _COVER_COLUMNS}
        favorites.append(
            {
                "job_number": row["job_number"],
                "title": row["title"],
                "employer": row["employer"],
                "created_at": row["created_at"],
                "job": job,
            }
        )
    return favorites


def add_favorite(conn: sqlite3.Connection, job_number: str) -> bool:
    """Save a job, keeping a title/employer snapshot. Idempotent.
    Returns False when no job has that number."""
    if not job_number:
        return False
    row = conn.execute(
        "SELECT title, employer FROM jobs WHERE job_number = ?", (job_number,)
    ).fetchone()
    if row is None:
        return False
    conn.execute(
        "INSERT OR IGNORE INTO favorites (job_number, title, employer) VALUES (?, ?, ?)",
        (job_number, row["title"], row["employer"]),
    )
    conn.commit()
    return True


def remove_favorite(conn: sqlite3.Connection, job_number: str) -> bool:
    """Unsave a job. Returns False when it wasn't a favorite."""
    cursor = conn.execute("DELETE FROM favorites WHERE job_number = ?", (job_number,))
    conn.commit()
    return cursor.rowcount > 0


def export_jobs(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM jobs ORDER BY id").fetchall()
    return [_decode_job(row) for row in rows]
