/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readUrlState, writeUrlState } from "./urlState.js";

// Mock window.location and history
let mockLocation;
let mockHistory;

beforeEach(() => {
  // Reset URL to clean state
  window.history.replaceState(null, "", "/");
});

test("readUrlState returns defaults when URL is empty", () => {
  window.history.replaceState(null, "", "/");
  const state = readUrlState();
  expect(state).toEqual({
    q: "",
    sorts: [{ field: "employer", dir: "asc" }],
    ratingFilter: "all",
    deadlineMode: "open",
    facetFilters: {},
  });
});

test("readUrlState parses search query", () => {
  window.history.replaceState(null, "", "/?q=python");
  const state = readUrlState();
  expect(state.q).toBe("python");
});

test("readUrlState parses sort fields and directions", () => {
  window.history.replaceState(null, "", "/?sort=title:desc,deadline:asc");
  const state = readUrlState();
  expect(state.sorts).toEqual([
    { field: "title", dir: "desc" },
    { field: "deadline", dir: "asc" },
  ]);
});

test("readUrlState parses rating filter", () => {
  window.history.replaceState(null, "", "/?rating=liked");
  const state = readUrlState();
  expect(state.ratingFilter).toBe("liked");

  window.history.replaceState(null, "", "/?rating=hide_disliked");
  const state2 = readUrlState();
  expect(state2.ratingFilter).toBe("hide_disliked");
});

test("readUrlState parses deadline mode", () => {
  window.history.replaceState(null, "", "/?closed=show");
  const state = readUrlState();
  expect(state.deadlineMode).toBe("all");
});

test("readUrlState parses facet filters", () => {
  window.history.replaceState(null, "", "/?f.employer=Acme&f.employer=Beta&f.location=Toronto");
  const state = readUrlState();
  expect(state.facetFilters).toEqual({
    employer: ["Acme", "Beta"],
    location: ["Toronto"],
  });
});

test("readUrlState drops unknown sort fields", () => {
  window.history.replaceState(null, "", "/?sort=bogus:asc,employer:desc");
  const state = readUrlState();
  expect(state.sorts).toEqual([{ field: "employer", dir: "desc" }]);
});

test("readUrlState drops unknown facet fields", () => {
  window.history.replaceState(null, "", "/?f.bogus=val&f.employer=Acme");
  const state = readUrlState();
  expect(state.facetFilters).toEqual({ employer: ["Acme"] });
});

test("readUrlState ignores invalid rating and direction values", () => {
  window.history.replaceState(null, "", "/?rating=bogus&sort=employer:invalid");
  const state = readUrlState();
  expect(state.ratingFilter).toBe("all");
  expect(state.sorts).toEqual([{ field: "employer", dir: "asc" }]);
});

test("writeUrlState omits defaults from URL", () => {
  window.history.replaceState(null, "", "/");
  writeUrlState({
    q: "",
    sorts: [{ field: "employer", dir: "asc" }],
    ratingFilter: "all",
    deadlineMode: "open",
    facetFilters: {},
  });
  expect(window.location.search).toBe("");
  expect(window.location.pathname).toBe("/");
});

test("writeUrlState includes non-default values", () => {
  window.history.replaceState(null, "", "/");
  writeUrlState({
    q: "python",
    sorts: [{ field: "title", dir: "desc" }],
    ratingFilter: "liked",
    deadlineMode: "all",
    facetFilters: { employer: ["Acme"] },
  });
  const search = window.location.search;
  expect(search).toContain("q=python");
  // URLSearchParams encodes : as %3A
  expect(search).toContain("sort=title%3Adesc");
  expect(search).toContain("rating=liked");
  expect(search).toContain("closed=show");
  expect(search).toContain("f.employer=Acme");
});

test("round-trip preserves state", () => {
  const original = {
    q: "java",
    sorts: [
      { field: "employer", dir: "asc" },
      { field: "myrating", dir: "desc" },
    ],
    ratingFilter: "hide_disliked",
    deadlineMode: "all",
    facetFilters: { employer: ["Acme", "Beta"], location: ["Toronto"] },
  };

  writeUrlState(original);
  const restored = readUrlState();

  expect(restored).toEqual(original);
});

test("readUrlState with junk URL values falls back to defaults", () => {
  window.history.replaceState(null, "", "/?q=&sort=invalid&rating=bogus&f.unknown=val&closed=invalid");
  const state = readUrlState();
  expect(state).toEqual({
    q: "",
    sorts: [{ field: "employer", dir: "asc" }],
    ratingFilter: "all",
    deadlineMode: "open",
    facetFilters: {},
  });
});
