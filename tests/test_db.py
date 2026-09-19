from datetime import date

from app import db


def test_insert_jobs_dedupes_by_job_number(conn, job_factory):
    job = job_factory(job_number="DUP1")
    assert db.insert_jobs(conn, [job]) == 1
    assert db.insert_jobs(conn, [job]) == 0
    assert db.count_jobs(conn) == 1


def test_insert_jobs_allows_multiple_blank_job_numbers(conn, job_factory):
    jobs = [job_factory(job_number=""), job_factory(job_number="")]
    assert db.insert_jobs(conn, jobs) == 2
    assert db.count_jobs(conn) == 2


def test_search_matches_description_requirements_and_qualifications(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(description="Build a rocket ship", requirements=[], qualifications=[]),
            job_factory(description="Bake bread", requirements=["Rocket science"], qualifications=[]),
            job_factory(
                description="Nothing relevant",
                requirements=[],
                qualifications=[{"name": "Rocket", "value": "yes"}],
            ),
            job_factory(description="Totally unrelated", requirements=[], qualifications=[]),
        ],
    )
    results = db.query_jobs(conn, q="rocket")
    assert len(results) == 3


def test_search_is_case_insensitive_and_multi_word_and(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(description="Python AND SQL developer", requirements=[], qualifications=[]),
            job_factory(description="Python developer only", requirements=[], qualifications=[]),
            job_factory(description="Completely unrelated posting", requirements=[], qualifications=[]),
        ],
    )
    results = db.query_jobs(conn, q="python sql")
    assert len(results) == 1


def test_search_escapes_percent_and_underscore_literally(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(description="Save 50% today with under_score bonus"),
            job_factory(description="Save fifty percent today with underscore bonus"),
        ],
    )
    assert len(db.query_jobs(conn, q="50%")) == 1
    assert len(db.query_jobs(conn, q="under_score")) == 1


def test_filters_or_within_field_and_across_fields(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(employer="Acme", location="Ottawa, ON"),
            job_factory(employer="Beta", location="Ottawa, ON"),
            job_factory(employer="Acme", location="Toronto, ON"),
            job_factory(employer="Gamma", location="Ottawa, ON"),
        ],
    )
    results = db.query_jobs(
        conn,
        filters={"employer": ["Acme", "Beta"], "location": ["Ottawa, ON"]},
    )
    employers = {row["employer"] for row in results}
    assert employers == {"Acme", "Beta"}
    assert len(results) == 2


def test_filters_ignore_unknown_fields(conn, job_factory):
    db.insert_jobs(conn, [job_factory(employer="Acme")])
    results = db.query_jobs(conn, filters={"not_a_field": ["x"]})
    assert len(results) == 1


def test_deadline_filters(conn, job_factory):
    today = date(2026, 1, 10)
    db.insert_jobs(
        conn,
        [
            job_factory(job_number="past", deadline_text="Jan 5, 2026"),
            job_factory(job_number="today", deadline_text="Jan 10, 2026"),
            job_factory(job_number="soon", deadline_text="Jan 12, 2026"),
            job_factory(job_number="later", deadline_text="Feb 1, 2026"),
            job_factory(job_number="none", deadline_text=""),
        ],
    )

    open_jobs = {row["job_number"] for row in db.query_jobs(conn, deadline="open", today=today)}
    assert open_jobs == {"today", "soon", "later", "none"}

    week_jobs = {row["job_number"] for row in db.query_jobs(conn, deadline="week", today=today)}
    assert week_jobs == {"today", "soon"}

    closed_jobs = {row["job_number"] for row in db.query_jobs(conn, deadline="closed", today=today)}
    assert closed_jobs == {"past"}

    all_jobs = db.query_jobs(conn, deadline=None, today=today)
    assert len(all_jobs) == 5


def test_sort_deadline_puts_nulls_last(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(job_number="b", title="B", deadline_text="Jan 12, 2026"),
            job_factory(job_number="a", title="A", deadline_text=""),
            job_factory(job_number="c", title="C", deadline_text="Jan 5, 2026"),
        ],
    )
    results = db.query_jobs(conn, sort="deadline")
    assert [row["job_number"] for row in results] == ["c", "b", "a"]


