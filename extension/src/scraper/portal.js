// Content-script-side navigation for the co-op jobs portal.
//
// Port of app/scraper/portal.py. Drives the DOM directly (no WebDriver layer
// in this execution model -- see the module docstring in the Python source
// for the full rationale behind every fix described below; it all still
// applies here):
//   * Card list first -- an open panel is dismissed and the full card list
//     must be back before the next card is clicked. The panel itself may
//     stay visible (split view), so a visible panel is accepted as soon as it
//     matches AND its job number is no longer the previous card's (see
//     _waitForMatchingPanel); a panel stuck on the old job number for the
//     whole wait means the portal genuinely lists that job twice
//     (DuplicateListing).
//   * Identity check -- #orgname may be hidden-but-still-in-the-DOM right
//     after closing, and (when visible) reads exactly "<title>, <employer>".
//     The primary check strips punctuation/spaces from both sides and
//     compares them for exact equality, falling back to substring
//     containment only when no #orgname text is available.
//   * Atomic read -- one synchronous read (panelSnapshot, replacing Selenium's
//     one execute_script call) finds the visible panel, walks up to its root,
//     and returns its outerHTML and text together.
//   * Pagination race -- Next is only considered to have worked once the old
//     page's first card actually goes stale or changes; see pager.js.
//   * Portal-side page resets -- tracked via the portal's own pager (pager.js)
//     rather than a counter this module increments itself.
//   * Card/panel cross-check -- each non-empty parsed location/work_model/
//     deadline_text must also appear in the clicked card's own (pre-click)
//     text; a mismatch is treated like an unsettled panel and polled again.
//   * Retry pass -- cards that exhaust their attempts are revisited once,
//     page by page, after the main sweep (see _retryFailedCards).
//
// Execution-model mapping from the Python/Selenium port (see the phase 4
// porting brief for the full list):
//   * `dom` (default: `document`), `clock` ({now(), sleep(ms)}), `isCancelled()`,
//     `onEvent`, `readyCallback`, `pageCallback`, `snapshotSink(category, name,
//     {json, html})` are injected via the constructor instead of a Selenium
//     `driver` + threading.Event + debug_dir.
//   * WebDriverWait.until -> waitUntil() (this.waitUntil), polling via
//     clock.sleep every DEFAULT_POLL_MS (500ms, Selenium's own default poll
//     frequency), checking cancellation every poll, throwing Timeout on
//     expiry.
//   * Module-level Python constants that the Python tests monkeypatch
//     (PANEL_SETTLE_SECONDS, PANEL_OPEN_TIMEOUT_SECONDS, CARD_RETRY_ATTEMPTS)
//     are instance fields here (this.panelSettleMs, this.panelOpenTimeoutMs,
//     this.cardRetryAttempts) seeded from the exported constants, since an
//     ES module's exported `const` bindings can't be reassigned from outside
//     the module the way `monkeypatch.setattr(module, name, value)` can.
//     Tests set them directly on the instance instead.
//   * Selenium's implicit StaleElementReferenceException on a dead element
//     reference has no DOM equivalent (a JS Element reference never throws),
//     so `_click` and `_readCardText`/`_readFullCardText` explicitly check
//     `!element.isConnected`; `_click` throws StaleElement (so the same
//     CARD_RETRY_ATTEMPTS retry path in _scrapeCard runs), while the card-text
//     readers return "" (matching Python's own `_read_card_text`, which
//     *catches* WebDriverException -- including staleness -- and returns "").
//   * `_click` does not need Python's native-click-then-JS-click-fallback
//     two-tier dance: `element.click()` in a content script is already the
//     equivalent of Selenium's JS-click fallback (there is no separate native
//     click path to fail first).

import { Pager, CARD_SELECTOR as PAGER_CARD_SELECTOR, NEXT_PAGE_TIMEOUT_MS } from "./pager.js";
import { normalizeText, parseJobPanel } from "./panelParser.js";
import {
  Cancelled,
  DuplicateListing,
  PanelMismatch,
  ScraperError,
  StaleElement,
  TabClosed,
  Timeout,
} from "./scraperErrors.js";

// Must match pager.js's CARD_SELECTOR -- duplicated rather than imported back
// from there, mirroring portal.py/pager.py's own deliberate duplication (see
// pager.py's module docstring) to avoid a circular import between the two
// modules (pager.js exports Pager, which portal.js's JobPortalScraper uses).
export const CARD_SELECTOR = '[aria-label="Job Card"]';

