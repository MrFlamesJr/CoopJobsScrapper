// Port of tests/test_db.py (same test names), plus the data-behavior tests
// from tests/test_server.py that exercise db.py through the Flask routes
// (jobs listing/filter/search/facets/favorites/delete/export shapes) --
// ported here against queries.js directly, combining calls the way
// src/api.js's fetchJobs/deleteAllJobs/etc. do, since there's no Flask layer
// any more. See the bottom of this file for exactly which test_server.py
// tests were left out and why.

import { beforeEach, describe, expect, test } from "vitest";
import * as db from "./queries.js";
import { createHandle, createJobFactory } from "./testUtils.js";
import schemaSql from "./schema.sql?raw";

let handle;
let jobFactory;

beforeEach(() => {
  ({ handle } = createHandle());
  jobFactory = createJobFactory();
});

// ---------------------------------------------------------------------
// tests/test_db.py
// ---------------------------------------------------------------------

test("test_insert_jobs_dedupes_by_job_number", () => {
  const job = jobFactory({ job_number: "DUP1" });
  expect(db.insertJobs(handle, [job])).toBe(1);
  expect(db.insertJobs(handle, [job])).toBe(0);
  expect(db.countJobs(handle)).toBe(1);
});

test("test_insert_jobs_allows_multiple_blank_job_numbers", () => {
  const jobs = [jobFactory({ job_number: "" }), jobFactory({ job_number: "" })];
  expect(db.insertJobs(handle, jobs)).toBe(2);
  expect(db.countJobs(handle)).toBe(2);
});

test("test_search_matches_description_requirements_and_qualifications", () => {
  db.insertJobs(handle, [
    jobFactory({ description: "Build a rocket ship", requirements: [], qualifications: [] }),
    jobFactory({ description: "Bake bread", requirements: ["Rocket science"], qualifications: [] }),
    jobFactory({
      description: "Nothing relevant",
      requirements: [],
      qualifications: [{ name: "Rocket", value: "yes" }],
    }),
    jobFactory({ description: "Totally unrelated", requirements: [], qualifications: [] }),
  ]);
  const results = db.queryJobs(handle, { q: "rocket" });
  expect(results.length).toBe(3);
});

test("test_search_is_case_insensitive_and_multi_word_and", () => {
  db.insertJobs(handle, [
    jobFactory({ description: "Python AND SQL developer", requirements: [], qualifications: [] }),
    jobFactory({ description: "Python developer only", requirements: [], qualifications: [] }),
    jobFactory({ description: "Completely unrelated posting", requirements: [], qualifications: [] }),
  ]);
  const results = db.queryJobs(handle, { q: "python sql" });
  expect(results.length).toBe(1);
});

test("test_search_escapes_percent_and_underscore_literally", () => {
  db.insertJobs(handle, [
    jobFactory({ description: "Save 50% today with under_score bonus" }),
    jobFactory({ description: "Save fifty percent today with underscore bonus" }),
  ]);
  expect(db.queryJobs(handle, { q: "50%" }).length).toBe(1);
  expect(db.queryJobs(handle, { q: "under_score" }).length).toBe(1);
});

test("test_filters_or_within_field_and_across_fields", () => {
  db.insertJobs(handle, [
    jobFactory({ employer: "Acme", location: "Ottawa, ON" }),
    jobFactory({ employer: "Beta", location: "Ottawa, ON" }),
    jobFactory({ employer: "Acme", location: "Toronto, ON" }),
    jobFactory({ employer: "Gamma", location: "Ottawa, ON" }),
  ]);
  const results = db.queryJobs(handle, { filters: { employer: ["Acme", "Beta"], location: ["Ottawa, ON"] } });
  const employers = new Set(results.map((row) => row.employer));
  expect(employers).toEqual(new Set(["Acme", "Beta"]));
  expect(results.length).toBe(2);
});

test("test_filters_ignore_unknown_fields", () => {
  db.insertJobs(handle, [jobFactory({ employer: "Acme" })]);
  const results = db.queryJobs(handle, { filters: { not_a_field: ["x"] } });
  expect(results.length).toBe(1);
});

