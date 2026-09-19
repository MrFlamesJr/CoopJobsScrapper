// Port of tests/test_portal_retry.py -- cheap tests for JobPortalScraper's
// end-of-run retry pass, no real browser/DOM.
//
// _scrapeCard and the navigation helpers are faked at the method level
// rather than driven through a full DOM script sequence: _retryFailedCards'
// own bookkeeping (which pages get revisited, how a card is relocated by its
// text, what gets reported and what gets dropped from the failure list)
// doesn't depend on any of that machinery.

import { expect, it } from "vitest";

import { CARD_SELECTOR, JobPortalScraper } from "./portal.js";
import { FakeClock, neverCancelled } from "./testFakes.js";

class FakeCard {
  constructor(text) {
    this.text = text;
  }
}

/** querySelectorAll(CARD_SELECTOR) returns whatever `cards` currently holds. */
class FakeDom {
  constructor(cards) {
    this.cards = cards;
  }

  querySelectorAll(selector) {
    if (selector !== CARD_SELECTOR) throw new Error(`unexpected selector ${selector}`);
    return this.cards;
  }
}

function scraperFor(cards = []) {
  return new JobPortalScraper({
    dom: new FakeDom([...cards]),
    searchUrl: "https://example.test",
    clock: new FakeClock(),
    isCancelled: neverCancelled,
  });
}

function stubNavigation(scraper) {
  scraper._goToPage = async () => {};
  scraper.waitForPageReady = async () => {};
}

it("test_retry_finds_card_by_exact_text_not_the_recorded_index", async () => {
  // Cards can shift position between the main pass and the retry pass --
  // the card must be relocated by its exact normalized text, not the stale
  // index.
  const scraper = scraperFor([new FakeCard("Other Job Other Co"), new FakeCard("Target Job Target Co")]);
  scraper._skippedCards = [
    { page: 2, index: 0, card_text: "target job target co", title: "Target Job", employer: "Target Co" },
  ];
  stubNavigation(scraper);
  const seenIndexes = [];
  scraper._scrapeCard = async (_page, index, _expectedCount) => {
    seenIndexes.push(index);
    return { job_number: "J5", title: "Target Job", employer: "Target Co" };
  };
  const reported = [];
  scraper.pageCallback = (page, jobs) => reported.push([page, jobs]);

  await scraper._retryFailedCards();

  expect(seenIndexes).toEqual([1]); // found by text, not the recorded (now stale) index 0
  expect(reported).toEqual([[2, [{ job_number: "J5", title: "Target Job", employer: "Target Co" }]]]);
  expect(scraper._skippedCards).toEqual([]);
  expect(scraper.failed).toEqual([]);
});

it("test_retry_falls_back_to_recorded_index_when_text_match_is_not_unique", async () => {
  const scraper = scraperFor([new FakeCard("Same Job Same Co"), new FakeCard("Same Job Same Co")]);
  scraper._skippedCards = [
    { page: 1, index: 1, card_text: "same job same co", title: "Same Job", employer: "Same Co" },
  ];
  stubNavigation(scraper);
  const seenIndexes = [];
  scraper._scrapeCard = async (_page, index, _expectedCount) => {
    seenIndexes.push(index);
    return { job_number: "J1" };
  };
  scraper.pageCallback = () => {};

  await scraper._retryFailedCards();

  expect(seenIndexes).toEqual([1]); // ambiguous (two identical cards) -> fall back to the recorded index
});

it("test_retry_pass_drops_a_fixed_card_but_keeps_a_final_failure", async () => {
  // A card that fails again on retry re-records itself via _scrapeCard's own
  // normal failure path; a successful retry must be dropped from the
  // failure list entirely, not just left alongside the still-broken one.
  const scraper = scraperFor([new FakeCard("Fixed Job Fixed Co"), new FakeCard("Still Broken Job Broken Co")]);
  scraper._skippedCards = [
    { page: 3, index: 0, card_text: "fixed job fixed co", title: "Fixed Job", employer: "Fixed Co" },
    {
      page: 3,
      index: 1,
      card_text: "still broken job broken co",
      title: "Still Broken Job",
      employer: "Broken Co",
    },
  ];
  stubNavigation(scraper);

  scraper._scrapeCard = async (page, index, _expectedCount) => {
    if (index === 0) return { job_number: "J1", title: "Fixed Job", employer: "Fixed Co" };
    scraper._skippedCards.push({
      page,
      index,
      card_text: "still broken job broken co",
      title: "Still Broken Job",
      employer: "Broken Co",
    });
    return null;
  };
  const reported = [];
  scraper.pageCallback = (page, jobs) => reported.push([page, jobs]);

  await scraper._retryFailedCards();

  expect(reported).toEqual([[3, [{ job_number: "J1", title: "Fixed Job", employer: "Fixed Co" }]]]);
  expect(scraper.failed).toEqual([{ page: 3, title: "Still Broken Job", employer: "Broken Co" }]);
});

it("test_retry_pass_visits_each_failed_page_once_in_ascending_order", async () => {
  const scraper = scraperFor([new FakeCard("Job A Co A"), new FakeCard("Job B Co B")]);
  scraper._skippedCards = [
    { page: 9, index: 0, card_text: "job c co c", title: "Job C", employer: "Co C" },
    { page: 5, index: 0, card_text: "job a co a", title: "Job A", employer: "Co A" },
    { page: 5, index: 1, card_text: "job b co b", title: "Job B", employer: "Co B" },
  ];
  const visitedPages = [];
  scraper._goToPage = async (page) => visitedPages.push(page);
  scraper.waitForPageReady = async () => {};
  scraper._scrapeCard = async (page, index, _expectedCount) => ({ job_number: `J${page}-${index}` });
  scraper.pageCallback = () => {};

  await scraper._retryFailedCards();

  expect(visitedPages).toEqual([5, 9]);
});

it("test_retry_pass_does_nothing_when_there_are_no_failures", async () => {
  const scraper = scraperFor([]);

  await scraper._retryFailedCards();

  expect(scraper._skippedCards).toEqual([]);
  expect(scraper.failed).toEqual([]);
});
