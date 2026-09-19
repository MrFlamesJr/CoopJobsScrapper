"""Cheap tests for JobPortalScraper's panel-matching -- no real browser."""

import pytest

import app.scraper.portal as portal
from app.scraper.panel_parser import normalize_text
from app.scraper.portal import DuplicateListing, JobPortalScraper, PanelMismatch


class _FakeDriver:
    """execute_script returns one scripted snapshot per call, in order."""

    def __init__(self, snapshots):
        self._snapshots = list(snapshots)

    def execute_script(self, _script):
        return self._snapshots.pop(0) if self._snapshots else None


def _panel_html(job_number: str = "", title: str = "", employer: str = "") -> str:
    """Minimal panel markup: an #orgname element and a "Job Number" metadata item,
    just enough for parse_job_panel to pull out displayed_title/job_number."""
    orgname = f"{title}, {employer}" if (title or employer) else ""
    return (
        f'<div><div id="orgname">{orgname}</div>'
        f'<div role="listitem">Job Number: {job_number}</div></div>'
    )


def test_wait_for_matching_panel_accepts_already_visible_panel_immediately(monkeypatch):
    """The portal can pre-select a job's panel before the click ever lands -- on any
    page, not just the first. A panel that already matches the card is accepted right
    away, even when _last_job_number is set (i.e. this isn't the first card of the run).
    A matching snapshot must still settle (read identical twice) before acceptance.
    """
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    preselected = {"html": "<div>first</div>", "text": "First Job at First Co"}
    scraper = JobPortalScraper(
        driver=_FakeDriver([preselected, preselected]), search_url="https://example.test"
    )
    scraper._last_job_number = "J1"

    html = scraper._wait_for_matching_panel("First Job", "First Co")

    assert html == preselected["html"]


def test_wait_for_matching_panel_polls_until_it_matches(monkeypatch):
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    stale = {"html": "<div>old</div>", "text": "Old Job at Old Co"}
    fresh = {"html": "<div>new</div>", "text": "New Job at New Co"}
    scraper = JobPortalScraper(
        driver=_FakeDriver([stale, stale, fresh, fresh]), search_url="https://example.test"
    )

    html = scraper._wait_for_matching_panel("New Job", "New Co")

    assert html == fresh["html"]


