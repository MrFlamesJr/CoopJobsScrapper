// Port of tests/test_portal_pagination.py -- cheap tests for JobPortalScraper's
// MudBlazor pager parsing and page-reset recovery, no real browser/DOM.
//
// Real-run evidence this guards against: after scraping pages 1..31 fine, a
// Next click landed the portal on page 2 instead of 32 -- the portal
// (Blazor/MudBlazor) had reset its own pagination state to page 1
// mid-session, and our Next click only moved it one step from there.
// _currentPage/_lastPage read the pager directly instead of trusting a
// counter we increment ourselves, and _goToPage recovers by clicking toward
// the expected page.
//
// The fakes below mirror tests/test_portal_pagination.py's _FakeButton /
// _FakePagerDriver / _FakeRunDriver, adapted from Selenium's
// execute_script/find_elements dispatch to Pager's direct
// dom.querySelector/querySelectorAll calls.

import { describe, expect, it } from "vitest";

import { CARD_SELECTOR, JobPortalScraper } from "./portal.js";
import { FakeClock, neverCancelled } from "./testFakes.js";

class FakeButton {
  constructor(driver, label, targetPage) {
    this._driver = driver;
    this._label = label;
    this._targetPage = targetPage;
  }

  getAttribute(name) {
    return name === "aria-label" ? this._label : null;
  }

  click() {
    this._driver.currentPage = this._targetPage;
  }
}

/**
 * Enough of a fake DOM to exercise pager parsing and goToPage:
 * querySelector/querySelectorAll are dispatched by the selector string (the
 * only ones Pager actually issues), and the numbered pager buttons served
 * reflect whatever `window` (or, by default, just `currentPage`) is
 * "visible" right now, mimicking MudBlazor's windowed pager.
 */
class FakePagerDom {
  constructor({ currentPage, lastPage = null, window: pageWindow = null }) {
    this.currentPage = currentPage;
    this.lastPage = lastPage;
    // Which page numbers have a clickable button "visible" right now.
    // Defaults to a window around the current page plus the last page, like
    // the real pager.
    this.window = pageWindow;
    // Test hook: called before every query, so a test can grow `window` once
    // the driver lands on a particular page (see the "closest visible
    // button" test below).
    this.onQuery = null;
  }

  _pageButtons() {
    if (this.onQuery) this.onQuery(this);
    // Default window (when a test doesn't specify one explicitly): just
    // enough buttons -- current page and last page -- to make the real
    // regex-based parsing in Pager.currentPage()/lastPage() come out right,
    // without a test having to render every page in between. Mirrors
    // Python's fake, which instead let current_page()/last_page() bypass
    // button rendering entirely and return `self.current_page`/`last_page`
    // directly; that shortcut isn't available here since Pager reads real
    // DOM buttons for both.
    const visible =
      this.window !== null
        ? this.window
        : new Set([this.currentPage, this.lastPage].filter((n) => n !== null && n !== undefined));
    return [...visible].map((n) => {
      const label = n === this.currentPage ? `Current page ${n}` : `Page ${n}`;
      return new FakeButton(this, label, n);
    });
  }

  querySelector(selector) {
    if (selector === 'button[aria-label^="Current page "]') {
      return this._pageButtons().find((b) => b.getAttribute("aria-label").startsWith("Current page ")) ?? null;
    }
    return null; // Exact-label lookups (Next page / Previous page) -- not exercised here.
  }

  querySelectorAll(selector) {
    if (selector === "button[aria-label]") {
      return this._pageButtons();
    }
    return []; // Exact-label lookups (Next page / Previous page) -- not exercised here.
  }
}

function scraperFor(dom) {
  return new JobPortalScraper({ dom, searchUrl: "https://example.test", clock: new FakeClock(), isCancelled: neverCancelled });
}

it("test_current_page_parses_current_page_label", () => {
  const scraper = scraperFor(new FakePagerDom({ currentPage: 31 }));
  expect(scraper._currentPage()).toBe(31);
});

it("test_current_page_none_when_pager_absent", () => {
  const scraper = scraperFor(new FakePagerDom({ currentPage: null }));
  expect(scraper._currentPage()).toBeNull();
});

it("test_last_page_is_the_max_visible_page_number", () => {
  const scraper = scraperFor(new FakePagerDom({ currentPage: 31, lastPage: 39 }));
  expect(scraper._lastPage()).toBe(39);
});

it("test_go_to_page_recovers_when_portal_resets_mid_session", async () => {
  // The real-run scenario: expecting page 32, the portal is actually back on
  // page 2 with "Page 32" visible in the pager window. goToPage must click it
  // and land on 32.
  const dom = new FakePagerDom({ currentPage: 2, window: new Set([1, 2, 3, 32]) });
  const scraper = scraperFor(dom);
  scraper.waitForPageReady = async () => {};

  await scraper._goToPage(32);

  expect(dom.currentPage).toBe(32);
});

it("test_go_to_page_clicks_closest_visible_button_when_exact_page_not_shown", async () => {
  // If the exact target page isn't in the pager's window, click the closest
  // numbered button on the correct side and let the next loop iteration
  // re-evaluate (repeating until the target page finally scrolls into the
  // window).
  const dom = new FakePagerDom({ currentPage: 2, window: new Set([1, 2, 3, 5]) });
  // Clicking "Page 5" (closest to 32 that's visible and on the right side)
  // should bring 32 into view on the next call -- simulate that by growing
  // the window.
  dom.onQuery = (driver) => {
    if (driver.currentPage === 5) driver.window = new Set([3, 4, 5, 6, 32]);
  };
  const scraper = scraperFor(dom);
  scraper.waitForPageReady = async () => {};

  await scraper._goToPage(32);

  expect(dom.currentPage).toBe(32);
});

