// Error classes shared by pager.js and portal.js.
//
// Port of the exception classes in app/scraper/portal.py (plus the built-in
// Selenium exceptions the Python code catches). Kept in their own module
// (rather than defined in portal.js, which owns Pager's host) so pager.js can
// import them without a circular import between pager.js and portal.js -- the
// same reason app/scraper/pager.py duplicates CARD_SELECTOR instead of
// importing it back from portal.py.

/** Raised to unwind the scrape when isCancelled() reports true. */
export class Cancelled extends Error {
  constructor(message = "Scrape was cancelled.") {
    super(message);
    this.name = "Cancelled";
  }
}

/** Raised when the open detail panel does not match the card that was clicked. */
export class PanelMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = "PanelMismatch";
  }
}

/**
 * Raised when the portal genuinely lists the same job twice in a row.
 *
 * The panel matched the clicked card's title/employer identity, but its job
 * number stayed on the previous card's for the whole wait -- not a slow
 * update, but two consecutive cards for one real posting. Not retried:
 * retrying can't change what the portal is actually showing.
 */
export class DuplicateListing extends Error {
  constructor(message, jobNumber, html) {
    super(message);
    this.name = "DuplicateListing";
    this.jobNumber = jobNumber;
    this.html = html;
  }
}

/**
 * Port of BrowserClosed. Renamed per the porting spec: the extension has a
 * portal *tab*, not a whole controlled browser window/process, so "the tab
 * was closed (or navigated away/reloaded so the content script died)" is the
 * closer description. Same semantics as Python: raised when the user closed
 * the browser window/tab -- never retried, always fatal.
 */
export class TabClosed extends Error {
  constructor(message = "Browser window was closed.") {
    super(message);
    this.name = "TabClosed";
  }
}

/**
 * Port of Selenium's StaleElementReferenceException. A real DOM element
 * reference doesn't throw on stale access the way a WebDriver element proxy
 * does, so callers that relied on that (see portal.py's `_click`,
 * `page_has_advanced`) check `!el.isConnected` and throw this explicitly so
 * the same CARD_RETRY_ATTEMPTS retry path still runs.
 */
export class StaleElement extends Error {
  constructor(message = "stale element reference: element is not attached to the page document") {
    super(message);
    this.name = "StaleElement";
  }
}

/** Port of Selenium's TimeoutException, raised by waitUntil(). */
export class Timeout extends Error {
  constructor(message = "") {
    super(message);
    this.name = "Timeout";
  }
}

/**
 * Port of the bare `RuntimeError`s portal.py/pager.py raise for "this should
 * never happen, fail loudly" conditions (card disappeared, next-page button
 * never became clickable, go_to_page exhausted its click budget, card list
 * never came back after closing the panel). Caught by the same retry path as
 * StaleElement/Timeout/PanelMismatch in _scrapeCard, exactly like Python's
 * `except (StaleElementReferenceException, TimeoutException, PanelMismatch, RuntimeError)`.
 */
export class ScraperError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScraperError";
  }
}