export const PAGE_READY_TIMEOUT_MS = 600_000; // doubles as the "wait for the user to log in" wait
export const PANEL_CLOSE_TIMEOUT_MS = 15_000;
export const PANEL_OPEN_TIMEOUT_MS = 15_000;
// The portal (Blazor) has been observed to briefly render a HALF-UPDATED
// detail panel while switching jobs -- one atomic snapshot of a real run had
// the right header/job number but another job's "Work model" value. A
// matching, fresh snapshot is therefore re-read after this delay and only
// accepted once two consecutive reads are byte-identical (see
// _awaitSettledPanel).
export const PANEL_SETTLE_MS = 300;
export const CARD_RETRY_ATTEMPTS = 3;

// Parsed panel fields that must also appear in the clicked card's own text
// (see _crossCheckMismatches). Title/employer identity is already verified by
// _panelMatches; these are the fields with real-run evidence of a
// half-updated panel slipping past that check.
export const CROSS_CHECK_FIELDS = ["location", "work_model", "deadline_text"];
// How many of the run's first cards a field's cross-check is allowed to fail
// before it's disabled for the rest of the run (see _recordCrossCheckOutcome).
export const CROSS_CHECK_SAFETY_CARDS = 5;

// Selenium's WebDriverWait default poll frequency.
const DEFAULT_POLL_MS = 500;
// The tight poll used inside _waitForMatchingPanel's outer loop (matches
// Python's `time.sleep(0.1)` there -- a different, faster cadence than the
// WebDriverWait-based waits elsewhere).
const PANEL_POLL_MS = 100;

const TAB_CLOSED_MARKERS = [
  // Kept verbatim from Python's _BROWSER_CLOSED_MARKERS for parity even
  // though a content script will never see literal WebDriver error text.
  "invalid session id",
  "not connected to devtools",
  "target window already closed",
  "no such window",
  "connection refused",
  // Chrome-extension-realistic equivalents: the tab/window was closed or the
  // extension was reloaded out from under a live content script.
  "extension context invalidated",
  "could not establish connection",
  "receiving end does not exist",
];

export const defaultClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Port of Selenium's is_displayed(). jsdom has no layout engine (getClientRects
 * is always empty and offsetParent is always null), so this default only
 * behaves correctly against a real browser DOM; tests pass their own
 * `isDisplayed` via the constructor options instead of relying on this.
 */
export function defaultIsDisplayed(el) {
  if (!el) return false;
  if ("isConnected" in el && el.isConnected === false) return false;
  const hasRects = typeof el.getClientRects === "function" && el.getClientRects().length > 0;
  const hasOffsetParent = "offsetParent" in el ? el.offsetParent !== null : true;
  return hasRects || hasOffsetParent;
}

/**
 * Port of _PANEL_SNAPSHOT_SCRIPT: atomically find the visible panel and
 * return its outerHTML, text and #orgname text together. Only a VISIBLE
 * #orgname counts -- right after closing a panel it can still be in the DOM,
 * just hidden, and would otherwise be mistaken for the new panel.
 */
function panelSnapshot(dom, isDisplayed) {
  const candidates = dom.querySelectorAll("#orgname");
  let orgname = null;
  for (const el of candidates) {
    if (isDisplayed(el)) {
      orgname = el;
      break;
    }
  }
  if (!orgname) return null;
  const orgnameText = orgname.textContent || "";
  let node = orgname;
  const body = dom.body || (dom.ownerDocument && dom.ownerDocument.body);
  while (node.parentElement && node.parentElement !== body) {
    const candidate = node.parentElement;
    if (candidate.querySelector("#jobdescheading")) {
      node = candidate;
      break;
    }
    if (candidate.querySelector('[aria-label="Job Card"]')) {
      break;
    }
    node = candidate;
  }
  // If the panel root also holds the card list (split view), drop the cards:
  // their titles would make the identity check pass for any card.
  const panel = node.cloneNode(true);
  panel.querySelectorAll('[aria-label="Job Card"]').forEach((card) => card.remove());
  return { html: panel.outerHTML, text: panel.textContent || "", orgname: orgnameText };
}

/** Mirrors BeautifulSoup's `get_text(" ", strip=True)` used for the post-parse recheck. */
function plainText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue.trim();
    if (text) parts.push(text);
    node = walker.nextNode();
  }
  return parts.join(" ");
}