def test_sort_title_and_employer_and_newest(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(job_number="1", title="Zeta", employer="Zoo"),
            job_factory(job_number="2", title="Alpha", employer="Ant Co"),
        ],
    )
    by_title = db.query_jobs(conn, sort="title")
    assert [row["title"] for row in by_title] == ["Alpha", "Zeta"]

    by_employer = db.query_jobs(conn, sort="employer")
    assert [row["employer"] for row in by_employer] == ["Ant Co", "Zoo"]

    by_newest = db.query_jobs(conn, sort="newest")
    assert [row["job_number"] for row in by_newest] == ["2", "1"]


def test_unknown_sort_falls_back_to_deadline(conn, job_factory):
    db.insert_jobs(conn, [job_factory(job_number="1", deadline_text="Jan 5, 2026")])
    results = db.query_jobs(conn, sort="bogus")
    assert results[0]["job_number"] == "1"


def test_facets_counts_and_excludes_blank_values(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(employer="Acme"),
            job_factory(employer="Acme"),
            job_factory(employer="Beta"),
            job_factory(employer=""),
        ],
    )
    facets = db.get_facets(conn)
    assert set(db.FACET_FIELDS) == set(facets.keys())
    employer_facet = facets["employer"]
    assert {"value": "Acme", "count": 2} in employer_facet
    assert {"value": "Beta", "count": 1} in employer_facet
    assert all(entry["value"] != "" for entry in employer_facet)
    # sorted count desc, value asc
    assert employer_facet[0]["value"] == "Acme"


def test_clear_jobs_empties_table(conn, job_factory):
    db.insert_jobs(conn, [job_factory(), job_factory()])
    assert db.count_jobs(conn) == 2
    db.clear_jobs(conn)
    assert db.count_jobs(conn) == 0


def test_set_and_get_last_run_round_trip(conn):
    assert db.get_last_run(conn) is None

    run = {
        "state": "cancelled",
        "started_at": "2026-01-10T12:00:00+00:00",
        "finished_at": "2026-01-10T12:04:30+00:00",
        "pages_completed": 3,
        "total_pages": 39,
        "jobs_saved": 57,
    }
    db.set_last_run(conn, run)
    assert db.get_last_run(conn) == run

    db.set_last_run(conn, dict(run, state="completed"))
    assert db.get_last_run(conn)["state"] == "completed"  # upsert, not a second row


def test_clear_jobs_removes_the_last_run(conn, job_factory):
    db.insert_jobs(conn, [job_factory()])
    db.set_last_run(conn, {"state": "cancelled", "jobs_saved": 1})
    db.clear_jobs(conn)
    assert db.get_last_run(conn) is None


def test_get_last_run_tolerates_unreadable_records(conn):
    db.set_last_run(conn, {"state": "cancelled"})
    conn.execute("UPDATE scrape_meta SET value = 'not json' WHERE key = 'last_run'")
    assert db.get_last_run(conn) is None

    conn.execute("DROP TABLE scrape_meta")  # a database from before scrape_meta existed
    assert db.get_last_run(conn) is None


def test_get_job_decodes_lists_and_omits_search_text(conn, job_factory):
    db.insert_jobs(
        conn,
        [job_factory(requirements=["Python", "Git"], qualifications=[{"name": "Year", "value": "3rd"}])],
    )
    row = conn.execute("SELECT id FROM jobs").fetchone()
    job = db.get_job(conn, row["id"])
    assert job is not None
    assert job["requirements"] == ["Python", "Git"]
    assert job["qualifications"] == [{"name": "Year", "value": "3rd"}]
    assert "search_text" not in job


def test_get_job_returns_none_for_missing_id(conn):
    assert db.get_job(conn, 999) is None


def test_export_jobs_shape_and_order(conn, job_factory):
    db.insert_jobs(conn, [job_factory(job_number="1"), job_factory(job_number="2")])
    exported = db.export_jobs(conn)
    assert [job["job_number"] for job in exported] == ["1", "2"]
    assert "search_text" not in exported[0]
    assert isinstance(exported[0]["requirements"], list)


def test_add_favorite_snapshots_job_and_is_idempotent(conn, job_factory):
    db.insert_jobs(conn, [job_factory(job_number="F1", title="Backend Dev", employer="Acme")])
    assert db.add_favorite(conn, "F1") is True
    assert db.add_favorite(conn, "F1") is True

    favorites = db.list_favorites(conn)
    assert len(favorites) == 1
    assert favorites[0]["job_number"] == "F1"
    assert favorites[0]["title"] == "Backend Dev"
    assert favorites[0]["employer"] == "Acme"
    assert favorites[0]["job"]["title"] == "Backend Dev"


