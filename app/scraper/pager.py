"""Pagination for the co-op jobs portal: reading MudBlazor's own pager and
recovering when it disagrees with the page the scraper expects to be on.

Split out of portal.py purely to keep that module focused on card/panel
scraping (see its module docstring for *why* the scraper tracks the portal's
own page number instead of a counter it increments itself -- the portal has
been observed to reset its pagination state back to page 1 mid-session).

`Pager` talks back through `host` (the owning JobPortalScraper instance)
for the handful of things that are still genuinely the scraper's concern:
`driver`, `_check_cancelled`, `wait_for_page_ready`, `_click`,
`_read_card_text` and `_raise_if_browser_closed`. Looking these up on `host`
at call time (rather than capturing bound methods once) also means a test
that monkeypatches an instance method (e.g. `wait_for_page_ready`) after the
scraper is constructed still takes effect here, exactly as if this code were
still inlined in JobPortalScraper.
"""

import logging
import re
import time
from typing import Optional

from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

logger = logging.getLogger(__name__)

# Must match portal.CARD_SELECTOR -- duplicated rather than imported back from
# portal.py to avoid a circular import (portal.py imports Pager from here).
CARD_SELECTOR = '[aria-label="Job Card"]'
NEXT_PAGE_SELECTOR = 'button[aria-label="Next page"]'
NEXT_PAGE_TIMEOUT_SECONDS = 20
GOTO_PAGE_MAX_CLICKS = 15  # bound on go_to_page's recovery loop -- fail loudly, don't spin forever

# MudBlazor's pager only shows a window of page numbers around the current page
# plus the first/last pages (e.g. "Page 1", "Current page 2", "Page 3" .. "Page 6",
# an ellipsis, "Page 38", "Page 39"). These two scripts read that pager directly so
# the scraper can detect a portal-side page reset instead of trusting a counter it
# increments itself. Each has a distinctive leading comment so tests can tell the
# two scripts apart without depending on the exact aria-label regex below.
_CURRENT_PAGE_SCRIPT = """
// CURRENT_PAGE_MARKER
const el = document.querySelector('button[aria-label^="Current page "]');
if (!el) { return null; }
const match = (el.getAttribute('aria-label') || '').match(/\\d+/);
return match ? parseInt(match[0], 10) : null;
"""

_LAST_PAGE_SCRIPT = """
// LAST_PAGE_MARKER
const buttons = document.querySelectorAll('button[aria-label]');
let max = null;
for (const b of buttons) {
    const label = b.getAttribute('aria-label') || '';
    const match = label.match(/^(?:Current )?[Pp]age (\\d+)$/);
    if (match) {
        const n = parseInt(match[1], 10);
        if (max === null || n > max) { max = n; }
    }
}
return max;
"""