export class JobPortalScraper {
  constructor(options = {}) {
    const {
      dom = typeof document !== "undefined" ? document : undefined,
      searchUrl = "",
      clock = defaultClock,
      isCancelled = () => false,
      onEvent = null,
      readyCallback = null,
      pageCallback = null,
      snapshotSink = null,
      snapshotAll = false,
      isDisplayed = defaultIsDisplayed,
      log = null,
    } = options;

    this.dom = dom;
    this.searchUrl = searchUrl;
    this.clock = clock;
    this.isCancelledFn = isCancelled;
    this.onEvent = onEvent;
    this.readyCallback = readyCallback;
    this.pageCallback = pageCallback;
    this.snapshotSink = snapshotSink;
    this.snapshotAll = snapshotAll;
    this._isDisplayedFn = isDisplayed;
    this.log =
      log ||
      ((level, message) => {
        if (typeof console !== "undefined" && typeof console[level] === "function") {
          console[level](message);
        }
      });

    // Instance-level copies of the module constants, so tests can override
    // them per scraper the way the Python tests monkeypatch the module (see
    // the module docstring above).
    this.panelOpenTimeoutMs = PANEL_OPEN_TIMEOUT_MS;
    this.panelCloseTimeoutMs = PANEL_CLOSE_TIMEOUT_MS;
    this.panelSettleMs = PANEL_SETTLE_MS;
    this.cardRetryAttempts = CARD_RETRY_ATTEMPTS;

    this.anomalies = 0;
    this.cardsSeen = 0;
    this.duplicates = 0;
    this.duplicateJobs = [];
    // Counted once, up front, so the UI can show "page N of M" from the very
    // first card (see run()). null means the pager could not be read.
    this.totalPages = null;
    this.cardsPerPage = 0;
    this._seenJobNumbers = new Set();
    // job_number of the last card successfully scraped -- lets us catch a
    // panel that still shows the previous job even though its title/employer
    // text happened to match too (see _waitForMatchingPanel).
    this._lastJobNumber = null;
    // Cards that exhausted cardRetryAttempts, kept for the end-of-run retry
    // pass (see _retryFailedCards); each is {page, index, card_text, title,
    // employer}.
    this._skippedCards = [];
    this._crossCheckDisabledFields = new Set();
    this._crossCheckCardsSeen = 0;
    this._crossCheckFailCounts = Object.fromEntries(CROSS_CHECK_FIELDS.map((field) => [field, 0]));

    this._pager = new Pager(this);

    // Overridable read of the atomic panel snapshot -- production reads the
    // live DOM; tests replace this with a queue of scripted snapshots, the
    // same role Python's `_FakeDriver.execute_script` plays.
    this.readPanelSnapshot = () => panelSnapshot(this.dom, (el) => this._isDisplayed(el));
  }

  /** {page, title, employer} for every card that still failed after the
   * end-of-run retry pass (see _retryFailedCards). */
  get failed() {
    return this._skippedCards.map((failure) => ({
      page: failure.page,
      title: failure.title,
      employer: failure.employer,
    }));
  }

