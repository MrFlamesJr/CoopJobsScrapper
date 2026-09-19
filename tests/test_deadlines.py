from datetime import date

import pytest

from app.deadlines import parse_deadline


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-01-05", date(2026, 1, 5)),
        ("Jan 5, 2026", date(2026, 1, 5)),
        ("January 5, 2026", date(2026, 1, 5)),
        ("5 Jan 2026", date(2026, 1, 5)),
        ("5 January 2026", date(2026, 1, 5)),
        ("2026/01/05", date(2026, 1, 5)),
        ("01/05/2026", date(2026, 1, 5)),
        ("Monday, January 5, 2026", date(2026, 1, 5)),
        ("Mon, Jan 5, 2026", date(2026, 1, 5)),
        ("Jan 5 2026", date(2026, 1, 5)),
        ("Deadline: Jan 5, 2026", date(2026, 1, 5)),
        ("Deadline: Jan 5, 2026 at 11:59 PM", date(2026, 1, 5)),
        ("Jan 5, 2026 23:59", date(2026, 1, 5)),
        ("Jan 5, 2026 11:59 PM EST", date(2026, 1, 5)),
        ("Jan 5, 2026 at 5:00 p.m.", date(2026, 1, 5)),
        ("Sept 5, 2026", date(2026, 9, 5)),
        ("Sept. 5, 2026", date(2026, 9, 5)),
        ("Application Deadline: 5 January 2026", date(2026, 1, 5)),
        ("January 5th, 2026", date(2026, 1, 5)),
        ("  Jan 5, 2026  ", date(2026, 1, 5)),
    ],
)
def test_parse_deadline_recognized_formats(text, expected):
    assert parse_deadline(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        None,
        "asdfasdf",
        "Rolling",
        "Open until filled",
        "TBD",
        "Not a date at all: 42",
    ],
)
def test_parse_deadline_returns_none_for_garbage(text):
    assert parse_deadline(text) is None
