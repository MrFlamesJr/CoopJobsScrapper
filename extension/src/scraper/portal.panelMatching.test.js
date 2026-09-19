// Port of tests/test_portal_panel_matching.py -- cheap tests for
// JobPortalScraper's panel-matching, cross-check safety valve and live
// progress events, no real browser/DOM.
//
// Selenium's `_FakeDriver.execute_script` (one scripted snapshot per call, in
// order) becomes an override of `readPanelSnapshot` (the overridable hook
// portal.js exposes in place of a direct DOM read -- see its constructor).
// Module-level monkeypatches (PANEL_SETTLE_SECONDS, PANEL_OPEN_TIMEOUT_SECONDS,
// CARD_RETRY_ATTEMPTS) become per-instance field overrides (panelSettleMs,
// panelOpenTimeoutMs, cardRetryAttempts -- see portal.js's module docstring).
// caplog becomes a `log` override collecting {level, message} entries.

import { expect, it } from "vitest";

import { normalizeText } from "./panelParser.js";
import {
  CARD_SELECTOR,
  CROSS_CHECK_SAFETY_CARDS,
  DuplicateListing,
  JobPortalScraper,
  PanelMismatch,
  Timeout,
} from "./portal.js";
import { FakeClock, neverCancelled } from "./testFakes.js";

function makeScraper({ snapshots = null, onEvent = null, log = null, pageCallback = null, dom } = {}) {
  const scraper = new JobPortalScraper({
    dom,
    searchUrl: "https://example.test",
    clock: new FakeClock(),
    isCancelled: neverCancelled,
    onEvent,
    pageCallback,
    log,
  });
  if (snapshots !== null) {
    const queue = [...snapshots];
    scraper.readPanelSnapshot = () => (queue.length ? queue.shift() : null);
  }
  return scraper;
}

/** Minimal panel markup: an #orgname element and a "Job Number" metadata
 * item, just enough for parseJobPanel to pull out displayed_title/job_number. */
function panelHtml(jobNumber = "", title = "", employer = "") {
  const orgname = title || employer ? `${title}, ${employer}` : "";
  return (
    `<div><div id="orgname">${orgname}</div>` + `<div role="listitem">Job Number: ${jobNumber}</div></div>`
  );
}

function panelHtmlWithWorkModel(jobNumber, title, employer, workModel) {
  return panelHtml(jobNumber, title, employer) + `<div role="listitem">Work model: ${workModel}</div>`;
}

it("test_wait_for_matching_panel_accepts_already_visible_panel_immediately", async () => {
  // The portal can pre-select a job's panel before the click ever lands -- on
  // any page, not just the first. A panel that already matches the card is
  // accepted right away, even when _lastJobNumber is set (i.e. this isn't the
  // first card of the run). A matching snapshot must still settle (read
  // identical twice) before acceptance.
  const preselected = { html: "<div>first</div>", text: "First Job at First Co" };
  const scraper = makeScraper({ snapshots: [preselected, preselected] });
  scraper.panelSettleMs = 0;
  scraper._lastJobNumber = "J1";

  const html = await scraper._waitForMatchingPanel("First Job", "First Co");

  expect(html).toBe(preselected.html);
});

it("test_wait_for_matching_panel_polls_until_it_matches", async () => {
  const stale = { html: "<div>old</div>", text: "Old Job at Old Co" };
  const fresh = { html: "<div>new</div>", text: "New Job at New Co" };
  const scraper = makeScraper({ snapshots: [stale, stale, fresh, fresh] });
  scraper.panelSettleMs = 0;

  const html = await scraper._waitForMatchingPanel("New Job", "New Co");

  expect(html).toBe(fresh.html);
});

