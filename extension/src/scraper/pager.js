// Pagination for the co-op jobs portal: reading MudBlazor's own pager and
// recovering when it disagrees with the page the scraper expects to be on.
//
// Port of app/scraper/pager.py. See that module's docstring for *why* the
// scraper tracks the portal's own page number instead of a counter it
// increments itself -- the portal has been observed to reset its pagination
// state back to page 1 mid-session.
//
// `Pager` talks back through `host` (the owning JobPortalScraper instance)
// for the handful of things that are still genuinely the scraper's concern:
// `host.dom`, `host._checkCancelled`, `host.waitForPageReady`, `host._click`,
// `host._readCardText`, `host.waitUntil` and `host._raiseIfTabClosed`.
// Looking these up on `host` at call time (rather than capturing them once)
// means a test that overrides an instance method after the scraper is
// constructed still takes effect here, exactly as in the Python port.

import { ScraperError, Timeout } from "./scraperErrors.js";

// Must match portal.CARD_SELECTOR -- duplicated rather than imported back
// from portal.js to avoid a circular import (portal.js imports Pager from
// here).
export const CARD_SELECTOR = '[aria-label="Job Card"]';
export const NEXT_PAGE_SELECTOR = 'button[aria-label="Next page"]';
export const NEXT_PAGE_TIMEOUT_MS = 20_000;
// Bound on go_to_page's recovery loop -- fail loudly, don't spin forever.
export const GOTO_PAGE_MAX_CLICKS = 15;

const CURRENT_PAGE_BUTTON_SELECTOR = 'button[aria-label^="Current page "]';
const PAGE_BUTTON_SELECTOR = "button[aria-label]";
// MudBlazor's pager only shows a window of page numbers around the current
// page plus the first/last pages (e.g. "Page 1", "Current page 2", "Page 3"
// .. "Page 6", an ellipsis, "Page 38", "Page 39"). This regex reads that
// pager directly so the scraper can detect a portal-side page reset instead
// of trusting a counter it increments itself.
const PAGE_LABEL_RE = /^(?:Current )?[Pp]age (\d+)$/;

export class Pager {
  constructor(host) {
    this.host = host;
  }

  get dom() {
    return this.host.dom;
  }