test("test_deadline_filters", () => {
  const today = "2026-01-10";
  db.insertJobs(handle, [
    jobFactory({ job_number: "past", deadline_text: "Jan 5, 2026" }),
    jobFactory({ job_number: "today", deadline_text: "Jan 10, 2026" }),
    jobFactory({ job_number: "soon", deadline_text: "Jan 12, 2026" }),
    jobFactory({ job_number: "later", deadline_text: "Feb 1, 2026" }),
    jobFactory({ job_number: "none", deadline_text: "" }),
  ]);

  const openJobs = new Set(db.queryJobs(handle, { deadline: "open", today }).map((r) => r.job_number));
  expect(openJobs).toEqual(new Set(["today", "soon", "later", "none"]));

  const weekJobs = new Set(db.queryJobs(handle, { deadline: "week", today }).map((r) => r.job_number));
  expect(weekJobs).toEqual(new Set(["today", "soon"]));

  const closedJobs = new Set(db.queryJobs(handle, { deadline: "closed", today }).map((r) => r.job_number));
  expect(closedJobs).toEqual(new Set(["past"]));

  const allJobs = db.queryJobs(handle, { deadline: null, today });
  expect(allJobs.length).toBe(5);
});

test("test_sort_deadline_puts_nulls_last", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "b", title: "B", deadline_text: "Jan 12, 2026" }),
    jobFactory({ job_number: "a", title: "A", deadline_text: "" }),
    jobFactory({ job_number: "c", title: "C", deadline_text: "Jan 5, 2026" }),
  ]);
  const results = db.queryJobs(handle, { sort: "deadline" });
  expect(results.map((r) => r.job_number)).toEqual(["c", "b", "a"]);
});

test("test_sort_title_and_employer_and_newest", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "1", title: "Zeta", employer: "Zoo" }),
    jobFactory({ job_number: "2", title: "Alpha", employer: "Ant Co" }),
  ]);
  const byTitle = db.queryJobs(handle, { sort: "title" });
  expect(byTitle.map((r) => r.title)).toEqual(["Alpha", "Zeta"]);

  const byEmployer = db.queryJobs(handle, { sort: "employer" });
  expect(byEmployer.map((r) => r.employer)).toEqual(["Ant Co", "Zoo"]);

  const byNewest = db.queryJobs(handle, { sort: "newest" });
  expect(byNewest.map((r) => r.job_number)).toEqual(["2", "1"]);
});

test("test_unknown_sort_falls_back_to_deadline", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "1", deadline_text: "Jan 5, 2026" })]);
  const results = db.queryJobs(handle, { sort: "bogus" });
  expect(results[0].job_number).toBe("1");
});

test("test_facets_counts_and_excludes_blank_values", () => {
  db.insertJobs(handle, [
    jobFactory({ employer: "Acme" }),
    jobFactory({ employer: "Acme" }),
    jobFactory({ employer: "Beta" }),
    jobFactory({ employer: "" }),
  ]);
  const facets = db.getFacets(handle);
  expect(new Set(db.FACET_FIELDS)).toEqual(new Set(Object.keys(facets)));
  const employerFacet = facets.employer;
  expect(employerFacet).toContainEqual({ value: "Acme", count: 2 });
  expect(employerFacet).toContainEqual({ value: "Beta", count: 1 });
  expect(employerFacet.every((entry) => entry.value !== "")).toBe(true);
  expect(employerFacet[0].value).toBe("Acme");
});

test("test_clear_jobs_empties_table", () => {
  db.insertJobs(handle, [jobFactory(), jobFactory()]);
  expect(db.countJobs(handle)).toBe(2);
  db.clearJobs(handle);
  expect(db.countJobs(handle)).toBe(0);
});