it("test_wait_for_matching_panel_accepts_new_job_number_immediately", async () => {
  // A panel that identity-matches AND already shows a different job number
  // than last time is accepted right away (once settled) -- no need to wait
  // it out.
  const snapshot = {
    html: panelHtml("J2", "New Job", "New Co"),
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const scraper = makeScraper({ snapshots: [snapshot, snapshot] });
  scraper.panelSettleMs = 0;
  scraper._lastJobNumber = "J1";

  const html = await scraper._waitForMatchingPanel("New Job", "New Co");

  expect(html).toBe(snapshot.html);
});

it("test_wait_for_matching_panel_switches_from_old_job_number_to_new", async () => {
  // The panel can identity-match right away but still show the previous
  // job's number for a few polls before it catches up -- that must not be
  // mistaken for a duplicate listing; polling continues until the number
  // actually changes.
  const staleNumber = {
    html: panelHtml("J1", "New Job", "New Co"),
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const freshNumber = {
    html: panelHtml("J2", "New Job", "New Co"),
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const scraper = makeScraper({ snapshots: [staleNumber, staleNumber, freshNumber, freshNumber] });
  scraper.panelSettleMs = 0;
  scraper._lastJobNumber = "J1";

  const html = await scraper._waitForMatchingPanel("New Job", "New Co");

  expect(html).toBe(freshNumber.html);
});

it("test_wait_for_matching_panel_requires_two_identical_reads_before_accepting", async () => {
  // Real evidence: the portal can briefly render a HALF-UPDATED detail panel
  // -- one atomic snapshot had the right header/job number but another job's
  // "Work model" value. A matching, fresh snapshot that then CHANGES on
  // re-read must not be accepted; only once two consecutive reads are
  // byte-identical is it trusted.
  const halfRendered = {
    html: `${panelHtml("J2", "New Job", "New Co")}<div>Work model: Remote</div>`,
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const settled = {
    html: `${panelHtml("J2", "New Job", "New Co")}<div>Work model: Onsite</div>`,
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const scraper = makeScraper({ snapshots: [halfRendered, settled, settled] });
  scraper.panelSettleMs = 0;
  scraper._lastJobNumber = "J1";

  const html = await scraper._waitForMatchingPanel("New Job", "New Co");

  expect(html).toBe(settled.html);
  expect(html).not.toBe(halfRendered.html);
});

it("test_wait_for_matching_panel_raises_duplicate_listing_when_job_number_never_changes", async () => {
  // If the panel matches but keeps showing the previous job's number for the
  // whole wait, it's a genuine duplicate listing (two cards, one posting),
  // not a slow panel.
  const stuck = {
    html: panelHtml("J1", "Same Job", "Same Co"),
    text: "Same Job at Same Co",
    orgname: "Same Job, Same Co",
  };
  const scraper = makeScraper({ snapshots: Array(50).fill(stuck) });
  scraper.panelOpenTimeoutMs = 300;
  scraper._lastJobNumber = "J1";

  let error;
  try {
    await scraper._waitForMatchingPanel("Same Job", "Same Co");
  } catch (exc) {
    error = exc;
  }

  expect(error).toBeInstanceOf(DuplicateListing);
  expect(error.jobNumber).toBe("J1");
  expect(error.html).toBe(stuck.html);
});

it("test_panel_matches_uses_orgname_identity_key_not_substring_containment", () => {
  // Card titles can be a prefix of another card's title at the same employer
  // ("Software Developer Intern" vs "Software Developer Intern, MyGeotab").
  // Plain substring containment would match the shorter title against the
  // longer panel; the orgname-based identity key must not.
  const longerCardOrgname = "Software Developer Intern, MyGeotab, MyGeotab";

  const matchesShorterTitle = JobPortalScraper._panelMatches(
    "Software Developer Intern",
    "MyGeotab",
    "",
    longerCardOrgname
  );
  const matchesExactTitle = JobPortalScraper._panelMatches(
    "Software Developer Intern, MyGeotab",
    "MyGeotab",
    "",
    longerCardOrgname
  );

  expect(matchesShorterTitle).toBe(false);
  expect(matchesExactTitle).toBe(true);
});

it("test_panel_matches_falls_back_to_containment_without_orgname_text", () => {
  expect(JobPortalScraper._panelMatches("New Job", "New Co", "New Job at New Co", "")).toBe(true);
  expect(JobPortalScraper._panelMatches("New Job", "New Co", "Old Job at Old Co", "")).toBe(false);
});

// -- Card/panel cross-check --------------------------------------------------
//
// Real-run evidence: one atomic panel snapshot had job 752's correct
// header/job number but another job's "Work model" value -- identity
// matching alone can't catch that. Each non-empty parsed
// location/work_model/deadline_text must also appear in the card's own
// (pre-click) text; a mismatch is treated like an unsettled panel (keep
// polling) rather than an immediate failure.

it("test_wait_for_matching_panel_treats_cross_check_mismatch_as_unsettled_then_accepts_match", async () => {
  // A settled, identity+freshness-matched panel that disagrees with the
  // card's own text (e.g. the wrong Work model) must not be accepted or
  // immediately failed -- it's polled again, exactly like an unsettled
  // panel, until a later read agrees.
  const cardText = normalizeText("New Job New Co Ottawa Hybrid Deadline: 2026-09-30");
  const wrong = {
    html: panelHtmlWithWorkModel("J2", "New Job", "New Co", "Remote"),
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const right = {
    html: panelHtmlWithWorkModel("J2", "New Job", "New Co", "Hybrid"),
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const scraper = makeScraper({ snapshots: [wrong, wrong, right, right] });
  scraper.panelSettleMs = 0;
  scraper._lastJobNumber = "J1";

  const html = await scraper._waitForMatchingPanel("New Job", "New Co", cardText);

  expect(html).toBe(right.html);
});

it("test_wait_for_matching_panel_raises_panel_mismatch_when_cross_check_never_resolves", async () => {
  // If the cross-check never resolves before the deadline, it's an anomaly
  // (PanelMismatch, retried by the caller like any other) -- not a silent
  // skip -- and the message names the field, the card's own text, and the
  // panel's value.
  const cardText = normalizeText("New Job New Co Ottawa Hybrid Deadline: 2026-09-30");
  const wrong = {
    html: panelHtmlWithWorkModel("J2", "New Job", "New Co", "Remote"),
    text: "New Job at New Co",
    orgname: "New Job, New Co",
  };
  const scraper = makeScraper({ snapshots: Array(200).fill(wrong) });
  scraper.panelSettleMs = 0;
  scraper.panelOpenTimeoutMs = 300;
  scraper._lastJobNumber = "J1";

  let error;
  try {
    await scraper._waitForMatchingPanel("New Job", "New Co", cardText);
  } catch (exc) {
    error = exc;
  }

  expect(error).toBeInstanceOf(PanelMismatch);
  const message = error.message;
  expect(message).toContain("work_model");
  expect(message).toContain("Remote");
  expect(message).toContain("hybrid"); // the card's own (normalized) text, for context
});

it("test_cross_check_safety_valve_disables_field_after_first_cards_all_mismatch", () => {
  // If a field mismatches on every one of the first CROSS_CHECK_SAFETY_CARDS
  // cards where identity matched, the live text format for that field
  // probably just doesn't line up with the panel's -- not a real data bug --
  // so checking it is disabled for the rest of the run, with exactly one
  // WARNING log line.
  const logs = [];
  const scraper = makeScraper({ snapshots: [], log: (level, message) => logs.push({ level, message }) });

  for (let i = 0; i < CROSS_CHECK_SAFETY_CARDS; i += 1) {
    scraper._recordCrossCheckOutcome({ work_model: "Remote" });
  }

  expect(scraper._crossCheckDisabledFields).toEqual(new Set(["work_model"]));
  const disablingMessages = logs.filter(
    (entry) => entry.level === "warn" && entry.message.includes("work_model") && entry.message.includes("disabling")
  );
  expect(disablingMessages).toHaveLength(1);

  // Once disabled, the check is skipped even though the panel value still
  // isn't in the card's text.
  const html = panelHtmlWithWorkModel("J9", "New Job", "New Co", "Remote");
  expect(scraper._crossCheckMismatches(html, "new job new co onsite")).toEqual({});
});

it("test_cross_check_safety_valve_does_not_trip_once_a_card_matches", () => {
  // A field that matches on at least one of the first few cards must not be
  // disabled -- only a mismatch on EVERY one of them trips the valve.
  const scraper = makeScraper({ snapshots: [] });

  scraper._recordCrossCheckOutcome({ work_model: "Remote" });
  scraper._recordCrossCheckOutcome({}); // this card's work_model matched
  for (let i = 0; i < CROSS_CHECK_SAFETY_CARDS - 2; i += 1) {
    scraper._recordCrossCheckOutcome({ work_model: "Remote" });
  }

  expect(scraper._crossCheckDisabledFields.has("work_model")).toBe(false);
});

// -- Live progress events (the optional onEvent callback) ---------------------
//
// ScrapeRunner turns these into its live status and saves each `scraped` job
// to the database as it arrives. A run without a callback must behave
// exactly as it did before, and a callback must never be able to break a
// scrape.

function fakeCardsDom(count) {
  return {
    querySelectorAll(selector) {
      return selector === CARD_SELECTOR ? Array.from({ length: count }, () => ({})) : [];
    },
  };
}

it("test_emit_is_a_no_op_without_a_callback_and_never_breaks_a_scrape", () => {
  const silent = makeScraper({ snapshots: [] });
  silent._emit({ type: "card", page: 1 }); // no callback: nothing happens, nothing raises

  const logs = [];
  const noisy = makeScraper({
    snapshots: [],
    onEvent: () => {
      throw new Error("callback bug");
    },
    log: (level, message) => logs.push({ level, message }),
  });
  noisy._emit({ type: "card", page: 1 });

  expect(logs.some((entry) => entry.message.includes("on_event"))).toBe(true);
});

it("test_scraped_event_fires_once_per_accepted_job_after_the_duplicate_check", async () => {
  // One `scraped` event per job that is actually kept -- not for the
  // portal's duplicate listing, not for the card that failed -- each
  // carrying the job dict.
  const events = [];
  const cards = [
    { job_number: "J1", title: "A", employer: "Acme" },
    { job_number: "J1", title: "A", employer: "Acme" }, // same number: duplicate
    { job_number: "", title: "B", employer: "Acme" }, // no number: still kept
    null, // card that exhausted its attempts
  ];
  const scraper = makeScraper({ snapshots: [], onEvent: (event) => events.push(event), dom: fakeCardsDom(cards.length) });
  scraper._scrapeCard = async (page, index, total) => cards[index];

  const kept = await scraper.scrapeCurrentPage(1);

  const scraped = events.filter((event) => event.type === "scraped");
  expect(scraped.map((event) => event.job)).toEqual(kept);
  expect(kept).toEqual([cards[0], cards[2]]);
  expect(scraped.map((event) => event.index)).toEqual([1, 3]);
  expect(scraped[0].total).toBe(4);
  expect(scraper.duplicates).toBe(1);
});

it("test_retry_pass_announces_itself_and_emits_scraped_for_recovered_jobs", async () => {
  // The retry pass reports a recovered job through the same `scraped` event
  // as the main sweep (so the runner saves it exactly once) and still hands
  // the page callback its page jobs.
  const events = [];
  const recovered = { job_number: "J7", title: "A", employer: "Acme" };
  const pages = [];
  const scraper = makeScraper({
    snapshots: [],
    onEvent: (event) => events.push(event),
    pageCallback: (page, jobs) => pages.push([page, jobs]),
    dom: fakeCardsDom(3),
  });
  scraper._skippedCards = [{ page: 2, index: 1, card_text: "", title: "A", employer: "Acme" }];
  scraper._goToPage = async () => {};
  scraper.waitForPageReady = async () => {};
  scraper._scrapeCard = async (page, index, total) => recovered;

  await scraper._retryFailedCards();

  expect(events.map((event) => event.type)).toEqual(["retry_pass", "scraped"]);
  expect(events[0]).toEqual({ type: "retry_pass", cards: 1, pages: 1 });
  expect(events[1].job).toBe(recovered);
  expect(events[1].page).toBe(2);
  expect(pages).toEqual([[2, [recovered]]]);
});

it("test_scrape_card_emits_card_once_then_a_retry_per_attempt_then_skipped", async () => {
  const events = [];
  const scraper = makeScraper({ snapshots: [], onEvent: (event) => events.push(event), dom: fakeCardsDom(1) });
  scraper.cardRetryAttempts = 2;
  scraper._closeDetailPanel = async () => {};
  scraper._getCard = () => ({});
  scraper._readCardText = (card, selector) => (selector === "#opptitle" ? "Data Analyst" : "Acme");
  scraper._readFullCardText = () => "data analyst acme";
  scraper._click = () => {};
  scraper._fullPageHtml = () => "";
  scraper._waitForMatchingPanel = async () => {
    throw new Timeout("panel never matched");
  };

  const result = await scraper._scrapeCard(2, 4, 20);

  expect(result).toBeNull();
  expect(events.map((event) => event.type)).toEqual(["card", "retry", "retry", "skipped"]);
  expect(events[0]).toEqual({
    type: "card",
    page: 2,
    index: 5, // 1-based, as the UI shows it
    total: 20,
    title: "Data Analyst",
    employer: "Acme",
  });
  expect(events.slice(1, 3).map((event) => event.attempt)).toEqual([1, 2]);
  expect(events[events.length - 1].reason).toContain("panel never matched");
});
