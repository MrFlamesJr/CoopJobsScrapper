"""Cheap tests for JobPortalScraper's end-of-run retry pass -- no real browser.

_scrape_card and the navigation helpers are faked at the method level rather
than driven through a full Selenium script sequence: _retry_failed_cards' own
bookkeeping (which pages get revisited, how a card is relocated by its text,
what gets reported and what gets dropped from the failure list) doesn't depend
on any of that machinery.
"""

from app.scraper.portal import CARD_SELECTOR, JobPortalScraper


class _FakeCard:
    def __init__(self, text):
        self.text = text


class _FakeDriver:
    """find_elements(CARD_SELECTOR) returns whatever `cards` currently holds."""

    def __init__(self, cards):
        self.cards = cards

    def find_elements(self, _by, selector):
        assert selector == CARD_SELECTOR
        return self.cards


def _scraper(cards=()):
    return JobPortalScraper(driver=_FakeDriver(list(cards)), search_url="https://example.test")


def _stub_navigation(scraper, monkeypatch):
    monkeypatch.setattr(scraper, "_go_to_page", lambda page: None)
    monkeypatch.setattr(scraper, "wait_for_page_ready", lambda: None)


def test_retry_finds_card_by_exact_text_not_the_recorded_index(monkeypatch):
    """Cards can shift position between the main pass and the retry pass -- the
    card must be relocated by its exact normalized text, not the stale index."""
    scraper = _scraper([_FakeCard("Other Job Other Co"), _FakeCard("Target Job Target Co")])
    scraper._skipped_cards = [
        {"page": 2, "index": 0, "card_text": "target job target co", "title": "Target Job", "employer": "Target Co"}
    ]
    _stub_navigation(scraper, monkeypatch)
    seen_indexes = []

    def fake_scrape_card(_page, index, _expected_count):
        seen_indexes.append(index)
        return {"job_number": "J5", "title": "Target Job", "employer": "Target Co"}

    monkeypatch.setattr(scraper, "_scrape_card", fake_scrape_card)
    reported = []
    scraper.page_callback = lambda page, jobs: reported.append((page, jobs))

    scraper._retry_failed_cards()

    assert seen_indexes == [1]  # found by text, not the recorded (now stale) index 0
    assert reported == [(2, [{"job_number": "J5", "title": "Target Job", "employer": "Target Co"}])]
    assert scraper._skipped_cards == []
    assert scraper.failed == []


def test_retry_falls_back_to_recorded_index_when_text_match_is_not_unique(monkeypatch):
    scraper = _scraper([_FakeCard("Same Job Same Co"), _FakeCard("Same Job Same Co")])
    scraper._skipped_cards = [
        {"page": 1, "index": 1, "card_text": "same job same co", "title": "Same Job", "employer": "Same Co"}
    ]
    _stub_navigation(scraper, monkeypatch)
    seen_indexes = []
    monkeypatch.setattr(
        scraper,
        "_scrape_card",
        lambda _page, index, _expected_count: seen_indexes.append(index) or {"job_number": "J1"},
    )
    scraper.page_callback = lambda page, jobs: None

    scraper._retry_failed_cards()

    assert seen_indexes == [1]  # ambiguous (two identical cards) -> fall back to the recorded index


def test_retry_pass_drops_a_fixed_card_but_keeps_a_final_failure(monkeypatch):
    """A card that fails again on retry re-records itself via _scrape_card's own
    normal failure path; a successful retry must be dropped from the failure list
    entirely, not just left alongside the still-broken one."""
    scraper = _scraper([_FakeCard("Fixed Job Fixed Co"), _FakeCard("Still Broken Job Broken Co")])
    scraper._skipped_cards = [
        {"page": 3, "index": 0, "card_text": "fixed job fixed co", "title": "Fixed Job", "employer": "Fixed Co"},
        {
            "page": 3,
            "index": 1,
            "card_text": "still broken job broken co",
            "title": "Still Broken Job",
            "employer": "Broken Co",
        },
    ]
    _stub_navigation(scraper, monkeypatch)

    def fake_scrape_card(page, index, _expected_count):
        if index == 0:
            return {"job_number": "J1", "title": "Fixed Job", "employer": "Fixed Co"}
        scraper._skipped_cards.append(
            {
                "page": page,
                "index": index,
                "card_text": "still broken job broken co",
                "title": "Still Broken Job",
                "employer": "Broken Co",
            }
        )
        return None

    monkeypatch.setattr(scraper, "_scrape_card", fake_scrape_card)
    reported = []
    scraper.page_callback = lambda page, jobs: reported.append((page, jobs))

    scraper._retry_failed_cards()

    assert reported == [(3, [{"job_number": "J1", "title": "Fixed Job", "employer": "Fixed Co"}])]
    assert scraper.failed == [{"page": 3, "title": "Still Broken Job", "employer": "Broken Co"}]


def test_retry_pass_visits_each_failed_page_once_in_ascending_order(monkeypatch):
    scraper = _scraper([_FakeCard("Job A Co A"), _FakeCard("Job B Co B")])
    scraper._skipped_cards = [
        {"page": 9, "index": 0, "card_text": "job c co c", "title": "Job C", "employer": "Co C"},
        {"page": 5, "index": 0, "card_text": "job a co a", "title": "Job A", "employer": "Co A"},
        {"page": 5, "index": 1, "card_text": "job b co b", "title": "Job B", "employer": "Co B"},
    ]
    visited_pages = []
    monkeypatch.setattr(scraper, "_go_to_page", lambda page: visited_pages.append(page))
    monkeypatch.setattr(scraper, "wait_for_page_ready", lambda: None)
    monkeypatch.setattr(
        scraper, "_scrape_card", lambda page, index, _expected_count: {"job_number": f"J{page}-{index}"}
    )
    scraper.page_callback = lambda page, jobs: None

    scraper._retry_failed_cards()

    assert visited_pages == [5, 9]


def test_retry_pass_does_nothing_when_there_are_no_failures():
    scraper = _scraper([])
    scraper._retry_failed_cards()
    assert scraper._skipped_cards == []
    assert scraper.failed == []