class Pager:
    """Reads/drives the MudBlazor pager on behalf of one JobPortalScraper run."""

    def __init__(self, host):
        self.host = host

    @property
    def driver(self):
        return self.host.driver

    def current_page(self) -> Optional[int]:
        """The portal's own current-page number, parsed from the MudBlazor pager's
        "Current page N" button. None if the pager isn't present (e.g. a single page
        of results) or couldn't be read -- callers must treat that as "unknown", not
        as a mismatch, since a real reset can only be detected when this is known.
        """
        try:
            value = self.driver.execute_script(_CURRENT_PAGE_SCRIPT)
        except WebDriverException as exc:
            self.host._raise_if_browser_closed(exc)
            return None
        return int(value) if value is not None else None

    def last_page(self) -> Optional[int]:
        """The highest page number visible in the pager (plain "Page N" or "Current
        page N"). MudBlazor only shows a window around the current page plus the
        first/last pages, so this is the *last* page, not the count of visible buttons.
        """
        try:
            value = self.driver.execute_script(_LAST_PAGE_SCRIPT)
        except WebDriverException as exc:
            self.host._raise_if_browser_closed(exc)
            return None
        return int(value) if value is not None else None

    def verify_current_page(self, expected_page: int) -> None:
        """Cheap guard (one execute_script) against a mid-session portal reset: if the
        pager no longer agrees with what we expect, navigate back before trusting
        whatever cards happen to be on screen."""
        current = self.current_page()
        if current is not None and current != expected_page:
            logger.warning(
                "Portal jumped to page %d while expecting %d; navigating back.", current, expected_page
            )
            self.go_to_page(expected_page)

    def go_to_page(self, expected: int) -> None:
        """Recover the portal onto `expected` after it lands somewhere else.

        Prefers clicking the exact numbered button when it's visible in the pager's
        window; otherwise clicks the visible numbered button closest to `expected` on
        the correct side (to work toward the window that contains it), falling back to
        Next/Previous when no numbered buttons are visible at all. Bounded so a wedged
        pager fails loudly instead of looping forever.
        """
        for _ in range(GOTO_PAGE_MAX_CLICKS):
            current = self.current_page()
            if current == expected:
                self.host.wait_for_page_ready()
                return
            self.host._check_cancelled()
            button = self.find_page_button(expected) or self.closest_page_button(current, expected)
            if button is None:
                label = "Next page" if (current is None or expected > current) else "Previous page"
                button = self.find_button_by_aria_label(label)
            if button is None:
                break
            self.host._click(button)
            try:
                WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                    lambda driver: self.current_page() != current
                )
            except TimeoutException:
                pass  # re-checked at the top of the next loop iteration
        raise RuntimeError(f"Could not navigate to portal page {expected}.")

    def visible_page_numbers(self) -> dict:
        """Map of page number -> clickable button, for every numbered pagination
        button currently in the DOM (both plain "Page N" and "Current page N")."""
        result: dict = {}
        try:
            buttons = self.driver.find_elements(By.CSS_SELECTOR, "button[aria-label]")
        except WebDriverException as exc:
            self.host._raise_if_browser_closed(exc)
            return result
        for button in buttons:
            label = button.get_attribute("aria-label") or ""
            match = re.match(r"^(?:Current )?[Pp]age (\d+)$", label)
            if match:
                result[int(match.group(1))] = button
        return result

    def find_page_button(self, page: int):
        return self.visible_page_numbers().get(page)

    def closest_page_button(self, current: Optional[int], expected: int):
        pages = self.visible_page_numbers()
        if not pages:
            return None
        if current is not None:
            direction = 1 if expected > current else -1
            same_side = [n for n in pages if (n - current) * direction > 0]
            candidates = same_side or list(pages.keys())
        else:
            candidates = list(pages.keys())
        best = min(candidates, key=lambda n: abs(n - expected))
        return pages[best]

    def find_button_by_aria_label(self, label: str):
        try:
            elements = self.driver.find_elements(By.CSS_SELECTOR, f'button[aria-label="{label}"]')
        except WebDriverException as exc:
            self.host._raise_if_browser_closed(exc)
            return None
        return elements[0] if elements else None

    def next_page_available(self) -> bool:
        try:
            button = WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, NEXT_PAGE_SELECTOR))
            )
            return button.is_displayed() and button.is_enabled() and button.get_attribute("disabled") is None
        except (TimeoutException, WebDriverException):
            return False

    def click_next_page(self, expected_page: int, previous_page: int) -> None:
        first_card = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
        first_card = first_card[0] if first_card else None
        first_title = self.host._read_card_text(first_card, "#opptitle") if first_card is not None else ""

        try:
            button = WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, NEXT_PAGE_SELECTOR))
            )
        except TimeoutException as exc:
            raise RuntimeError("The next-page control was not clickable after the page was ready.") from exc
        self.host._click(button)

        if first_card is not None:
            try:
                WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                    lambda driver: self.page_has_advanced(first_card, first_title)
                )
            except TimeoutException as exc:
                raise RuntimeError("The next page did not load after clicking Next.") from exc

        # The card-staleness wait above only proves *some* navigation happened -- it
        # can't tell page N+1 from a portal-side reset to page 1 that Next then bumped
        # to page 2. Cross-check against the portal's own pager and recover if it
        # disagrees with what we expect (see module docstring).
        try:
            WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                lambda driver: self.current_page() != previous_page
            )
        except TimeoutException:
            pass  # the explicit check below raises/recovers; a stuck pager alone isn't fatal
        self.verify_current_page(expected_page)
        logger.info("Moved to portal page %d.", expected_page)

    def page_has_advanced(self, first_card, first_title: str) -> bool:
        # host._read_card_text already treats a stale/removed element as "" -- which,
        # since first_title is non-empty, correctly reads as "the page moved on".
        return self.host._read_card_text(first_card, "#opptitle") != first_title
