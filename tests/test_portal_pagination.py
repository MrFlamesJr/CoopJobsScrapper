"""Cheap tests for JobPortalScraper's MudBlazor pager parsing and page-reset
recovery -- no real browser.

Real-run evidence this guards against: after scraping pages 1..31 fine, a Next
click landed the portal on page 2 instead of 32 -- the portal (Blazor/MudBlazor)
had reset its own pagination state to page 1 mid-session, and our Next click
only moved it one step from there. `_current_page`/`_last_page` read the
pager directly instead of trusting a counter we increment ourselves, and
`_go_to_page` recovers by clicking toward the expected page.
"""

import pytest

from app.scraper.portal import CARD_SELECTOR, JobPortalScraper


class _FakeButton:
    """A pager button: reports its own aria-label and, on click, jumps the fake
    driver's current page (mimicking what clicking a real MudBlazor page button
    does)."""

    def __init__(self, driver: "_FakePagerDriver", label: str, target_page: int):
        self._driver = driver
        self._label = label
        self._target_page = target_page

    def get_attribute(self, name):
        return self._label if name == "aria-label" else None

    def click(self):
        self._driver.current_page = self._target_page


class _FakePagerDriver:
    """Enough of a driver to exercise pager parsing and _go_to_page: execute_script
    is dispatched by the marker comment each script carries (see portal.py), and
    find_elements serves numbered pager buttons for whatever page the driver is
    "currently" on, mimicking MudBlazor's windowed pager (a few pages around the
    current one, or the whole set for small totals).
    """

    def __init__(self, current_page, last_page=None, window=None):
        self.current_page = current_page
        self.last_page = last_page
        # Which page numbers have a clickable button "visible" right now. Defaults to
        # a window around the current page plus the last page, like the real pager.
        self.window = window

    def execute_script(self, script, *_args):
        if "CURRENT_PAGE_MARKER" in script:
            return self.current_page
        if "LAST_PAGE_MARKER" in script:
            return self.last_page
        return None  # scrollIntoView / click-fallback scripts -- no-op for these tests

    def find_elements(self, _by, selector):
        if selector == "button[aria-label]":
            visible = self.window if self.window is not None else {self.current_page}
            buttons = []
            for n in visible:
                label = f"Current page {n}" if n == self.current_page else f"Page {n}"
                buttons.append(_FakeButton(self, label, n))
            return buttons
        # Exact-label lookups (Next page / Previous page) -- not exercised here.
        return []


def _scraper(driver):
    return JobPortalScraper(driver=driver, search_url="https://example.test")


def test_current_page_parses_current_page_label():
    scraper = _scraper(_FakePagerDriver(current_page=31))
    assert scraper._current_page() == 31


def test_current_page_none_when_pager_absent():
    scraper = _scraper(_FakePagerDriver(current_page=None))
    assert scraper._current_page() is None


def test_last_page_is_the_max_visible_page_number():
    scraper = _scraper(_FakePagerDriver(current_page=31, last_page=39))
    assert scraper._last_page() == 39


def test_go_to_page_recovers_when_portal_resets_mid_session(monkeypatch):
    """The real-run scenario: expecting page 32, the portal is actually back on page
    2 with "Page 32" visible in the pager window. _go_to_page must click it and land
    on 32."""
    driver = _FakePagerDriver(current_page=2, window={1, 2, 3, 32})
    scraper = _scraper(driver)
    monkeypatch.setattr(scraper, "wait_for_page_ready", lambda: None)

    scraper._go_to_page(32)

    assert driver.current_page == 32


def test_go_to_page_clicks_closest_visible_button_when_exact_page_not_shown(monkeypatch):
    """If the exact target page isn't in the pager's window, click the closest
    numbered button on the correct side and let the next loop iteration re-evaluate
    (repeating until the target page finally scrolls into the window)."""
    driver = _FakePagerDriver(current_page=2, window={1, 2, 3, 5})

    # Clicking "Page 5" (closest to 32 that's visible and on the right side) should
    # bring 32 into view on the next call -- simulate that by growing the window.
    real_find_elements = driver.find_elements

    def find_elements(by, selector):
        if driver.current_page == 5 and selector == "button[aria-label]":
            driver.window = {3, 4, 5, 6, 32}
        return real_find_elements(by, selector)

    driver.find_elements = find_elements
    scraper = _scraper(driver)
    monkeypatch.setattr(scraper, "wait_for_page_ready", lambda: None)

    scraper._go_to_page(32)

    assert driver.current_page == 32


def test_go_to_page_raises_when_pager_has_no_usable_button():
    driver = _FakePagerDriver(current_page=2, window=set())
    scraper = _scraper(driver)

    with pytest.raises(RuntimeError, match="Could not navigate to portal page 32"):
        scraper._go_to_page(32)


