// Test-only helper: a thin sync DB handle backed by better-sqlite3 (a real,
// synchronous SQLite implementation), matching the {exec, run} contract that
// queries.js expects from the sqlite-wasm-backed handle in worker.js. Lets
// queries.js run against a real in-memory sqlite database in Node.

import Database from "better-sqlite3";
import schemaSql from "./schema.sql?raw";
import { initDb } from "./queries.js";

export function createHandle() {
  const db = new Database(":memory:");
  const handle = {
    exec(sql, params = []) {
      return db.prepare(sql).all(params);
    },
    run(sql, params = []) {
      const info = db.prepare(sql).run(params);
      return { changes: info.changes };
    },
  };
  initDb(handle, schemaSql);
  return { handle, db };
}

/** Same shape/defaults as tests/conftest.py's `job_factory` fixture: call
 * `createJobFactory()` once per test to get a fresh per-test counter. */
export function createJobFactory() {
  let n = 0;
  return (overrides = {}) => {
    n += 1;
    return {
      job_number: `J${n}`,
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
      requirements: ["Python", "SQL"],
      qualifications: [{ name: "Year", value: "3rd" }],
      page_number: 1,
      ...overrides,
    };
  };
}