test("test_set_and_get_last_run_round_trip", () => {
  expect(db.getLastRun(handle)).toBeNull();

  const run = {
    state: "cancelled",
    started_at: "2026-01-10T12:00:00+00:00",
    finished_at: "2026-01-10T12:04:30+00:00",
    pages_completed: 3,
    total_pages: 39,
    jobs_saved: 57,
  };
  db.setLastRun(handle, run);
  expect(db.getLastRun(handle)).toEqual(run);

  db.setLastRun(handle, { ...run, state: "completed" });
  expect(db.getLastRun(handle).state).toBe("completed"); // upsert, not a second row
});

test("test_clear_jobs_removes_the_last_run", () => {
  db.insertJobs(handle, [jobFactory()]);
  db.setLastRun(handle, { state: "cancelled", jobs_saved: 1 });
  db.clearJobs(handle);
  expect(db.getLastRun(handle)).toBeNull();
});

test("test_get_last_run_tolerates_unreadable_records", () => {
  db.setLastRun(handle, { state: "cancelled" });
  handle.run("UPDATE scrape_meta SET value = 'not json' WHERE key = 'last_run'", []);
  expect(db.getLastRun(handle)).toBeNull();

  handle.run("DROP TABLE scrape_meta", []); // a database from before scrape_meta existed
  expect(db.getLastRun(handle)).toBeNull();
});

test("test_get_job_decodes_lists_and_omits_search_text", () => {
  db.insertJobs(handle, [
    jobFactory({ requirements: ["Python", "Git"], qualifications: [{ name: "Year", value: "3rd" }] }),
  ]);
  const [row] = handle.exec("SELECT id FROM jobs", []);
  const job = db.getJob(handle, row.id);
  expect(job).not.toBeNull();
  expect(job.requirements).toEqual(["Python", "Git"]);
  expect(job.qualifications).toEqual([{ name: "Year", value: "3rd" }]);
  expect(job.search_text).toBeUndefined();
});

test("test_get_job_returns_none_for_missing_id", () => {
  expect(db.getJob(handle, 999)).toBeNull();
});

test("test_export_jobs_shape_and_order", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "1" }), jobFactory({ job_number: "2" })]);
  const exported = db.exportJobs(handle);
  expect(exported.map((j) => j.job_number)).toEqual(["1", "2"]);
  expect(exported[0].search_text).toBeUndefined();
  expect(Array.isArray(exported[0].requirements)).toBe(true);
});

test("test_set_rating_snapshots_job_and_is_idempotent", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "F1", title: "Backend Dev", employer: "Acme" })]);
  expect(db.setRating(handle, "F1", 1)).toBe(true);
  expect(db.setRating(handle, "F1", 1)).toBe(true);

  const ratings = db.listRatings(handle);
  expect(ratings.length).toBe(1);
  expect(ratings[0].job_number).toBe("F1");
  expect(ratings[0].title).toBe("Backend Dev");
  expect(ratings[0].employer).toBe("Acme");
  expect(ratings[0].rating).toBe(1);
  expect(ratings[0].job.title).toBe("Backend Dev");
});

test("test_set_rating_can_change_liked_to_disliked", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "F1" })]);
  db.setRating(handle, "F1", 1);
  db.setRating(handle, "F1", -1);
  const ratings = db.listRatings(handle);
  expect(ratings.length).toBe(1);
  expect(ratings[0].rating).toBe(-1);
});

test("test_set_rating_rejects_unknown_and_blank_job_number", () => {
  expect(db.setRating(handle, "nope", 1)).toBe(false);
  expect(db.setRating(handle, "", 1)).toBe(false);
  expect(db.listRatings(handle)).toEqual([]);
});

test("test_set_rating_zero_clears_it", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "F1" })]);
  db.setRating(handle, "F1", 1);
  expect(db.setRating(handle, "F1", 0)).toBe(true);
  expect(db.setRating(handle, "F1", 0)).toBe(true); // idempotent, no job row needed
  expect(db.listRatings(handle)).toEqual([]);
});