def test_verify_current_page_recovers_on_mismatch(monkeypatch):
    driver = _FakePagerDriver(current_page=2, window={1, 2, 3, 32})
    scraper = _scraper(driver)
    monkeypatch.setattr(scraper, "wait_for_page_ready", lambda: None)

    scraper._verify_current_page(32)

    assert driver.current_page == 32


def test_verify_current_page_does_nothing_when_page_matches():
    driver = _FakePagerDriver(current_page=32, window={31, 32, 33})
    scraper = _scraper(driver)
    # No wait_for_page_ready patch needed -- if this called _go_to_page it would try
    # to use the real WebDriverWait-based wait_for_page_ready and hang/fail.
    scraper._verify_current_page(32)

    assert driver.current_page == 32


def test_visible_page_numbers_parses_both_label_styles():
    driver = _FakePagerDriver(current_page=2, window={1, 2, 3})
    scraper = _scraper(driver)

    pages = scraper._visible_page_numbers()

    assert pages.keys() == {1, 2, 3}
    assert pages[2].get_attribute("aria-label") == "Current page 2"
    assert pages[1].get_attribute("aria-label") == "Page 1"


def test_last_page_reads_the_real_portal_pager_window():
    """The portal's own pager on page 1 renders "Current page 1", "Page 2".."Page 6",
    an ellipsis (a <p>, so it has no aria-label and never shows up here), then
    "Page 38" and "Page 39" -- which must read as 39 pages, not as 8."""
    driver = _FakePagerDriver(current_page=1, last_page=39, window={1, 2, 3, 4, 5, 6, 38, 39})
    scraper = _scraper(driver)

    assert scraper._visible_page_numbers().keys() == {1, 2, 3, 4, 5, 6, 38, 39}
    assert scraper._last_page() == 39


# -- Counting the pages up front (run()) --------------------------------------


class _FakeRunDriver(_FakePagerDriver):
    """_FakePagerDriver plus what run() itself touches: driver.get and a page of
    job cards to count."""

    def __init__(self, current_page, last_page=None, cards=0):
        super().__init__(current_page, last_page)
        self.cards = [object() for _ in range(cards)]
        self.url = None

    def get(self, url):
        self.url = url

    def find_elements(self, by, selector):
        if selector == CARD_SELECTOR:
            return list(self.cards)
        return super().find_elements(by, selector)


def _run_ready_scraper(monkeypatch, driver, on_event):
    """A scraper whose navigation is stubbed out, so run() exercises only its page
    counting, its loop and its events. scrape_current_page emits one card event so
    tests can check what the page count is emitted *before*."""
    scraper = JobPortalScraper(driver=driver, search_url="https://example.test", on_event=on_event)
    monkeypatch.setattr(scraper, "wait_for_page_ready", lambda: None)
    monkeypatch.setattr(scraper, "_next_page_available", lambda: False)

    def scrape_current_page(page_number):
        scraper._emit(type="card", page=page_number, index=1, total=1, title="Data Analyst")
        return []

    monkeypatch.setattr(scraper, "scrape_current_page", scrape_current_page)
    return scraper


def test_run_emits_the_page_count_before_the_first_card(monkeypatch):
    events = []
    driver = _FakeRunDriver(current_page=1, last_page=39, cards=20)
    scraper = _run_ready_scraper(monkeypatch, driver, events.append)

    scraper.run()

    assert events[0] == {"type": "pages_found", "total_pages": 39, "cards_per_page": 20}
    kinds = [event["type"] for event in events]
    assert kinds.index("pages_found") < kinds.index("card")
    assert scraper.total_pages == 39


def test_run_completes_when_the_pager_cannot_be_read(monkeypatch):
    """A single page of results (or an unreadable pager) means no page count -- the
    run must carry on regardless, just without a total."""
    events = []
    driver = _FakeRunDriver(current_page=None, last_page=None, cards=20)
    scraper = _run_ready_scraper(monkeypatch, driver, events.append)

    scraper.run()

    assert events[0] == {"type": "pages_found", "total_pages": None, "cards_per_page": 20}
    assert scraper.total_pages is None
    assert [event["type"] for event in events].count("card") == 1


def test_run_re_emits_the_page_count_when_the_portal_reports_more_pages(monkeypatch):
    """If a later per-page read finds a higher last page (the portal added one, or
    its pager was unreadable up front), the total is announced again."""
    events = []
    driver = _FakeRunDriver(current_page=1, last_page=None, cards=20)
    scraper = _run_ready_scraper(monkeypatch, driver, events.append)
    readings = [None, 7]  # the up-front read, then the read after page 1
    monkeypatch.setattr(scraper, "_last_page", lambda: readings.pop(0) if readings else 7)

    scraper.run()

    counts = [event for event in events if event["type"] == "pages_found"]
    assert [event["total_pages"] for event in counts] == [None, 7]
    assert counts[1]["cards_per_page"] == 20
    assert scraper.total_pages == 7