it("test_go_to_page_raises_when_pager_has_no_usable_button", async () => {
  const dom = new FakePagerDom({ currentPage: 2, window: new Set() });
  const scraper = scraperFor(dom);

  await expect(scraper._goToPage(32)).rejects.toThrow("Could not navigate to portal page 32");
});

it("test_verify_current_page_recovers_on_mismatch", async () => {
  const dom = new FakePagerDom({ currentPage: 2, window: new Set([1, 2, 3, 32]) });
  const scraper = scraperFor(dom);
  scraper.waitForPageReady = async () => {};

  await scraper._verifyCurrentPage(32);

  expect(dom.currentPage).toBe(32);
});

it("test_verify_current_page_does_nothing_when_page_matches", async () => {
  const dom = new FakePagerDom({ currentPage: 32, window: new Set([31, 32, 33]) });
  const scraper = scraperFor(dom);
  // No wait_for_page_ready stub needed -- if this called _goToPage it would
  // try to use the real waitForPageReady and hang/fail.
  await scraper._verifyCurrentPage(32);

  expect(dom.currentPage).toBe(32);
});

it("test_visible_page_numbers_parses_both_label_styles", () => {
  const dom = new FakePagerDom({ currentPage: 2, window: new Set([1, 2, 3]) });
  const scraper = scraperFor(dom);

  const pages = scraper._visiblePageNumbers();

  expect(new Set(pages.keys())).toEqual(new Set([1, 2, 3]));
  expect(pages.get(2).getAttribute("aria-label")).toBe("Current page 2");
  expect(pages.get(1).getAttribute("aria-label")).toBe("Page 1");
});

it("test_last_page_reads_the_real_portal_pager_window", () => {
  // The portal's own pager on page 1 renders "Current page 1", "Page 2"..
  // "Page 6", an ellipsis (no aria-label, never shows up here), then "Page
  // 38" and "Page 39" -- which must read as 39 pages, not as 8.
  const dom = new FakePagerDom({ currentPage: 1, lastPage: 39, window: new Set([1, 2, 3, 4, 5, 6, 38, 39]) });
  const scraper = scraperFor(dom);

  expect(new Set(scraper._visiblePageNumbers().keys())).toEqual(new Set([1, 2, 3, 4, 5, 6, 38, 39]));
  expect(scraper._lastPage()).toBe(39);
});

// -- Counting the pages up front (run()) --------------------------------------

class FakeRunDom extends FakePagerDom {
  /** FakePagerDom plus what run() itself touches: a page of job cards to count. */
  constructor({ currentPage, lastPage = null, cards = 0 }) {
    super({ currentPage, lastPage });
    this.cards = Array.from({ length: cards }, () => ({}));
  }

  querySelectorAll(selector) {
    if (selector === CARD_SELECTOR) return [...this.cards];
    return super.querySelectorAll(selector);
  }
}

/**
 * A scraper whose navigation is stubbed out, so run() exercises only its
 * page counting, its loop and its events. scrapeCurrentPage emits one card
 * event so tests can check what the page count is emitted *before*.
 */
function runReadyScraper(dom, onEvent) {
  const scraper = new JobPortalScraper({
    dom,
    searchUrl: "https://example.test",
    clock: new FakeClock(),
    isCancelled: neverCancelled,
    onEvent,
  });
  scraper.waitForPageReady = async () => {};
  scraper._nextPageAvailable = async () => false;
  scraper.scrapeCurrentPage = async (pageNumber) => {
    scraper._emit({ type: "card", page: pageNumber, index: 1, total: 1, title: "Data Analyst" });
    return [];
  };
  return scraper;
}

it("test_run_emits_the_page_count_before_the_first_card", async () => {
  const events = [];
  const dom = new FakeRunDom({ currentPage: 1, lastPage: 39, cards: 20 });
  const scraper = runReadyScraper(dom, (event) => events.push(event));

  await scraper.run();

  expect(events[0]).toEqual({ type: "pages_found", total_pages: 39, cards_per_page: 20 });
  const kinds = events.map((event) => event.type);
  expect(kinds.indexOf("pages_found")).toBeLessThan(kinds.indexOf("card"));
  expect(scraper.totalPages).toBe(39);
});

it("test_run_completes_when_the_pager_cannot_be_read", async () => {
  // A single page of results (or an unreadable pager) means no page count --
  // the run must carry on regardless, just without a total.
  const events = [];
  const dom = new FakeRunDom({ currentPage: null, lastPage: null, cards: 20 });
  const scraper = runReadyScraper(dom, (event) => events.push(event));

  await scraper.run();

  expect(events[0]).toEqual({ type: "pages_found", total_pages: null, cards_per_page: 20 });
  expect(scraper.totalPages).toBeNull();
  expect(events.filter((event) => event.type === "card")).toHaveLength(1);
});

it("test_run_re_emits_the_page_count_when_the_portal_reports_more_pages", async () => {
  // If a later per-page read finds a higher last page (the portal added one,
  // or its pager was unreadable up front), the total is announced again.
  const events = [];
  const dom = new FakeRunDom({ currentPage: 1, lastPage: null, cards: 20 });
  const scraper = runReadyScraper(dom, (event) => events.push(event));
  const readings = [null, 7]; // the up-front read, then the read after page 1
  scraper._lastPage = () => (readings.length ? readings.shift() : 7);

  await scraper.run();

  const counts = events.filter((event) => event.type === "pages_found");
  expect(counts.map((event) => event.total_pages)).toEqual([null, 7]);
  expect(counts[1].cards_per_page).toBe(20);
  expect(scraper.totalPages).toBe(7);
});