  /**
   * Hand one progress event to the optional onEvent callback. Monitoring
   * only: with no callback nothing happens, and a callback that throws is
   * logged and ignored rather than allowed to break the scrape.
   */
  _emit(event) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (exc) {
      this.log("warn", `on_event callback failed for a ${JSON.stringify(event.type)} event: ${exc && exc.message}`);
    }
  }

  async run() {
    // Opening the portal tab at the right URL is the service worker's job
    // (portalTab.js, phase 5) -- by the time this content script runs, the
    // page is already there, so there is no equivalent of Python's
    // `self.driver.get(self.search_url)` here.
    await this.waitForPageReady();
    if (this.readyCallback) this.readyCallback();

    // Track the *portal's own* page number, not a counter we increment
    // ourselves -- the portal can reset its pagination state mid-session (see
    // module docstring), so trusting our own count would silently re-scrape
    // old pages under new numbers.
    let expectedPage = this._currentPage() ?? 1;
    if (expectedPage !== 1) {
      await this._goToPage(1);
      expectedPage = 1;
    }

    // Count the pages (and page 1's cards) BEFORE the first card is opened,
    // so the UI can show real progress instead of an open-ended "page N".
    // Both may be unknown -- a single page of results, or a pager we could
    // not read -- in which case totalPages stays null and the run carries on
    // regardless.
    this.totalPages = this._lastPage();
    this.cardsPerPage = this.dom.querySelectorAll(CARD_SELECTOR).length;
    this._emit({ type: "pages_found", total_pages: this.totalPages, cards_per_page: this.cardsPerPage });

    while (true) {
      this._checkCancelled();
      await this.waitForPageReady();
      await this._verifyCurrentPage(expectedPage);
      this._emit({ type: "page", page: expectedPage, last_page: this.totalPages });
      const jobs = await this.scrapeCurrentPage(expectedPage);
      if (this.pageCallback) this.pageCallback(expectedPage, jobs);

      this._checkCancelled();
      const lastPage = this._lastPage();
      if (lastPage !== null && (this.totalPages === null || lastPage > this.totalPages)) {
        // The portal grew a page (or its pager was unreadable up front):
        // re-announce so the UI's total stays correct.
        this.totalPages = lastPage;
        this._emit({ type: "pages_found", total_pages: lastPage, cards_per_page: this.cardsPerPage });
      }
      const currentPage = this._currentPage();
      if (lastPage !== null && currentPage !== null && currentPage >= lastPage) {
        break;
      }
      if (!(await this._nextPageAvailable())) {
        break;
      }
      const previousPage = expectedPage;
      expectedPage += 1;
      await this._clickNextPage(expectedPage, previousPage);
    }

    await this._retryFailedCards();
    // Authoritative, post-retry count -- see the module docstring and
    // _retryFailedCards. Any earlier value only reflected the main sweep.
    this.anomalies = this._skippedCards.length;
  }

  _checkCancelled() {
    if (this.isCancelledFn()) throw new Cancelled();
  }

  _isDisplayed(el) {
    return this._isDisplayedFn(el);
  }

  /**
   * Port of WebDriverWait(...).until(predicate). Polls `predicate` (which may
   * be async) via `clock.sleep`, checking cancellation before every attempt,
   * and throws Timeout once `timeoutMs` has elapsed -- mirroring Selenium's
   * own until() loop (evaluate, sleep, THEN check the deadline, so the
   * predicate always runs at least once).
   */
  async waitUntil(predicate, timeoutMs, message = "") {
    const endTime = this.clock.now() + timeoutMs;
    while (true) {
      this._checkCancelled();
      const value = await predicate();
      if (value) return value;
      await this.clock.sleep(DEFAULT_POLL_MS);
      if (this.clock.now() > endTime) break;
    }
    throw new Timeout(message);
  }

  async waitForPageReady() {
    const message = `The search page did not become ready within ${PAGE_READY_TIMEOUT_MS / 1000} seconds.`;
    try {
      await this.waitUntil(() => {
        const cards = Array.from(this.dom.querySelectorAll(CARD_SELECTOR));
        return cards.length > 0 && cards.every((card) => this._isDisplayed(card));
      }, PAGE_READY_TIMEOUT_MS, message);
    } catch (exc) {
      if (exc instanceof Timeout) throw new ScraperError(message);
      throw exc;
    }
  }

  async scrapeCurrentPage(pageNumber) {
    const cards = this.dom.querySelectorAll(CARD_SELECTOR);
    const cardCount = cards.length;

    const jobs = [];
    for (let index = 0; index < cardCount; index += 1) {
      this._checkCancelled();
      this.cardsSeen += 1;
      const job = await this._scrapeCard(pageNumber, index, cardCount);
      if (job === null) continue;
      const jobNumber = job.job_number || "";
      if (jobNumber && this._seenJobNumbers.has(jobNumber)) {
        this.duplicates += 1;
        this.duplicateJobs.push({
          page: pageNumber,
          title: job.title || "",
          employer: job.employer || "",
          job_number: jobNumber,
        });
        continue;
      }
      if (jobNumber) this._seenJobNumbers.add(jobNumber);
      jobs.push(job);
      // After the duplicate check, so every `scraped` event is a job that is
      // really being kept.
      this._emit({
        type: "scraped",
        page: pageNumber,
        index: index + 1,
        total: cardCount,
        title: job.title || "",
        employer: job.employer || "",
        job_number: jobNumber,
        job,
      });
    }

    if (cardCount > 0 && jobs.length === 0) {
      this.log("error", `Every job on page ${pageNumber} was skipped -- see the debug snapshot sink.`);
    }
    return jobs;
  }

  async _scrapeCard(pageNumber, index, expectedCardCount) {
    let cardTitle = "";
    let employer = "";
    let cardText = "";
    let lastHtml = "";
    const attemptErrors = [];
    let announced = false; // the "card" event is emitted once, not once per attempt

    for (let attempt = 1; attempt <= this.cardRetryAttempts; attempt += 1) {
      try {
        await this._closeDetailPanel(expectedCardCount);
        const card = this._getCard(index);
        cardTitle = this._readCardText(card, "#opptitle");
        employer = this._readCardText(card, "#oppprovider");
        if (!announced) {
          announced = true;
          this._emit({
            type: "card",
            page: pageNumber,
            index: index + 1,
            total: expectedCardCount,
            title: cardTitle,
            employer,
          });
        }
        // Full card text, read BEFORE the click, for the cross-check below.
        cardText = this._readFullCardText(card);
        this._click(card);

        // _waitForMatchingPanel already guarantees this html is identity-
        // matched, fresh (job number moved on, or is unknown), AND
        // cross-checked against cardText -- it is parsed here, not re-fetched.
        const html = await this._waitForMatchingPanel(cardTitle, employer, cardText);
        lastHtml = html;
        const job = parseJobPanel(html);
        const panelText = plainText(html);
        if (!JobPortalScraper._panelMatches(cardTitle, employer, panelText, job.displayed_title || "")) {
          throw new PanelMismatch(
            `Parsed panel does not mention card title ${JSON.stringify(cardTitle)} (employer ${JSON.stringify(
              employer
            )}).`
          );
        }

        const jobNumber = job.job_number || "";
        job.title = cardTitle;
        job.employer = employer;
        job.page_number = pageNumber;
        this._saveSnapshot(pageNumber, index, jobNumber, job, html, { cardText });
        if (jobNumber) this._lastJobNumber = jobNumber;
        return job;
      } catch (exc) {
        if (exc instanceof DuplicateListing) {
          // Not an anomaly and never retried -- the portal really did list
          // this job twice in a row.
          this.duplicates += 1;
          this.duplicateJobs.push({
            page: pageNumber,
            title: cardTitle,
            employer,
            job_number: exc.jobNumber,
          });
          this._saveSnapshot(
            pageNumber,
            index,
            exc.jobNumber,
            { title: cardTitle, employer, duplicate_of: exc.jobNumber },
            exc.html,
            { category: "duplicates", cardText }
          );
          return null;
        }
        if (exc instanceof Cancelled || exc instanceof TabClosed) {
          throw exc; // never retried -- fatal, unwind the scrape
        }
        // Promotes an error carrying a tab-closed marker to TabClosed
        // (fatal); everything else (StaleElement, Timeout, PanelMismatch,
        // ScraperError, and any other unexpected failure) is retried, same as
        // Python's broad `except WebDriverException` fallback.
        this._raiseIfTabClosed(exc);
        attemptErrors.push(exc && exc.message ? exc.message : String(exc));
        this._emitRetry(pageNumber, index, expectedCardCount, cardTitle, attempt, exc);
      }
    }

    this.anomalies += 1;
    if (!lastHtml) lastHtml = this._fullPageHtml();
    this._saveSnapshot(
      pageNumber,
      index,
      "",
      { title: cardTitle, employer, anomaly: true, errors: attemptErrors },
      lastHtml,
      { anomaly: true, cardText }
    );
    // Recorded for the end-of-run retry pass; this is also how a *retry's*
    // own failure re-registers itself as final.
    this._skippedCards.push({ page: pageNumber, index, card_text: cardText, title: cardTitle, employer });
    this._emit({
      type: "skipped",
      page: pageNumber,
      index: index + 1,
      total: expectedCardCount,
      title: cardTitle,
      employer,
      reason: attemptErrors[attemptErrors.length - 1] || "",
    });
    return null;
  }

  _emitRetry(pageNumber, index, expectedCardCount, cardTitle, attempt, exc) {
    this._emit({
      type: "retry",
      page: pageNumber,
      index: index + 1,
      total: expectedCardCount,
      title: cardTitle,
      attempt,
      reason: exc && exc.message ? exc.message : String(exc),
    });
  }

  _fullPageHtml() {
    try {
      const root = this.dom.documentElement || (this.dom.ownerDocument && this.dom.ownerDocument.documentElement);
      return root ? root.outerHTML : "";
    } catch (exc) {
      this.log("warn", `Could not capture full-page HTML for anomaly evidence: ${exc && exc.message}`);
      return "";
    }
  }

  /**
   * Poll the atomic panel snapshot until it visibly matches the clicked card,
   * shows a job number that isn't just left over from the previous card, AND
   * (if `cardText` is given) cross-checks clean against the card's own text.
   * See the module docstring in portal.py (ported at the top of this file)
   * for the full rationale.
   */
  async _waitForMatchingPanel(cardTitle, employer, cardText = "") {
    const deadline = this.clock.now() + this.panelOpenTimeoutMs;
    let lastSeen = "";
    let staleMatch = null; // last matching-but-same-job-number snapshot seen
    let lastMismatches = {}; // last cross-check failure seen on an otherwise-settled panel

    while (this.clock.now() < deadline) {
      this._checkCancelled();
      const snapshot = this.readPanelSnapshot();
      if (snapshot) {
        lastSeen = snapshot.text || "";
        if (JobPortalScraper._panelMatches(cardTitle, employer, lastSeen, snapshot.orgname || "")) {
          const jobNumber = parseJobPanel(snapshot.html).job_number || "";
          if (!jobNumber || jobNumber !== this._lastJobNumber) {
            const settled = await this._awaitSettledPanel(snapshot.html, cardTitle, employer, deadline);
            if (settled !== null) {
              const mismatches = this._crossCheckMismatches(settled, cardText);
              if (Object.keys(mismatches).length === 0) {
                this._recordCrossCheckOutcome({});
                return settled;
              }
              lastMismatches = mismatches;
            }
            continue;
          }
          staleMatch = { html: snapshot.html, job_number: jobNumber };
        }
      }
      await this.clock.sleep(PANEL_POLL_MS);
    }

    if (staleMatch !== null) {
      throw new DuplicateListing(
        `Card ${JSON.stringify(cardTitle)} (${JSON.stringify(employer)}) matches but keeps showing job number ` +
          `${JSON.stringify(staleMatch.job_number)} for the full ${this.panelOpenTimeoutMs / 1000}s wait; ` +
          "the portal lists it twice.",
        staleMatch.job_number,
        staleMatch.html
      );
    }
    if (Object.keys(lastMismatches).length > 0) {
      this._recordCrossCheckOutcome(lastMismatches);
      const details = Object.entries(lastMismatches)
        .map(([field, value]) => `panel ${field}=${JSON.stringify(value)}`)
        .join("; ");
      throw new PanelMismatch(
        `Card/panel cross-check failed for ${JSON.stringify(cardTitle)} (${JSON.stringify(employer)}) after ` +
          `${this.panelOpenTimeoutMs / 1000}s: ${details}; not found in card text ${JSON.stringify(
            cardText.slice(0, 200)
          )}.`
      );
    }
    throw new Timeout(
      `Detail panel never matched the card within ${this.panelOpenTimeoutMs / 1000}s ` +
        `(card=${JSON.stringify(cardTitle)}, employer=${JSON.stringify(employer)}, last panel text=${JSON.stringify(
          lastSeen.slice(0, 200)
        )}).`
    );
  }

  async _awaitSettledPanel(candidateHtml, cardTitle, employer, deadline) {
    while (this.clock.now() < deadline) {
      await this.clock.sleep(this.panelSettleMs);
      const recheck = this.readPanelSnapshot();
      if (recheck && recheck.html === candidateHtml) {
        return candidateHtml;
      }
      if (!recheck || !JobPortalScraper._panelMatches(cardTitle, employer, recheck.text || "", recheck.orgname || "")) {
        return null;
      }
      const jobNumber = parseJobPanel(recheck.html).job_number || "";
      if (jobNumber && jobNumber === this._lastJobNumber) {
        return null;
      }
      candidateHtml = recheck.html;
    }
    return null;
  }

  _crossCheckMismatches(html, cardText) {
    if (!cardText) return {};
    const job = parseJobPanel(html);
    const mismatches = {};
    for (const field of CROSS_CHECK_FIELDS) {
      if (this._crossCheckDisabledFields.has(field)) continue;
      const value = job[field] || "";
      if (!value) continue;
      if (!cardText.includes(normalizeText(value))) {
        mismatches[field] = value;
      }
    }
    return mismatches;
  }

  _recordCrossCheckOutcome(mismatches) {
    if (this._crossCheckCardsSeen >= CROSS_CHECK_SAFETY_CARDS) return;
    this._crossCheckCardsSeen += 1;
    for (const field of CROSS_CHECK_FIELDS) {
      if (this._crossCheckDisabledFields.has(field)) continue;
      if (field in mismatches) this._crossCheckFailCounts[field] += 1;
    }
    for (const field of CROSS_CHECK_FIELDS) {
      const count = this._crossCheckFailCounts[field];
      if (!this._crossCheckDisabledFields.has(field) && count >= CROSS_CHECK_SAFETY_CARDS) {
        this._crossCheckDisabledFields.add(field);
        this.log(
          "warn",
          `Card/panel cross-check for ${JSON.stringify(field)} mismatched on the first ${CROSS_CHECK_SAFETY_CARDS} ` +
            "cards; disabling that check for the rest of the run."
        );
      }
    }
  }

  static _identityKey(text) {
    return normalizeText(text).replace(/[^0-9a-z]/g, "");
  }

  static _panelMatches(cardTitle, employer, panelText, orgnameText = "") {
    if (orgnameText) {
      return JobPortalScraper._identityKey(orgnameText) === JobPortalScraper._identityKey(cardTitle + employer);
    }
    const normalizedPanel = normalizeText(panelText);
    const normalizedTitle = normalizeText(cardTitle);
    if (!normalizedTitle || !normalizedPanel.includes(normalizedTitle)) return false;
    const normalizedEmployer = normalizeText(employer);
    if (normalizedEmployer && !normalizedPanel.includes(normalizedEmployer)) return false;
    return true;
  }

  /**
   * Escape any open panel, then wait for the card list to be restored.
   *
   * We only wait for the card count -- NOT for #orgname to become hidden. On
   * this portal the job detail panel can be shown permanently beside the
   * list (split view); that is normal and must not fail the card. Escape is
   * still sent in case the panel is a dismissible overlay, but we don't
   * require it to work.
   */
  async _closeDetailPanel(expectedCardCount) {
    let panelVisible;
    try {
      const el = this.dom.querySelector("#orgname");
      panelVisible = !!(el && this._isDisplayed(el));
    } catch (exc) {
      this._raiseIfTabClosed(exc);
      throw exc;
    }
    if (panelVisible) this._pressEscape();

    const message = "The card list was not restored after closing the detail panel.";
    try {
      await this.waitUntil(
        () => this.dom.querySelectorAll(CARD_SELECTOR).length >= expectedCardCount,
        this.panelCloseTimeoutMs,
        message
      );
    } catch (exc) {
      if (exc instanceof Timeout) throw new ScraperError(message);
      throw exc;
    }
  }

  _pressEscape() {
    const target = this.dom.activeElement || this.dom.body;
    if (!target || typeof target.dispatchEvent !== "function") return;
    const KeyboardEventCtor =
      (this.dom.defaultView && this.dom.defaultView.KeyboardEvent) ||
      (typeof KeyboardEvent !== "undefined" ? KeyboardEvent : null);
    if (!KeyboardEventCtor) return;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEventCtor(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
  }

  _getCard(index) {
    const cards = this.dom.querySelectorAll(CARD_SELECTOR);
    if (index >= cards.length) {
      throw new ScraperError(`Job card ${index + 1} disappeared from the page.`);
    }
    return cards[index];
  }

  _click(element) {
    if (!element || element.isConnected === false) {
      throw new StaleElement();
    }
    try {
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "center", inline: "nearest" });
      }
    } catch {
      // jsdom's scrollIntoView is a no-op stub on some versions and throws
      // "not implemented" on others -- neither should fail the click.
    }
    element.click();
  }

  // -- Pagination: thin delegation to pager.js's Pager (this._pager) --------
  // See the module docstring and pager.js -- these wrappers exist so callers
  // (and the ported test_portal_pagination.py tests) keep using
  // JobPortalScraper's own method names, without this module carrying the
  // pager's implementation.

  async _nextPageAvailable() {
    return this._pager.nextPageAvailable();
  }

  async _clickNextPage(expectedPage, previousPage) {
    return this._pager.clickNextPage(expectedPage, previousPage);
  }

  _pageHasAdvanced(firstCard, firstTitle) {
    return this._pager.pageHasAdvanced(firstCard, firstTitle);
  }

  _currentPage() {
    return this._pager.currentPage();
  }

  _lastPage() {
    return this._pager.lastPage();
  }

  async _verifyCurrentPage(expectedPage) {
    return this._pager.verifyCurrentPage(expectedPage);
  }

  async _goToPage(expected) {
    return this._pager.goToPage(expected);
  }

  _visiblePageNumbers() {
    return this._pager.visiblePageNumbers();
  }

  _findPageButton(page) {
    return this._pager.findPageButton(page);
  }

  _closestPageButton(current, expected) {
    return this._pager.closestPageButton(current, expected);
  }

  _findButtonByAriaLabel(label) {
    return this._pager.findButtonByAriaLabel(label);
  }

  // -- Retry pass -------------------------------------------------------

  /**
   * One retry pass over every card that exhausted its attempts during the
   * main sweep, run once every page has been scraped (see run()).
   *
   * this._skippedCards is drained up front, one page at a time; _scrapeCard
   * re-populates it with whatever still fails, so once this method returns,
   * that list *is* the final failure set (see the `failed` getter).
   */
  async _retryFailedCards() {
    const pending = this._skippedCards;
    if (!pending.length) return;
    this._skippedCards = [];
    const pages = [...new Set(pending.map((failure) => failure.page))].sort((a, b) => a - b);
    this._emit({ type: "retry_pass", cards: pending.length, pages: pages.length });

    for (const page of pages) {
      this._checkCancelled();
      const pageFailures = pending.filter((failure) => failure.page === page);
      try {
        await this._goToPage(page);
        await this.waitForPageReady();
      } catch (exc) {
        if (exc instanceof Cancelled || exc instanceof TabClosed) throw exc;
        this._skippedCards.push(...pageFailures);
        continue;
      }

      const pageJobs = [];
      for (const failure of pageFailures) {
        const cards = this.dom.querySelectorAll(CARD_SELECTOR);
        const index = this._findCardIndexByText(failure.card_text, failure.index, cards.length);
        const job = await this._scrapeCard(page, index, cards.length);
        if (job === null) continue; // _scrapeCard already re-recorded this in this._skippedCards
        const jobNumber = job.job_number || "";
        if (jobNumber && this._seenJobNumbers.has(jobNumber)) {
          this.duplicates += 1;
          this.duplicateJobs.push({
            page,
            title: job.title || "",
            employer: job.employer || "",
            job_number: jobNumber,
          });
          continue;
        }
        if (jobNumber) this._seenJobNumbers.add(jobNumber);
        pageJobs.push(job);
        // Same contract as the main sweep: one `scraped` event per accepted
        // job, after the duplicate check, carrying the job itself.
        this._emit({
          type: "scraped",
          page,
          index: index + 1,
          total: cards.length,
          title: job.title || "",
          employer: job.employer || "",
          job_number: jobNumber,
          job,
        });
      }

      if (pageJobs.length && this.pageCallback) this.pageCallback(page, pageJobs);
    }
  }

  /**
   * Locate a previously-failed card by its exact normalized full text --
   * cards can shift position between the main pass and the retry pass --
   * falling back to its original index when there's no unique match.
   */
  _findCardIndexByText(cardText, fallbackIndex, cardCount) {
    if (cardText) {
      const cards = this.dom.querySelectorAll(CARD_SELECTOR);
      const matches = [];
      cards.forEach((card, i) => {
        if (this._readFullCardText(card) === cardText) matches.push(i);
      });
      if (matches.length === 1) return matches[0];
    }
    return fallbackIndex < cardCount ? fallbackIndex : 0;
  }

  _readCardText(card, selector) {
    if (!card || card.isConnected === false) return "";
    try {
      const el = card.querySelector(selector);
      if (!el) return "";
      return (el.textContent || "").trim();
    } catch {
      return "";
    }
  }

  /** The card's whole text, normalized -- used both for the panel cross-check
   * and to re-find a card by content during the retry pass. */
  _readFullCardText(card) {
    if (!card || card.isConnected === false) return "";
    try {
      const raw = "text" in card ? card.text : card.innerText ?? card.textContent ?? "";
      return normalizeText(raw);
    } catch {
      return "";
    }
  }

  _raiseIfTabClosed(exc) {
    if (exc instanceof TabClosed) throw exc;
    const message = String((exc && exc.message) || exc || "").toLowerCase();
    if (TAB_CLOSED_MARKERS.some((marker) => message.includes(marker))) {
      throw new TabClosed();
    }
  }

  _saveSnapshot(pageNumber, index, jobNumber, job, html = "", opts = {}) {
    const { anomaly = false, category = null, cardText = "" } = opts;
    // `category` (e.g. "duplicates") is always saved, like anomalies -- it's
    // evidence of a real, notable event, not routine snapshot_all logging.
    if (category === null && !anomaly && !this.snapshotAll) return;
    if (!this.snapshotSink) return;
    const resolvedCategory = category ?? (anomaly ? "anomalies" : null);
    const name = `${pageNumber}-${index}-${jobNumber || "unknown"}`;
    const payload = { ...job };
    if (cardText) payload.card_text = cardText;
    try {
      this.snapshotSink(resolvedCategory, name, { json: payload, html });
    } catch (exc) {
      this.log("warn", `Could not write debug snapshot for page ${pageNumber}, job ${index}: ${exc && exc.message}`);
    }
  }
}

// Re-exported so callers only need to import from portal.js, matching
// `from app.scraper.portal import DuplicateListing, JobPortalScraper, PanelMismatch`.
export { Cancelled, DuplicateListing, PanelMismatch, ScraperError, StaleElement, TabClosed, Timeout };

// Sanity check that the two modules' CARD_SELECTOR really do match, the way
// the Python module docstrings assert by comment only -- see pager.js.
if (CARD_SELECTOR !== PAGER_CARD_SELECTOR) {
  throw new Error("portal.js and pager.js CARD_SELECTOR constants have diverged.");
}
export { NEXT_PAGE_TIMEOUT_MS };
