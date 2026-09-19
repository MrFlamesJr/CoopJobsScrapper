"""Selenium navigation for the co-op jobs portal.

Drives the browser: open a card, wait for the *right* detail panel, read it
atomically, move on. HTML parsing itself lives in panel_parser.parse_job_panel
(pure, no Selenium) so it is unit-testable on its own.

Fixes for "the scraper mixes up data sometimes":
  * Card list first -- an open panel is dismissed and the full card list must be
    back before the next card is clicked. The panel itself may stay visible (the
    portal can show it beside the list, and even pre-select the new page's first
    card before it is ever clicked), so a visible panel is accepted as soon as it
    matches AND its job number is no longer the previous card's (see
    _wait_for_matching_panel); a panel stuck on the old job number for the whole
    wait means the portal genuinely lists that job twice (DuplicateListing).
  * Identity check -- #orgname may be hidden-but-still-in-the-DOM right after
    closing, and (when visible) reads exactly "<title>, <employer>". Card titles
    can be prefixes of one another for the same employer, so plain containment
    is too weak; the primary check strips punctuation/spaces from both sides and
    compares them for exact equality, falling back to substring containment only
    when no #orgname text is available. The freshness of the *job number* is
    checked as part of this same wait (see _wait_for_matching_panel) rather than
    after parsing, so a panel that visibly matches but hasn't updated its job
    number yet is retried instead of immediately treated as a mismatch or, if it
    never catches up, as DuplicateListing (the portal really does list some jobs
    twice).
  * Atomic read -- one execute_script call finds the visible panel, walks up
    to its root, and returns both its outerHTML and its text together, so a
    record can never be built from a mix of old- and new-panel reads.
  * Pagination race -- Next is only considered to have worked once the old
    page's first card actually goes stale or changes; otherwise page N could
    be silently re-scraped as page N+1.
  * Portal-side page resets -- the portal (Blazor/MudBlazor) has been observed
    to reset its own pagination state back to page 1 mid-session; a Next click
    right after that lands on page 2, not on the page we expected. The scraper
    now tracks the *portal's own* page number (parsed from the MudBlazor pager's
    "Current page N" / "Page N" aria-labels, see _current_page/_last_page)
    instead of blindly incrementing a counter, checks it after every Next click
    (and once at page ready), and recovers with _go_to_page when it disagrees.
    This pagination logic lives in app.scraper.pager.Pager; JobPortalScraper just
    delegates to it (see self._pager) to keep this module focused on cards/panels.
  * Card/panel cross-check -- a settled, identity- and freshness-matched panel can
    still be *wrong*: real-run evidence has one atomic snapshot with the correct
    header/job number but another job's "Work model" value. Before a panel is
    accepted, each non-empty parsed value among location/work_model/deadline_text
    must also appear in the clicked card's own (pre-click) text; a mismatch is
    treated like an unsettled panel and polled again within the same deadline (see
    _wait_for_matching_panel), and only becomes an anomaly if it never resolves. A
    safety valve disables a field's check for the rest of the run if it fails on
    the first few cards while identity matches -- that pattern means the live
    text format doesn't match the panel's, not that the data is actually wrong.
  * Retry pass -- cards that exhaust their attempts are recorded, and once every
    page has been scraped once, each affected page is revisited and its failed
    cards retried a single time (see _retry_failed_cards). This is what turned
    ~15 "anomalies" in a real run -- all the second of two consecutive cards
    sharing a title+employer, whose panel just updated slowly -- into successes,
    on top of the freshness wait that already addresses the same root cause.
"""

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from selenium.common.exceptions import (
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from bs4 import BeautifulSoup

from app.scraper.pager import Pager
from app.scraper.panel_parser import normalize_text, parse_job_panel

logger = logging.getLogger(__name__)

CARD_SELECTOR = '[aria-label="Job Card"]'
PAGE_READY_TIMEOUT_SECONDS = 600  # doubles as the "wait for the user to log in" wait
PANEL_CLOSE_TIMEOUT_SECONDS = 15
PANEL_OPEN_TIMEOUT_SECONDS = 15
# The portal (Blazor) has been observed to briefly render a HALF-UPDATED detail
# panel while switching jobs -- one atomic snapshot of a real run had the right
# header/job number but another job's "Work model" value. A matching, fresh
# snapshot is therefore re-read after this delay and only accepted once two
# consecutive reads are byte-identical (see _wait_for_matching_panel).
PANEL_SETTLE_SECONDS = 0.3
CARD_RETRY_ATTEMPTS = 3

# Parsed panel fields that must also appear in the clicked card's own text (see
# _cross_check_mismatches). Title/employer identity is already verified by
# _panel_matches; these are the fields with real-run evidence of a half-updated
# panel slipping past that check.
CROSS_CHECK_FIELDS = ("location", "work_model", "deadline_text")
# How many of the run's first cards a field's cross-check is allowed to fail
# before it's disabled for the rest of the run (see _record_cross_check_outcome).
CROSS_CHECK_SAFETY_CARDS = 5

_BROWSER_CLOSED_MARKERS = (
    "invalid session id",
    "not connected to devtools",
    "target window already closed",
    "no such window",
    "connection refused",
)

# Atomically find the visible panel and return both its outerHTML and its text.
# Only a VISIBLE #orgname counts -- right after closing a panel it can still be
# in the DOM, just hidden, and would otherwise be mistaken for the new panel.
_PANEL_SNAPSHOT_SCRIPT = """
const candidates = document.querySelectorAll('#orgname');
let orgname = null;
for (const el of candidates) {
    if (el.offsetParent !== null) { orgname = el; break; }
}
if (!orgname) { return null; }
const orgnameText = orgname.textContent || '';
let node = orgname;
while (node.parentElement && node.parentElement !== document.body) {
    const candidate = node.parentElement;
    if (candidate.querySelector('#jobdescheading')) {
        node = candidate;
        break;
    }
    if (candidate.querySelector('[aria-label="Job Card"]')) {
        break;
    }
    node = candidate;
}
// If the panel root also holds the card list (split view), drop the cards: their
// titles would make the identity check pass for any card.
const panel = node.cloneNode(true);
panel.querySelectorAll('[aria-label="Job Card"]').forEach((card) => card.remove());
return {html: panel.outerHTML, text: panel.textContent || '', orgname: orgnameText};
"""


class Cancelled(Exception):
    """Raised to unwind the scrape when the caller's cancel Event is set."""


class PanelMismatch(Exception):
    """Raised when the open detail panel does not match the card that was clicked."""


class DuplicateListing(Exception):
    """Raised when the portal genuinely lists the same job twice in a row.

    The panel matched the clicked card's title/employer identity, but its job
    number stayed on the previous card's for the whole wait -- not a slow
    update, but two consecutive cards for one real posting. Not retried: retrying
    can't change what the portal is actually showing.
    """

    def __init__(self, message: str, job_number: str, html: str):
        super().__init__(message)
        self.job_number = job_number
        self.html = html


class BrowserClosed(Exception):
    """Raised when the user closed the browser window. Never retried -- always fatal."""


class JobPortalScraper:
    """Scrape every visible job from the portal, across all result pages."""

    def __init__(
        self,
        driver,
        search_url: str,
        cancel_event: Optional[threading.Event] = None,
        page_callback: Optional[Callable[[int, list], None]] = None,
        debug_dir: Optional[Path] = None,
        snapshot_all: bool = False,
        ready_callback: Optional[Callable[[], None]] = None,
    ):
        self.driver = driver
        self.search_url = search_url
        self.cancel_event = cancel_event or threading.Event()
        self.page_callback = page_callback
        self.ready_callback = ready_callback
        self.debug_dir = debug_dir
        self.snapshot_all = snapshot_all
        self.anomalies = 0
        # Accounting exposed to ScrapeRunner.status() -- see module docstring.
        self.cards_seen = 0
        self.duplicates = 0
        self._seen_job_numbers: set = set()
        # job_number of the last card successfully scraped -- lets us catch a panel
        # that still shows the previous job even though its title/employer text
        # happened to match too (see _wait_for_matching_panel).
        self._last_job_number: Optional[str] = None
        # Cards that exhausted CARD_RETRY_ATTEMPTS, kept for the end-of-run retry
        # pass (see _retry_failed_cards); each is {page, index, card_text, title,
        # employer}. After that pass runs, whatever remains here is final.
        self._skipped_cards: list = []
        # Card/panel cross-check safety valve (see _record_cross_check_outcome).
        self._cross_check_disabled_fields: set = set()
        self._cross_check_cards_seen = 0
        self._cross_check_fail_counts = {field: 0 for field in CROSS_CHECK_FIELDS}
        self._pager = Pager(self)

    @property
    def failed(self) -> list:
        """{page, title, employer} for every card that still failed after the
        end-of-run retry pass (see _retry_failed_cards) -- the final failure list
        ScrapeRunner.status() reports as "failed"/"failed_jobs"."""
        return [
            {"page": failure["page"], "title": failure["title"], "employer": failure["employer"]}
            for failure in self._skipped_cards
        ]

    def run(self) -> None:
        logger.info("Opening search page: %s", self.search_url)
        self.driver.get(self.search_url)
        logger.info("Waiting for portal login and the first page of jobs to appear.")
        self.wait_for_page_ready()
        if self.ready_callback is not None:
            self.ready_callback()

        # Track the *portal's own* page number, not a counter we increment ourselves --
        # the portal can reset its pagination state mid-session (see module docstring),
        # so trusting our own count would silently re-scrape old pages under new numbers.
        expected_page = self._current_page() or 1
        if expected_page != 1:
            logger.warning(
                "Portal started on page %d instead of page 1; navigating back.", expected_page
            )
            self._go_to_page(1)
            expected_page = 1

        while True:
            self._check_cancelled()
            self.wait_for_page_ready()
            self._verify_current_page(expected_page)
            jobs = self.scrape_current_page(expected_page)
            if self.page_callback is not None:
                self.page_callback(expected_page, jobs)

            self._check_cancelled()
            last_page = self._last_page()
            current_page = self._current_page()
            if last_page is not None and current_page is not None and current_page >= last_page:
                logger.info("Reached the final page (%d) after %d page(s).", last_page, expected_page)
                break
            if not self._next_page_available():
                logger.info("Reached the final page after %d page(s).", expected_page)
                break
            previous_page = expected_page
            expected_page += 1
            self._click_next_page(expected_page, previous_page)

        self._retry_failed_cards()
        # Authoritative, post-retry count -- see the module docstring and
        # _retry_failed_cards. Any earlier value only reflected the main sweep.
        self.anomalies = len(self._skipped_cards)

    def _check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled("Scrape was cancelled.")

    def wait_for_page_ready(self) -> None:
        cards_visible = EC.visibility_of_all_elements_located((By.CSS_SELECTOR, CARD_SELECTOR))

        def ready_or_cancelled(driver):
            self._check_cancelled()  # this wait can last minutes (login), so keep it cancellable
            return cards_visible(driver)

        wait = WebDriverWait(self.driver, PAGE_READY_TIMEOUT_SECONDS)
        try:
            wait.until(ready_or_cancelled)
        except TimeoutException as exc:
            raise RuntimeError(
                f"The search page did not become ready within {PAGE_READY_TIMEOUT_SECONDS} seconds."
            ) from exc

    def scrape_current_page(self, page_number: int) -> list:
        cards = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
        card_count = len(cards)
        logger.info("Found %d job card(s) on page %d.", card_count, page_number)

        jobs = []
        for index in range(card_count):
            self._check_cancelled()
            self.cards_seen += 1
            job = self._scrape_card(page_number, index, card_count)
            if job is None:
                continue
            job_number = job.get("job_number", "")
            if job_number and job_number in self._seen_job_numbers:
                logger.info("Skipping duplicate job_number %s.", job_number)
                self.duplicates += 1
                continue
            if job_number:
                self._seen_job_numbers.add(job_number)
            jobs.append(job)

        if card_count > 0 and not jobs:
            logger.error(
                "Every job on page %d was skipped -- see data/debug/anomalies.", page_number
            )
        return jobs

    def _scrape_card(self, page_number: int, index: int, expected_card_count: int) -> Optional[dict]:
        card_title = ""
        employer = ""
        card_text = ""
        last_html = ""
        attempt_errors: list = []
        for attempt in range(1, CARD_RETRY_ATTEMPTS + 1):
            try:
                self._close_detail_panel(expected_card_count)
                card = self._get_card(index)
                card_title = self._read_card_text(card, "#opptitle")
                employer = self._read_card_text(card, "#oppprovider")
                # Full card text, read BEFORE the click, for the cross-check below --
                # see the module docstring and _cross_check_mismatches.
                card_text = self._read_full_card_text(card)
                self._click(card)

                # _wait_for_matching_panel already guarantees this html is identity-
                # matched, fresh (job number moved on, or is unknown), AND cross-checked
                # against card_text -- it is parsed here, not re-fetched, so the job
                # dict is built from exactly what was verified.
                html = self._wait_for_matching_panel(card_title, employer, card_text)
                last_html = html
                job = parse_job_panel(html)
                panel_text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
                if not self._panel_matches(card_title, employer, panel_text, job.get("displayed_title", "")):
                    raise PanelMismatch(
                        f"Parsed panel does not mention card title {card_title!r} "
                        f"(employer {employer!r})."
                    )

                job_number = job.get("job_number", "")
                job["title"] = card_title
                job["employer"] = employer
                job["page_number"] = page_number
                logger.info("Scraped job %d/%d: %s at %s.", index + 1, expected_card_count, card_title, employer)
                self._save_snapshot(page_number, index, job_number, job, html, card_text=card_text)
                if job_number:
                    self._last_job_number = job_number
                return job
            except DuplicateListing as exc:
                # Not an anomaly and never retried -- the portal really did list this
                # job twice in a row (e.g. two consecutive cards, same title/employer).
                self.duplicates += 1
                logger.warning(
                    "Card %d (%r) is a duplicate listing of job %s; skipping.",
                    index + 1,
                    card_title,
                    exc.job_number,
                )
                self._save_snapshot(
                    page_number,
                    index,
                    exc.job_number,
                    {"title": card_title, "employer": employer, "duplicate_of": exc.job_number},
                    exc.html,
                    category="duplicates",
                    card_text=card_text,
                )
                return None
            except (StaleElementReferenceException, TimeoutException, PanelMismatch, RuntimeError) as exc:
                attempt_errors.append(str(exc))
                logger.warning(
                    "Anomaly on page %d, job %d (%r), attempt %d/%d: %s",
                    page_number,
                    index + 1,
                    card_title,
                    attempt,
                    CARD_RETRY_ATTEMPTS,
                    exc,
                )
            except WebDriverException as exc:
                self._raise_if_browser_closed(exc)
                attempt_errors.append(str(exc))
                logger.warning(
                    "WebDriver anomaly on page %d, job %d (%r), attempt %d/%d: %s",
                    page_number,
                    index + 1,
                    card_title,
                    attempt,
                    CARD_RETRY_ATTEMPTS,
                    exc,
                )

        self.anomalies += 1
        logger.error("Skipped page %d, job %d (%r) after %d attempts.", page_number, index + 1, card_title, CARD_RETRY_ATTEMPTS)
        # Always leave usable evidence behind: the panel HTML if we ever got one,
        # otherwise the whole page, so the next real run tells us what actually happened.
        if not last_html:
            last_html = self._full_page_html()
        self._save_snapshot(
            page_number,
            index,
            "",
            {
                "title": card_title,
                "employer": employer,
                "anomaly": True,
                "errors": attempt_errors,
            },
            last_html,
            anomaly=True,
            card_text=card_text,
        )
        # Recorded for the end-of-run retry pass (see _retry_failed_cards); this is
        # also how a *retry's* own failure re-registers itself as final.
        self._skipped_cards.append(
            {
                "page": page_number,
                "index": index,
                "card_text": card_text,
                "title": card_title,
                "employer": employer,
            }
        )
        return None

    def _full_page_html(self) -> str:
        """Best-effort full-page HTML for anomaly evidence when no panel HTML was ever read."""
        try:
            return self.driver.execute_script("return document.documentElement.outerHTML;") or ""
        except WebDriverException as exc:
            logger.warning("Could not capture full-page HTML for anomaly evidence: %s", exc)
            return ""

    def _wait_for_matching_panel(self, card_title: str, employer: str, card_text: str = "") -> str:
        """Poll the atomic panel snapshot until it visibly matches the clicked card,
        shows a job number that isn't just left over from the previous card, AND
        (if `card_text` is given) cross-checks clean against the card's own text.

        The portal pre-selects a job's detail panel as soon as a page of cards renders
        -- not only for the very first card of the run -- so the right panel is often
        already showing before, or immediately after, the click lands. A snapshot's
        identity is accepted as soon as it matches (see _panel_matches); there is no
        separate "has it changed since before the click" check. But identity matching
        alone isn't enough: two consecutive cards can share the exact same title and
        employer, and right after a fresh click the panel can still be showing the
        *previous* card's content for a moment. So a matching snapshot is only returned
        once its own parsed job number is empty (unknown metadata -- accept it) or
        different from self._last_job_number; otherwise we keep polling, on the theory
        that the panel just hasn't caught up yet. If that never resolves before the
        timeout, the portal is concluded to genuinely list the same job twice in a row,
        and DuplicateListing is raised instead of TimeoutException.

        A snapshot satisfying identity+freshness is still not returned right away,
        though: the portal (Blazor) has been observed to briefly render a
        HALF-UPDATED panel while switching jobs -- one atomic snapshot from a real
        run had the correct header/job number but another job's "Work model" value,
        so a single matching snapshot is not proof the panel finished rendering.
        Instead the candidate is re-read after PANEL_SETTLE_SECONDS and only
        accepted once two consecutive reads are byte-identical; if it changed, the
        new read becomes the candidate and settling is retried, all within the same
        overall deadline.

        A settled candidate is *still* not final: _cross_check_mismatches compares
        its non-empty location/work_model/deadline_text against `card_text` (read
        from the card before it was clicked). A mismatch is treated exactly like an
        unsettled panel -- keep polling within the same deadline -- since the most
        likely cause is the same half-updated-panel behaviour that motivates the
        settle check above, just caught by a different field. Only if no settled
        candidate ever cross-checks clean before the deadline does this become a
        PanelMismatch (an anomaly, retried by the caller like any other).
        """
        deadline = time.monotonic() + PANEL_OPEN_TIMEOUT_SECONDS
        last_seen = ""
        stale_match: Optional[dict] = None  # last matching-but-same-job-number snapshot seen
        last_mismatches: dict = {}  # last cross-check failure seen on an otherwise-settled panel
        while time.monotonic() < deadline:
            snapshot = self.driver.execute_script(_PANEL_SNAPSHOT_SCRIPT)
            if snapshot:
                last_seen = snapshot.get("text", "")
                if self._panel_matches(card_title, employer, last_seen, snapshot.get("orgname", "")):
                    job_number = parse_job_panel(snapshot["html"]).get("job_number", "")
                    if not job_number or job_number != self._last_job_number:
                        settled = self._await_settled_panel(
                            snapshot["html"], card_title, employer, deadline
                        )
                        if settled is not None:
                            mismatches = self._cross_check_mismatches(settled, card_text)
                            if not mismatches:
                                self._record_cross_check_outcome({})
                                return settled
                            last_mismatches = mismatches
                        continue
                    stale_match = {"html": snapshot["html"], "job_number": job_number}
            time.sleep(0.1)
        if stale_match is not None:
            raise DuplicateListing(
                f"Card {card_title!r} ({employer!r}) matches but keeps showing job number "
                f"{stale_match['job_number']!r} for the full {PANEL_OPEN_TIMEOUT_SECONDS}s wait; "
                "the portal lists it twice.",
                job_number=stale_match["job_number"],
                html=stale_match["html"],
            )
        if last_mismatches:
            self._record_cross_check_outcome(last_mismatches)
            details = "; ".join(f"panel {field}={value!r}" for field, value in last_mismatches.items())
            raise PanelMismatch(
                f"Card/panel cross-check failed for {card_title!r} ({employer!r}) after "
                f"{PANEL_OPEN_TIMEOUT_SECONDS}s: {details}; not found in card text "
                f"{card_text[:200]!r}."
            )
        raise TimeoutException(
            f"Detail panel never matched the card within {PANEL_OPEN_TIMEOUT_SECONDS}s "
            f"(card={card_title!r}, employer={employer!r}, last panel text={last_seen[:200]!r})."
        )

    def _await_settled_panel(
        self, candidate_html: str, card_title: str, employer: str, deadline: float
    ) -> Optional[str]:
        """Confirm `candidate_html` (already identity- and freshness-matched) is
        STABLE before trusting it, per the half-rendered-panel evidence described in
        _wait_for_matching_panel. Sleeps PANEL_SETTLE_SECONDS and re-reads the panel;
        returns the html once a re-read comes back byte-identical to the candidate
        that preceded it. If a re-read differs but still matches identity+freshness,
        it becomes the new candidate and settling is retried; if it stops matching
        (or disappears) settling is abandoned and None is returned so the caller
        falls back to the outer poll loop. Bounded by the same `deadline` as the
        overall wait.
        """
        while time.monotonic() < deadline:
            time.sleep(PANEL_SETTLE_SECONDS)
            recheck = self.driver.execute_script(_PANEL_SNAPSHOT_SCRIPT)
            if recheck and recheck.get("html") == candidate_html:
                return candidate_html
            if not recheck or not self._panel_matches(
                card_title, employer, recheck.get("text", ""), recheck.get("orgname", "")
            ):
                return None
            job_number = parse_job_panel(recheck["html"]).get("job_number", "")
            if job_number and job_number == self._last_job_number:
                return None
            candidate_html = recheck["html"]
        return None

    def _cross_check_mismatches(self, html: str, card_text: str) -> dict:
        """Non-empty parsed values among CROSS_CHECK_FIELDS that the panel disagrees
        with the card: {field: panel_value} for each one not found in `card_text`
        (already normalize_text'd by the caller). Real-run evidence: one atomic
        panel snapshot had job 752's correct header/job number but another job's
        "Work model" value -- a mismatch here catches that even when the identity
        check (title/employer only) can't. Fields disabled by the safety valve (see
        _record_cross_check_outcome) are skipped, and an empty `card_text` (e.g. the
        existing tests that don't pass one) disables the whole check.
        """
        if not card_text:
            return {}
        job = parse_job_panel(html)
        mismatches = {}
        for field in CROSS_CHECK_FIELDS:
            if field in self._cross_check_disabled_fields:
                continue
            value = job.get(field, "")
            if not value:
                continue
            if normalize_text(value) not in card_text:
                mismatches[field] = value
        return mismatches

    def _record_cross_check_outcome(self, mismatches: dict) -> None:
        """Safety valve against a format mismatch (not a real data bug) silently
        turning into anomalies for the whole run: if a field fails on every one of
        the first CROSS_CHECK_SAFETY_CARDS cards where the cross-check ran (identity
        already matched), that field's live card-text format probably just doesn't
        line up with the panel's, so stop checking it and log once. Only called once
        per _wait_for_matching_panel call (on its success or final-failure exit), so
        `mismatches` is that call's one verdict per field, not a per-poll count.
        """
        if self._cross_check_cards_seen >= CROSS_CHECK_SAFETY_CARDS:
            return
        self._cross_check_cards_seen += 1
        for field in CROSS_CHECK_FIELDS:
            if field in self._cross_check_disabled_fields:
                continue
            if field in mismatches:
                self._cross_check_fail_counts[field] += 1
        for field, count in self._cross_check_fail_counts.items():
            if field not in self._cross_check_disabled_fields and count >= CROSS_CHECK_SAFETY_CARDS:
                self._cross_check_disabled_fields.add(field)
                logger.warning(
                    "Card/panel cross-check for %r mismatched on the first %d cards; "
                    "disabling that check for the rest of the run.",
                    field,
                    CROSS_CHECK_SAFETY_CARDS,
                )

    @staticmethod
    def _identity_key(text: str) -> str:
        """NFKC + casefold + alphanumeric-only, so punctuation/spacing differences (a
        stray space before a comma, "A, B" vs "AB") never cause a false mismatch or,
        worse, let a short title falsely match as a substring of a longer one."""
        return re.sub(r"[^0-9a-z]", "", normalize_text(text))

    @staticmethod
    def _panel_matches(card_title: str, employer: str, panel_text: str, orgname_text: str = "") -> bool:
        """Identity check: prefer an exact key match against #orgname's own text
        ("<title>, <employer>", sometimes with a stray space), which is immune to one
        title being a prefix of another's ("Software Developer Intern" vs "Software
        Developer Intern, MyGeotab" at the same employer). Only when no #orgname text
        is available (e.g. in the post-parse recheck, if displayed_title was blank) do
        we fall back to substring containment against the full panel text.
        """
        if orgname_text:
            return JobPortalScraper._identity_key(orgname_text) == JobPortalScraper._identity_key(
                card_title + employer
            )
        normalized_panel = normalize_text(panel_text)
        normalized_title = normalize_text(card_title)
        if not normalized_title or normalized_title not in normalized_panel:
            return False
        normalized_employer = normalize_text(employer)
        if normalized_employer and normalized_employer not in normalized_panel:
            return False
        return True

    def _close_detail_panel(self, expected_card_count: int) -> None:
        """Escape any open panel, then wait for the card list to be restored.

        We only wait for the card count -- NOT for #orgname to become hidden. On this
        portal the job detail panel can be shown permanently beside the list (split
        view, e.g. the first job preselected by default), so #orgname may never
        disappear; that is normal and must not fail the card. Escape is still sent
        in case the panel is a dismissible overlay, but we don't require it to work.
        """
        try:
            panel_visible = self.driver.execute_script(
                "const el = document.querySelector('#orgname'); "
                "return !!(el && el.offsetParent !== null);"
            )
        except WebDriverException as exc:
            self._raise_if_browser_closed(exc)
            raise
        if panel_visible:
            self.driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)

        try:
            WebDriverWait(self.driver, PANEL_CLOSE_TIMEOUT_SECONDS).until(
                lambda driver: len(driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)) >= expected_card_count
            )
        except TimeoutException as exc:
            raise RuntimeError("The card list was not restored after closing the detail panel.") from exc

    def _get_card(self, index: int):
        cards = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
        if index >= len(cards):
            raise RuntimeError(f"Job card {index + 1} disappeared from the page.")
        return cards[index]

    def _click(self, element) -> None:
        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});", element)
        try:
            element.click()
        except WebDriverException:
            self.driver.execute_script("arguments[0].click();", element)

    # -- Pagination: thin delegation to app.scraper.pager.Pager (self._pager) -----
    # See the module docstring and pager.py -- these wrappers exist so callers (and
    # the tests in tests/test_portal_pagination.py) keep using JobPortalScraper's
    # own method names, without this module carrying the pager's implementation.

    def _next_page_available(self) -> bool:
        return self._pager.next_page_available()

    def _click_next_page(self, expected_page: int, previous_page: int) -> None:
        self._pager.click_next_page(expected_page, previous_page)

    def _page_has_advanced(self, first_card, first_title: str) -> bool:
        return self._pager.page_has_advanced(first_card, first_title)

    def _current_page(self) -> Optional[int]:
        return self._pager.current_page()

    def _last_page(self) -> Optional[int]:
        return self._pager.last_page()

    def _verify_current_page(self, expected_page: int) -> None:
        self._pager.verify_current_page(expected_page)

    def _go_to_page(self, expected: int) -> None:
        self._pager.go_to_page(expected)

    def _visible_page_numbers(self) -> dict:
        return self._pager.visible_page_numbers()

    def _find_page_button(self, page: int):
        return self._pager.find_page_button(page)

    def _closest_page_button(self, current: Optional[int], expected: int):
        return self._pager.closest_page_button(current, expected)

    def _find_button_by_aria_label(self, label: str):
        return self._pager.find_button_by_aria_label(label)

    # -- Retry pass -----------------------------------------------------------

    def _retry_failed_cards(self) -> None:
        """One retry pass over every card that exhausted its attempts during the
        main sweep, run once every page has been scraped (see run()). Real-run
        evidence: ~15 anomalies in one run were all the second of two consecutive
        cards sharing an identical title+employer, whose panel just updated slowly
        (the freshness wait in _wait_for_matching_panel already addresses that
        directly; this pass is a second line of defence for whatever else makes a
        card fail once).

        `self._skipped_cards` is drained up front, one page at a time; _scrape_card
        re-populates it with whatever still fails, so once this method returns, that
        list *is* the final failure set (see the `failed` property).
        """
        pending = self._skipped_cards
        if not pending:
            return
        self._skipped_cards = []
        pages = sorted({failure["page"] for failure in pending})
        logger.info("Retrying %d skipped card(s) across %d page(s).", len(pending), len(pages))
        for page in pages:
            self._check_cancelled()
            page_failures = [failure for failure in pending if failure["page"] == page]
            try:
                self._go_to_page(page)
                self.wait_for_page_ready()
            except (RuntimeError, WebDriverException) as exc:
                logger.warning(
                    "Could not return to page %d to retry %d card(s): %s", page, len(page_failures), exc
                )
                self._skipped_cards.extend(page_failures)
                continue

            page_jobs = []
            for failure in page_failures:
                cards = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
                index = self._find_card_index_by_text(failure["card_text"], failure["index"], len(cards))
                job = self._scrape_card(page, index, len(cards))
                if job is None:
                    continue  # _scrape_card already re-recorded this in self._skipped_cards
                job_number = job.get("job_number", "")
                if job_number and job_number in self._seen_job_numbers:
                    logger.info("Retry on page %d produced duplicate job_number %s; skipping.", page, job_number)
                    self.duplicates += 1
                    continue
                if job_number:
                    self._seen_job_numbers.add(job_number)
                page_jobs.append(job)

            if page_jobs and self.page_callback is not None:
                self.page_callback(page, page_jobs)

    def _find_card_index_by_text(self, card_text: str, fallback_index: int, card_count: int) -> int:
        """Locate a previously-failed card by its exact normalized full text --
        cards can shift position between the main pass and the retry pass -- falling
        back to its original index when there's no unique match (none found, or the
        text isn't unique, e.g. two genuinely identical cards)."""
        if card_text:
            cards = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
            matches = [i for i, card in enumerate(cards) if self._read_full_card_text(card) == card_text]
            if len(matches) == 1:
                return matches[0]
        return fallback_index if fallback_index < card_count else 0

    @staticmethod
    def _read_card_text(card, selector: str) -> str:
        if card is None:
            return ""
        try:
            return card.find_element(By.CSS_SELECTOR, selector).text.strip()
        except WebDriverException:
            return ""

    @staticmethod
    def _read_full_card_text(card) -> str:
        """The card's whole innerText, normalized -- used both for the panel
        cross-check (see _cross_check_mismatches) and to re-find a card by content
        during the retry pass (see _find_card_index_by_text)."""
        if card is None:
            return ""
        try:
            return normalize_text(card.text)
        except WebDriverException:
            return ""

    @staticmethod
    def _raise_if_browser_closed(exception: Exception) -> None:
        message = str(exception).lower()
        if any(marker in message for marker in _BROWSER_CLOSED_MARKERS):
            raise BrowserClosed("Browser window was closed.") from exception

    def _save_snapshot(
        self,
        page_number: int,
        index: int,
        job_number: str,
        job: dict,
        html: str = "",
        anomaly: bool = False,
        category: Optional[str] = None,
        card_text: str = "",
    ) -> None:
        # `category` (e.g. "duplicates") is always saved, like anomalies -- it's
        # evidence of a real, notable event, not routine snapshot_all logging.
        if category is None and not anomaly and not self.snapshot_all:
            return
        if self.debug_dir is None:
            return
        if category is not None:
            target_dir = self.debug_dir / category
        else:
            target_dir = (self.debug_dir / "anomalies") if anomaly else self.debug_dir
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            base = target_dir / f"{page_number}-{index}-{job_number or 'unknown'}"
            payload = dict(job)
            if card_text:
                payload["card_text"] = card_text
            base.with_suffix(".json").write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
            if html:
                base.with_suffix(".html").write_text(html, encoding="utf-8")
        except OSError as exc:
            logger.warning("Could not write debug snapshot for page %d, job %d: %s", page_number, index, exc)
