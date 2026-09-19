from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from app import db


@pytest.fixture
def conn(tmp_path: Path):
    connection = db.connect(tmp_path / "jobs.db")
    db.init_db(connection)
    yield connection
    connection.close()


@pytest.fixture
def job_factory() -> Callable[..., dict[str, Any]]:
    counter = {"n": 0}

    def make(**overrides: Any) -> dict[str, Any]:
        counter["n"] += 1
        job = {
            "job_number": f"J{counter['n']}",
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
            "requirements": ["Python", "SQL"],
            "qualifications": [{"name": "Year", "value": "3rd"}],
            "page_number": 1,
        }
        job.update(overrides)
        return job

    return make