test("test_rating_counts_excludes_ratings_whose_job_is_gone", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "a" }),
    jobFactory({ job_number: "b" }),
    jobFactory({ job_number: "orphan" }),
  ]);
  db.setRating(handle, "a", 1);
  db.setRating(handle, "b", -1);
  db.setRating(handle, "orphan", 1);
  // The job disappears (a re-scrape without it, or clearJobs), but its rating
  // survives -- see test_ratings_survive_clear_jobs_and_relink -- and must
  // not count toward the triage total any more.
  db.clearJobs(handle);
  db.insertJobs(handle, [jobFactory({ job_number: "a" }), jobFactory({ job_number: "b" })]);

  expect(db.ratingCounts(handle)).toEqual({ liked: 1, disliked: 1 });
});

test("test_list_ratings_is_newest_first", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "a" }), jobFactory({ job_number: "b" }), jobFactory({ job_number: "c" })]);
  for (const jobNumber of ["a", "b", "c"]) db.setRating(handle, jobNumber, 1);

  const ratings = db.listRatings(handle);
  expect(ratings.map((r) => r.job_number)).toEqual(["c", "b", "a"]);
});

test("test_ratings_survive_clear_jobs_and_relink", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "F1", title: "Backend Dev", employer: "Acme" })]);
  db.setRating(handle, "F1", 1);

  db.clearJobs(handle);
  const orphan = db.listRatings(handle)[0];
  expect(orphan.job).toBeNull();
  expect(orphan.title).toBe("Backend Dev");
  expect(orphan.employer).toBe("Acme");

  db.insertJobs(handle, [jobFactory({ job_number: "F1", title: "Backend Dev II" })]);
  const relinked = db.listRatings(handle)[0];
  expect(relinked.job.job_number).toBe("F1");
  expect(relinked.job.title).toBe("Backend Dev II");
  expect(relinked.title).toBe("Backend Dev"); // snapshot is untouched
});

test("test_sorts_array_builds_layered_order_by", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "1", employer: "Acme", title: "B" }),
    jobFactory({ job_number: "2", employer: "Acme", title: "A" }),
    jobFactory({ job_number: "3", employer: "Beta", title: "Z" }),
  ]);
  const results = db.queryJobs(handle, {
    sorts: [
      { field: "employer", dir: "asc" },
      { field: "title", dir: "desc" },
    ],
  });
  expect(results.map((r) => r.job_number)).toEqual(["1", "2", "3"]);
});

test("test_sorts_array_ignores_unknown_fields", () => {
  db.insertJobs(handle, [jobFactory({ job_number: "1", title: "B" }), jobFactory({ job_number: "2", title: "A" })]);
  const results = db.queryJobs(handle, { sorts: [{ field: "bogus", dir: "asc" }] });
  expect(results.map((r) => r.job_number)).toEqual(["2", "1"]); // falls through to the title tiebreak
});

test("test_sorts_array_deadline_nulls_last_both_directions", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "b", title: "B", deadline_text: "Jan 12, 2026" }),
    jobFactory({ job_number: "a", title: "A", deadline_text: "" }),
    jobFactory({ job_number: "c", title: "C", deadline_text: "Jan 5, 2026" }),
  ]);
  const ascending = db.queryJobs(handle, { sorts: [{ field: "deadline", dir: "asc" }] });
  expect(ascending.map((r) => r.job_number)).toEqual(["c", "b", "a"]);

  const descending = db.queryJobs(handle, { sorts: [{ field: "deadline", dir: "desc" }] });
  expect(descending.map((r) => r.job_number)).toEqual(["b", "c", "a"]);
});

test("test_sorts_array_myrating_liked_first_and_disliked_first", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "liked", title: "A" }),
    jobFactory({ job_number: "disliked", title: "B" }),
    jobFactory({ job_number: "neutral", title: "C" }),
  ]);
  db.setRating(handle, "liked", 1);
  db.setRating(handle, "disliked", -1);

  const ascending = db.queryJobs(handle, { sorts: [{ field: "myrating", dir: "asc" }] });
  expect(ascending.map((r) => r.job_number)).toEqual(["liked", "neutral", "disliked"]);

  const descending = db.queryJobs(handle, { sorts: [{ field: "myrating", dir: "desc" }] });
  expect(descending.map((r) => r.job_number)).toEqual(["disliked", "neutral", "liked"]);
});

