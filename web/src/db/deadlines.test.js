// Port of tests/test_deadlines.py, same cases and (as close as vitest allows)
// the same test names.

import { describe, expect, test } from "vitest";
import { parseDeadline } from "./deadlines.js";

describe("test_parse_deadline_recognized_formats", () => {
  test.each([
    ["2026-01-05", "2026-01-05"],
    ["Jan 5, 2026", "2026-01-05"],
    ["January 5, 2026", "2026-01-05"],
    ["5 Jan 2026", "2026-01-05"],
    ["5 January 2026", "2026-01-05"],
    ["2026/01/05", "2026-01-05"],
    ["01/05/2026", "2026-01-05"],
    ["Monday, January 5, 2026", "2026-01-05"],
    ["Mon, Jan 5, 2026", "2026-01-05"],
    ["Jan 5 2026", "2026-01-05"],
    ["Deadline: Jan 5, 2026", "2026-01-05"],
    ["Deadline: Jan 5, 2026 at 11:59 PM", "2026-01-05"],
    ["Jan 5, 2026 23:59", "2026-01-05"],
    ["Jan 5, 2026 11:59 PM EST", "2026-01-05"],
    ["Jan 5, 2026 at 5:00 p.m.", "2026-01-05"],
    ["Sept 5, 2026", "2026-09-05"],
    ["Sept. 5, 2026", "2026-09-05"],
    ["Application Deadline: 5 January 2026", "2026-01-05"],
    ["January 5th, 2026", "2026-01-05"],
    ["  Jan 5, 2026  ", "2026-01-05"],
  ])("parses %s", (text, expected) => {
    expect(parseDeadline(text)).toBe(expected);
  });
});

describe("test_parse_deadline_returns_none_for_garbage", () => {
  test.each([[""], [null], ["asdfasdf"], ["Rolling"], ["Open until filled"], ["TBD"], ["Not a date at all: 42"]])(
    "rejects %s",
    (text) => {
      expect(parseDeadline(text)).toBeNull();
    },
  );
});