def test_wait_for_matching_panel_accepts_new_job_number_immediately(monkeypatch):
    """A panel that identity-matches AND already shows a different job number than
    last time is accepted right away (once settled) -- no need to wait it out."""
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    snapshot = {
        "html": _panel_html("J2", "New Job", "New Co"),
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    scraper = JobPortalScraper(
        driver=_FakeDriver([snapshot, snapshot]), search_url="https://example.test"
    )
    scraper._last_job_number = "J1"

    html = scraper._wait_for_matching_panel("New Job", "New Co")

    assert html == snapshot["html"]


def test_wait_for_matching_panel_switches_from_old_job_number_to_new(monkeypatch):
    """The panel can identity-match right away but still show the previous job's
    number for a few polls before it catches up -- that must not be mistaken for a
    duplicate listing; polling continues until the number actually changes."""
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    stale_number = {
        "html": _panel_html("J1", "New Job", "New Co"),
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    fresh_number = {
        "html": _panel_html("J2", "New Job", "New Co"),
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    scraper = JobPortalScraper(
        driver=_FakeDriver([stale_number, stale_number, fresh_number, fresh_number]),
        search_url="https://example.test",
    )
    scraper._last_job_number = "J1"

    html = scraper._wait_for_matching_panel("New Job", "New Co")

    assert html == fresh_number["html"]


def test_wait_for_matching_panel_requires_two_identical_reads_before_accepting(monkeypatch):
    """Real evidence: the portal can briefly render a HALF-UPDATED detail panel --
    one atomic snapshot had the right header/job number but another job's "Work
    model" value. A matching, fresh snapshot that then CHANGES on re-read must not
    be accepted; only once two consecutive reads are byte-identical is it trusted.
    """
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    half_rendered = {
        "html": _panel_html("J2", "New Job", "New Co") + "<div>Work model: Remote</div>",
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    settled = {
        "html": _panel_html("J2", "New Job", "New Co") + "<div>Work model: Onsite</div>",
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    scraper = JobPortalScraper(
        driver=_FakeDriver([half_rendered, settled, settled]),
        search_url="https://example.test",
    )
    scraper._last_job_number = "J1"

    html = scraper._wait_for_matching_panel("New Job", "New Co")

    assert html == settled["html"]
    assert html != half_rendered["html"]


def test_wait_for_matching_panel_raises_duplicate_listing_when_job_number_never_changes(monkeypatch):
    """If the panel matches but keeps showing the previous job's number for the whole
    wait, it's a genuine duplicate listing (two cards, one posting), not a slow panel."""
    monkeypatch.setattr(portal, "PANEL_OPEN_TIMEOUT_SECONDS", 0.3)
    stuck = {
        "html": _panel_html("J1", "Same Job", "Same Co"),
        "text": "Same Job at Same Co",
        "orgname": "Same Job, Same Co",
    }
    scraper = JobPortalScraper(driver=_FakeDriver([stuck] * 50), search_url="https://example.test")
    scraper._last_job_number = "J1"

    with pytest.raises(DuplicateListing) as excinfo:
        scraper._wait_for_matching_panel("Same Job", "Same Co")

    assert excinfo.value.job_number == "J1"
    assert excinfo.value.html == stuck["html"]


def test_panel_matches_uses_orgname_identity_key_not_substring_containment():
    """Card titles can be a prefix of another card's title at the same employer
    ("Software Developer Intern" vs "Software Developer Intern, MyGeotab"). Plain
    substring containment would match the shorter title against the longer panel;
    the orgname-based identity key must not.
    """
    longer_card_orgname = "Software Developer Intern, MyGeotab, MyGeotab"

    matches_shorter_title = JobPortalScraper._panel_matches(
        "Software Developer Intern", "MyGeotab", panel_text="", orgname_text=longer_card_orgname
    )
    matches_exact_title = JobPortalScraper._panel_matches(
        "Software Developer Intern, MyGeotab", "MyGeotab", panel_text="", orgname_text=longer_card_orgname
    )

    assert matches_shorter_title is False
    assert matches_exact_title is True


def test_panel_matches_falls_back_to_containment_without_orgname_text():
    assert JobPortalScraper._panel_matches("New Job", "New Co", panel_text="New Job at New Co", orgname_text="")
    assert not JobPortalScraper._panel_matches("New Job", "New Co", panel_text="Old Job at Old Co", orgname_text="")


# -- Card/panel cross-check --------------------------------------------------
#
# Real-run evidence: one atomic panel snapshot had job 752's correct header/job
# number but another job's "Work model" value -- identity matching alone can't
# catch that. Each non-empty parsed location/work_model/deadline_text must also
# appear in the card's own (pre-click) text; a mismatch is treated like an
# unsettled panel (keep polling) rather than an immediate failure.


def _panel_html_with_work_model(job_number: str, title: str, employer: str, work_model: str) -> str:
    return _panel_html(job_number, title, employer) + f'<div role="listitem">Work model: {work_model}</div>'


def test_wait_for_matching_panel_treats_cross_check_mismatch_as_unsettled_then_accepts_match(monkeypatch):
    """A settled, identity+freshness-matched panel that disagrees with the card's
    own text (e.g. the wrong Work model) must not be accepted or immediately
    failed -- it's polled again, exactly like an unsettled panel, until a later
    read agrees."""
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    card_text = normalize_text("New Job New Co Ottawa Hybrid Deadline: 2026-09-30")
    wrong = {
        "html": _panel_html_with_work_model("J2", "New Job", "New Co", "Remote"),
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    right = {
        "html": _panel_html_with_work_model("J2", "New Job", "New Co", "Hybrid"),
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    scraper = JobPortalScraper(
        driver=_FakeDriver([wrong, wrong, right, right]), search_url="https://example.test"
    )
    scraper._last_job_number = "J1"

    html = scraper._wait_for_matching_panel("New Job", "New Co", card_text)

    assert html == right["html"]


def test_wait_for_matching_panel_raises_panel_mismatch_when_cross_check_never_resolves(monkeypatch):
    """If the cross-check never resolves before the deadline, it's an anomaly
    (PanelMismatch, retried by the caller like any other) -- not a silent skip --
    and the message names the field, the card's own text, and the panel's value."""
    monkeypatch.setattr(portal, "PANEL_SETTLE_SECONDS", 0)
    monkeypatch.setattr(portal, "PANEL_OPEN_TIMEOUT_SECONDS", 0.3)
    card_text = normalize_text("New Job New Co Ottawa Hybrid Deadline: 2026-09-30")
    wrong = {
        "html": _panel_html_with_work_model("J2", "New Job", "New Co", "Remote"),
        "text": "New Job at New Co",
        "orgname": "New Job, New Co",
    }
    scraper = JobPortalScraper(driver=_FakeDriver([wrong] * 200), search_url="https://example.test")
    scraper._last_job_number = "J1"

    with pytest.raises(PanelMismatch) as excinfo:
        scraper._wait_for_matching_panel("New Job", "New Co", card_text)

    message = str(excinfo.value)
    assert "work_model" in message
    assert "Remote" in message
    assert "hybrid" in message  # the card's own (normalized) text, for context


def test_cross_check_safety_valve_disables_field_after_first_cards_all_mismatch(caplog):
    """If a field mismatches on every one of the first CROSS_CHECK_SAFETY_CARDS
    cards where identity matched, the live text format for that field probably
    just doesn't line up with the panel's -- not a real data bug -- so checking
    it is disabled for the rest of the run, with exactly one WARNING log line."""
    scraper = JobPortalScraper(driver=_FakeDriver([]), search_url="https://example.test")

    with caplog.at_level("WARNING"):
        for _ in range(portal.CROSS_CHECK_SAFETY_CARDS):
            scraper._record_cross_check_outcome({"work_model": "Remote"})

    assert scraper._cross_check_disabled_fields == {"work_model"}
    disabling_messages = [m for m in caplog.messages if "work_model" in m and "disabling" in m]
    assert len(disabling_messages) == 1

    # Once disabled, the check is skipped even though the panel value still isn't
    # in the card's text.
    html = _panel_html_with_work_model("J9", "New Job", "New Co", "Remote")
    assert scraper._cross_check_mismatches(html, "new job new co onsite") == {}


def test_cross_check_safety_valve_does_not_trip_once_a_card_matches():
    """A field that matches on at least one of the first few cards must not be
    disabled -- only a mismatch on EVERY one of them trips the valve."""
    scraper = JobPortalScraper(driver=_FakeDriver([]), search_url="https://example.test")

    scraper._record_cross_check_outcome({"work_model": "Remote"})
    scraper._record_cross_check_outcome({})  # this card's work_model matched
    for _ in range(portal.CROSS_CHECK_SAFETY_CARDS - 2):
        scraper._record_cross_check_outcome({"work_model": "Remote"})

    assert "work_model" not in scraper._cross_check_disabled_fields