test("test_rating_filter_liked_and_hide_disliked", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "1" }),
    jobFactory({ job_number: "2" }),
    jobFactory({ job_number: "3" }),
  ]);
  db.setRating(handle, "1", 1);
  db.setRating(handle, "2", -1);

  const liked = db.queryJobs(handle, { rating: "liked" });
  expect(liked.map((r) => r.job_number)).toEqual(["1"]);

  const notDisliked = new Set(db.queryJobs(handle, { rating: "hide_disliked" }).map((r) => r.job_number));
  expect(notDisliked).toEqual(new Set(["1", "3"]));
});

test("test_init_db_migrates_favorites_missing_rating_column", () => {
  // Simulate a database created before the `rating` column existed (the
  // Python app's .db files, or an older export).
  handle.run("DROP TABLE favorites", []);
  handle.run(
    `CREATE TABLE favorites (
      job_number TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      employer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    [],
  );
  handle.run("INSERT INTO favorites (job_number, title, employer) VALUES ('F1', 'Old Fave', 'Acme')", []);

  db.initDb(handle, schemaSql);

  const columns = handle.exec("PRAGMA table_info(favorites)", []);
  expect(columns.some((c) => c.name === "rating")).toBe(true);
  const ratings = db.listRatings(handle);
  expect(ratings[0].job_number).toBe("F1");
  expect(ratings[0].rating).toBe(1); // pre-existing rows count as liked
});

test("test_last_scraped_at_none_when_empty", () => {
  expect(db.lastScrapedAt(handle)).toBeNull();
});

test("test_last_scraped_at_returns_iso_string", () => {
  db.insertJobs(handle, [jobFactory()]);
  const latest = db.lastScrapedAt(handle);
  expect(latest).not.toBeNull();
  expect(latest.endsWith("Z")).toBe(true);
  expect(latest.includes("T")).toBe(true);
});

test("test_search_without_q_has_no_match_key", () => {
  db.insertJobs(handle, [jobFactory()]);
  const results = db.queryJobs(handle, { q: "" });
  expect(results[0].match).toBeUndefined();
  expect(new Set(Object.keys(results[0]))).toEqual(new Set(db.COVER_COLUMNS));
});

test("test_search_match_description_only_hit", () => {
  db.insertJobs(handle, [jobFactory({ description: "Rocket engineering role", requirements: [], qualifications: [] })]);
  const results = db.queryJobs(handle, { q: "rocket" });
  expect(results.length).toBe(1);
  const { match } = results[0];
  expect(match.fields).toEqual(["description"]);
  expect(match.snippet).toEqual({ field: "description", text: "Rocket engineering role" });
  for (const column of ["round", "salary", "description", "requirements", "qualifications"]) {
    expect(column in results[0]).toBe(false);
  }
});

test("test_search_match_multi_word_across_fields", () => {
  db.insertJobs(handle, [
    jobFactory({
      title: "Java Backend Developer",
      description: "Also requires Python skills",
      requirements: [],
      qualifications: [],
    }),
  ]);
  const results = db.queryJobs(handle, { q: "java python" });
  const { match } = results[0];
  expect(match.fields).toEqual(["title", "description"]);
  expect(match.snippet.field).toBe("description");
  expect(match.snippet.text).toContain("Python");
});

test("test_search_tiers_preserve_the_chosen_sort", () => {
  db.insertJobs(handle, [
    jobFactory({ job_number: "title-hit", title: "Search Expert", requirements: [], qualifications: [] }),
    jobFactory({
      job_number: "card-hit",
      title: "Apple Role",
      employer: "Search Co",
      requirements: [],
      qualifications: [],
    }),
    jobFactory({
      job_number: "desc-hit",
      title: "Banana Role",
      description: "A search happens here",
      requirements: [],
      qualifications: [],
    }),
  ]);
  const results = db.queryJobs(handle, { q: "search", sort: "title" });
  expect(results.map((r) => r.job_number)).toEqual(["title-hit", "card-hit", "desc-hit"]);
});

test("test_search_match_with_literal_percent", () => {
  db.insertJobs(handle, [jobFactory({ description: "Save 50% today", requirements: [], qualifications: [] })]);
  const results = db.queryJobs(handle, { q: "50%" });
  expect(results.length).toBe(1);
  const { match } = results[0];
  expect(match.fields).toEqual(["description"]);
  expect(match.snippet.text).toContain("50%");
});

// ---------------------------------------------------------------------
// Data-behavior tests ported from tests/test_server.py. These call
// queries.js directly (there's no Flask layer any more), composing calls the
// same way src/api.js does -- e.g. fetchJobs() is queryJobs() + countJobs().
// ---------------------------------------------------------------------

function makeJob(overrides = {}) {
  return {
    job_number: "J1",
    title: "Software Developer",
    employer: "Acme",
    location: "Ottawa, ON",
    duration: "4 months",
    work_model: "Hybrid",
    term: "Winter 2026",
    round: "Round 1",
    salary: "$20/hr",
    deadline_text: "",
    description: "Build things",
    requirements: ["Python"],
    qualifications: [{ name: "Year", value: "3rd" }],
    page_number: 1,
    ...overrides,
  };
}

describe("test_server.py data-behavior tests (ported against queries.js)", () => {
  test("test_list_jobs_empty", () => {
    expect(db.queryJobs(handle, {})).toEqual([]);
    expect(db.countJobs(handle)).toBe(0);
  });

  test("test_list_jobs_with_query_and_total", () => {
    db.insertJobs(handle, [
      makeJob({ job_number: "1", title: "Backend Dev" }),
      makeJob({ job_number: "2", title: "Frontend Dev" }),
    ]);
    const jobs = db.queryJobs(handle, { q: "backend" });
    const total = db.countJobs(handle); // total is UNFILTERED, like fetchJobs()
    expect(total).toBe(2);
    expect(jobs.length).toBe(1);
    expect(jobs[0].title).toBe("Backend Dev");
  });

  test("test_list_jobs_without_q_has_no_match_key", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1" })]);
    const jobs = db.queryJobs(handle, {});
    expect(jobs[0].match).toBeUndefined();
  });

  test("test_list_jobs_with_query_includes_match", () => {
    db.insertJobs(handle, [
      makeJob({ job_number: "1", title: "Backend Dev", description: "Build things", requirements: [], qualifications: [] }),
    ]);
    const [job] = db.queryJobs(handle, { q: "backend" });
    expect(job.match).toEqual({ fields: ["title"], snippet: null });
  });

  test("test_list_jobs_with_query_includes_description_snippet", () => {
    db.insertJobs(handle, [
      makeJob({
        job_number: "1",
        title: "Backend Dev",
        description: "Requires strong Python skills",
        requirements: [],
        qualifications: [],
      }),
    ]);
    const [job] = db.queryJobs(handle, { q: "python" });
    expect(job.match.fields).toEqual(["description"]);
    expect(job.match.snippet.field).toBe("description");
    expect(job.match.snippet.text).toContain("Python");
    for (const column of ["round", "salary", "description", "requirements", "qualifications"]) {
      expect(column in job).toBe(false);
    }
  });

  test("test_list_jobs_with_filters_and_sort", () => {
    db.insertJobs(handle, [
      makeJob({ job_number: "1", employer: "Acme", title: "B" }),
      makeJob({ job_number: "2", employer: "Beta", title: "A" }),
    ]);
    const jobs = db.queryJobs(handle, { filters: { employer: ["Acme"] }, sort: "title" });
    expect(jobs.map((j) => j.job_number)).toEqual(["1"]);
  });

  test("test_get_job_detail_found", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1" })]);
    const [row] = db.queryJobs(handle, {});
    const detail = db.getJob(handle, row.id);
    expect(detail.job_number).toBe("1");
    expect(detail.requirements).toEqual(["Python"]);
    expect(detail.search_text).toBeUndefined();
  });

  test("test_get_job_detail_not_found", () => {
    // The 404 status itself is api.js's job (fetchJob throws a not_found
    // error); at the data layer, a missing id is just null.
    expect(db.getJob(handle, 999)).toBeNull();
  });

  test("test_facets", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1", employer: "Acme" }), makeJob({ job_number: "2", employer: "Acme" })]);
    const facets = db.getFacets(handle);
    expect(facets.employer).toContainEqual({ value: "Acme", count: 2 });
  });

  test("test_delete_jobs_clears_and_returns_count", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1" }), makeJob({ job_number: "2" })]);
    const deleted = db.countJobs(handle); // deleteAllJobs() = count then clear
    db.clearJobs(handle);
    expect(deleted).toBe(2);
    expect(db.countJobs(handle)).toBe(0);
  });

  test("test_ratings_set_list_and_clear", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1", title: "Backend Dev" })]);
    expect(db.listRatings(handle)).toEqual([]);

    expect(db.setRating(handle, "1", 1)).toBe(true);
    let ratings = db.listRatings(handle);
    expect(ratings.length).toBe(1);
    expect(ratings[0].job_number).toBe("1");
    expect(ratings[0].job.title).toBe("Backend Dev");

    // idempotent
    expect(db.setRating(handle, "1", 1)).toBe(true);
    expect(db.listRatings(handle).length).toBe(1);

    db.setRating(handle, "1", 0);
    expect(db.listRatings(handle)).toEqual([]);
  });

  test("test_rating_unknown_job_is_404", () => {
    // setJobRating() in api.js throws a not_found error when this is false.
    expect(db.setRating(handle, "nope", 1)).toBe(false);
  });

  test("test_ratings_survive_delete_all_jobs", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1", title: "Backend Dev" })]);
    db.setRating(handle, "1", 1);
    db.clearJobs(handle);

    const ratings = db.listRatings(handle);
    expect(ratings.length).toBe(1);
    expect(ratings[0].job).toBeNull();
    expect(ratings[0].title).toBe("Backend Dev");
  });

  test("test_export_json", () => {
    db.insertJobs(handle, [makeJob({ job_number: "1" })]);
    const jobs = db.exportJobs(handle);
    expect(jobs.length).toBe(1);
    expect(jobs[0].job_number).toBe("1");
  });

  test("export and import preserves jobs", () => {
    // Insert a job, then verify it survives an export/import round-trip.
    const originalJob = jobFactory({ job_number: "TEST1", title: "Test Job" });
    expect(db.insertJobs(handle, [originalJob])).toBe(1);
    expect(db.countJobs(handle)).toBe(1);

    // Simulate what happens after a user downloads and reopens a database:
    // export the jobs, then clear the table and reimport via insertJobs.
    const exported = db.exportJobs(handle);
    expect(exported.length).toBe(1);
    expect(exported[0].job_number).toBe("TEST1");

    db.clearJobs(handle);
    expect(db.countJobs(handle)).toBe(0);

    // Reimport the exported jobs.
    expect(db.insertJobs(handle, exported)).toBe(1);
    expect(db.countJobs(handle)).toBe(1);

    // Verify the job is intact.
    const reimported = db.queryJobs(handle, { q: "" });
    expect(reimported.length).toBe(1);
    expect(reimported[0].job_number).toBe("TEST1");
    expect(reimported[0].title).toBe("Test Job");
  });
});

// ---------------------------------------------------------------------
// tests/test_server.py tests NOT ported, and why:
//
// - test_health, test_unknown_api_route_is_404, test_spa_missing_dist_returns_hint,
//   test_spa_serves_index_and_assets_and_fallback: there is no server process
//   or SPA static-file host any more; the app is a static bundle.
// - test_scraper_status_*, test_scraper_start_*, test_scraper_cancel,
//   test_scraper_stream_*, test_a_stale_running_last_run_is_reported_as_interrupted,
//   test_a_running_last_run_stays_running_while_the_scrape_runs,
//   test_favorites_order_route_is_gone: these exercise the ScrapeRunner /
//   SSE stream / Flask routing, which are explicitly out of scope for this
//   phase (the scraper endpoints are left unchanged, see the TODO in
//   src/api.js, and get rewired in a later phase).
// ---------------------------------------------------------------------