def test_add_favorite_rejects_unknown_and_blank_job_number(conn):
    assert db.add_favorite(conn, "nope") is False
    assert db.add_favorite(conn, "") is False
    assert db.list_favorites(conn) == []


def test_remove_favorite(conn, job_factory):
    db.insert_jobs(conn, [job_factory(job_number="F1")])
    db.add_favorite(conn, "F1")
    assert db.remove_favorite(conn, "F1") is True
    assert db.remove_favorite(conn, "F1") is False
    assert db.list_favorites(conn) == []


def test_list_favorites_is_newest_first(conn, job_factory):
    db.insert_jobs(
        conn,
        [job_factory(job_number="a"), job_factory(job_number="b"), job_factory(job_number="c")],
    )
    for job_number in ("a", "b", "c"):
        db.add_favorite(conn, job_number)

    favorites = db.list_favorites(conn)
    assert [row["job_number"] for row in favorites] == ["c", "b", "a"]


def test_favorites_survive_clear_jobs_and_relink(conn, job_factory):
    db.insert_jobs(conn, [job_factory(job_number="F1", title="Backend Dev", employer="Acme")])
    db.add_favorite(conn, "F1")

    db.clear_jobs(conn)
    orphan = db.list_favorites(conn)[0]
    assert orphan["job"] is None
    assert orphan["title"] == "Backend Dev"
    assert orphan["employer"] == "Acme"

    db.insert_jobs(conn, [job_factory(job_number="F1", title="Backend Dev II")])
    relinked = db.list_favorites(conn)[0]
    assert relinked["job"]["job_number"] == "F1"
    assert relinked["job"]["title"] == "Backend Dev II"
    assert relinked["title"] == "Backend Dev"  # snapshot is untouched


def test_last_scraped_at_none_when_empty(conn):
    assert db.last_scraped_at(conn) is None


def test_last_scraped_at_returns_iso_string(conn, job_factory):
    db.insert_jobs(conn, [job_factory()])
    latest = db.last_scraped_at(conn)
    assert latest is not None
    assert latest.endswith("Z")
    assert "T" in latest


def test_search_without_q_has_no_match_key(conn, job_factory):
    db.insert_jobs(conn, [job_factory()])
    results = db.query_jobs(conn, q="")
    assert "match" not in results[0]
    assert set(results[0]) == set(db._COVER_COLUMNS)


def test_search_match_description_only_hit(conn, job_factory):
    db.insert_jobs(
        conn,
        [job_factory(description="Rocket engineering role", requirements=[], qualifications=[])],
    )
    results = db.query_jobs(conn, q="rocket")
    assert len(results) == 1
    match = results[0]["match"]
    assert match["fields"] == ["description"]
    assert match["snippet"] == {"field": "description", "text": "Rocket engineering role"}
    # the extra columns selected to compute `match` never leak into the job dict
    for column in ("round", "salary", "description", "requirements", "qualifications"):
        assert column not in results[0]


def test_search_match_multi_word_across_fields(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(
                title="Java Backend Developer",
                description="Also requires Python skills",
                requirements=[],
                qualifications=[],
            )
        ],
    )
    results = db.query_jobs(conn, q="java python")
    match = results[0]["match"]
    assert match["fields"] == ["title", "description"]
    assert match["snippet"]["field"] == "description"
    assert "Python" in match["snippet"]["text"]


def test_search_tiers_preserve_the_chosen_sort(conn, job_factory):
    db.insert_jobs(
        conn,
        [
            job_factory(job_number="title-hit", title="Search Expert", requirements=[], qualifications=[]),
            job_factory(
                job_number="card-hit",
                title="Apple Role",
                employer="Search Co",
                requirements=[],
                qualifications=[],
            ),
            job_factory(
                job_number="desc-hit",
                title="Banana Role",
                description="A search happens here",
                requirements=[],
                qualifications=[],
            ),
        ],
    )
    results = db.query_jobs(conn, q="search", sort="title")
    assert [row["job_number"] for row in results] == ["title-hit", "card-hit", "desc-hit"]


def test_search_match_with_literal_percent(conn, job_factory):
    db.insert_jobs(
        conn,
        [job_factory(description="Save 50% today", requirements=[], qualifications=[])],
    )
    results = db.query_jobs(conn, q="50%")
    assert len(results) == 1
    match = results[0]["match"]
    assert match["fields"] == ["description"]
    assert "50%" in match["snippet"]["text"]