  /**
   * The portal's own current-page number, parsed from the MudBlazor pager's
   * "Current page N" button. null if the pager isn't present (e.g. a single
   * page of results) or couldn't be read -- callers must treat that as
   * "unknown", not as a mismatch, since a real reset can only be detected
   * when this is known.
   */
  currentPage() {
    let el;
    try {
      el = this.dom.querySelector(CURRENT_PAGE_BUTTON_SELECTOR);
    } catch (exc) {
      this.host._raiseIfTabClosed(exc);
      return null;
    }
    if (!el) return null;
    const match = (el.getAttribute("aria-label") || "").match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  /**
   * The highest page number visible in the pager (plain "Page N" or "Current
   * page N"). MudBlazor only shows a window around the current page plus the
   * first/last pages, so this is the *last* page, not the count of visible
   * buttons.
   */
  lastPage() {
    let buttons;
    try {
      buttons = this.dom.querySelectorAll(PAGE_BUTTON_SELECTOR);
    } catch (exc) {
      this.host._raiseIfTabClosed(exc);
      return null;
    }
    let max = null;
    for (const button of buttons) {
      const match = (button.getAttribute("aria-label") || "").match(PAGE_LABEL_RE);
      if (match) {
        const n = parseInt(match[1], 10);
        if (max === null || n > max) max = n;
      }
    }
    return max;
  }

  /**
   * Cheap guard against a mid-session portal reset: if the pager no longer
   * agrees with what we expect, navigate back before trusting whatever cards
   * happen to be on screen.
   */
  async verifyCurrentPage(expectedPage) {
    const current = this.currentPage();
    if (current !== null && current !== expectedPage) {
      await this.goToPage(expectedPage);
    }
  }

  /**
   * Recover the portal onto `expected` after it lands somewhere else.
   *
   * Prefers clicking the exact numbered button when it's visible in the
   * pager's window; otherwise clicks the visible numbered button closest to
   * `expected` on the correct side (to work toward the window that contains
   * it), falling back to Next/Previous when no numbered buttons are visible
   * at all. Bounded so a wedged pager fails loudly instead of looping forever.
   */
  async goToPage(expected) {
    for (let i = 0; i < GOTO_PAGE_MAX_CLICKS; i += 1) {
      const current = this.currentPage();
      if (current === expected) {
        await this.host.waitForPageReady();
        return;
      }
      this.host._checkCancelled();
      let button = this.findPageButton(expected) ?? this.closestPageButton(current, expected);
      if (!button) {
        const label = current === null || expected > current ? "Next page" : "Previous page";
        button = this.findButtonByAriaLabel(label);
      }
      if (!button) break;
      this.host._click(button);
      try {
        await this.host.waitUntil(() => this.currentPage() !== current, NEXT_PAGE_TIMEOUT_MS);
      } catch (exc) {
        if (!(exc instanceof Timeout)) throw exc;
        // re-checked at the top of the next loop iteration
      }
    }
    throw new ScraperError(`Could not navigate to portal page ${expected}.`);
  }

  /**
   * Map of page number -> clickable button, for every numbered pagination
   * button currently in the DOM (both plain "Page N" and "Current page N").
   */
  visiblePageNumbers() {
    let buttons;
    try {
      buttons = this.dom.querySelectorAll(PAGE_BUTTON_SELECTOR);
    } catch (exc) {
      this.host._raiseIfTabClosed(exc);
      return new Map();
    }
    const result = new Map();
    for (const button of buttons) {
      const match = (button.getAttribute("aria-label") || "").match(PAGE_LABEL_RE);
      if (match) result.set(parseInt(match[1], 10), button);
    }
    return result;
  }

  findPageButton(page) {
    return this.visiblePageNumbers().get(page) ?? null;
  }

  closestPageButton(current, expected) {
    const pages = this.visiblePageNumbers();
    if (pages.size === 0) return null;
    let candidates;
    if (current !== null && current !== undefined) {
      const direction = expected > current ? 1 : -1;
      const sameSide = [...pages.keys()].filter((n) => (n - current) * direction > 0);
      candidates = sameSide.length ? sameSide : [...pages.keys()];
    } else {
      candidates = [...pages.keys()];
    }
    let best = candidates[0];
    for (const n of candidates) {
      if (Math.abs(n - expected) < Math.abs(best - expected)) best = n;
    }
    return pages.get(best);
  }

  findButtonByAriaLabel(label) {
    let elements;
    try {
      elements = this.dom.querySelectorAll(`button[aria-label="${label}"]`);
    } catch (exc) {
      this.host._raiseIfTabClosed(exc);
      return null;
    }
    return elements.length ? elements[0] : null;
  }

  async nextPageAvailable() {
    let button;
    try {
      button = await this.host.waitUntil(
        () => this.dom.querySelector(NEXT_PAGE_SELECTOR),
        NEXT_PAGE_TIMEOUT_MS
      );
    } catch {
      return false;
    }
    if (!button) return false;
    try {
      return (
        this.host._isDisplayed(button) &&
        !button.disabled &&
        button.getAttribute("disabled") === null
      );
    } catch {
      return false;
    }
  }

  async clickNextPage(expectedPage, previousPage) {
    const cards = this.dom.querySelectorAll(CARD_SELECTOR);
    const firstCard = cards.length ? cards[0] : null;
    const firstTitle = firstCard !== null ? this.host._readCardText(firstCard, "#opptitle") : "";

    let button;
    try {
      button = await this.host.waitUntil(() => {
        const el = this.dom.querySelector(NEXT_PAGE_SELECTOR);
        return el && this.host._isDisplayed(el) && !el.disabled ? el : null;
      }, NEXT_PAGE_TIMEOUT_MS);
    } catch (exc) {
      if (exc instanceof Timeout) {
        throw new ScraperError("The next-page control was not clickable after the page was ready.");
      }
      throw exc;
    }
    this.host._click(button);

    if (firstCard !== null) {
      try {
        await this.host.waitUntil(() => this.pageHasAdvanced(firstCard, firstTitle), NEXT_PAGE_TIMEOUT_MS);
      } catch (exc) {
        if (exc instanceof Timeout) {
          throw new ScraperError("The next page did not load after clicking Next.");
        }
        throw exc;
      }
    }

    // The card-staleness wait above only proves *some* navigation happened --
    // it can't tell page N+1 from a portal-side reset to page 1 that Next
    // then bumped to page 2. Cross-check against the portal's own pager and
    // recover if it disagrees with what we expect (see module docstring).
    try {
      await this.host.waitUntil(() => this.currentPage() !== previousPage, NEXT_PAGE_TIMEOUT_MS);
    } catch (exc) {
      if (!(exc instanceof Timeout)) throw exc;
      // the explicit check below raises/recovers; a stuck pager alone isn't fatal
    }
    await this.verifyCurrentPage(expectedPage);
  }

  pageHasAdvanced(firstCard, firstTitle) {
    // host._readCardText already treats a stale/removed element as "" --
    // which, since firstTitle is non-empty, correctly reads as "the page
    // moved on".
    return this.host._readCardText(firstCard, "#opptitle") !== firstTitle;
  }
}
