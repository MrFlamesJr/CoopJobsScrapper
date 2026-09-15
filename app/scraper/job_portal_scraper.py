import logging
import time

from selenium.common.exceptions import (
    ElementClickInterceptedException,
    InvalidSessionIdException,
    NoSuchWindowException,
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


CARD_SELECTOR = '[aria-label="Job Card"]'
NEXT_PAGE_SELECTOR = 'button[aria-label="Next page"]'
PAGE_READY_TIMEOUT_SECONDS = 180
DETAIL_PANEL_TIMEOUT_SECONDS = 15
NEXT_PAGE_TIMEOUT_SECONDS = 10
CARD_RETRY_ATTEMPTS = 3
CARD_RETRY_DELAY_SECONDS = 1


class JobPortalScraper:
    """Scrape every visible job from the portal, including all result pages."""

    METADATA_LABELS = {
        "job number": "Job number",
        "duration": "Duration",
        "work model": "Work model",
        "term": "Term",
        "deadline": "Deadline",
        "round": "Round",
        "salary": "Salary",
    }

    def __init__(self, driver, output_writer, logger, search_url, browser_monitor=None, progress_callback=None):
        self.driver = driver
        self.output_writer = output_writer
        self.logger = logger
        self.search_url = search_url
        self.browser_monitor = browser_monitor
        self.progress_callback = progress_callback
        self.anomalies = []

    def run(self):
        self.logger.info("Opening search page: %s", self.search_url)
        self.driver.get(self.search_url)
        self.logger.info(
            "Please log in to the portal in the Chrome window. "
            "Scraping will continue automatically when the jobs are visible."
        )
        self.wait_for_page_ready()
        self.logger.info("Initial page is ready; starting automatic scrape.")
        if self.progress_callback is not None:
            self.progress_callback(event="portal_ready", message="Portal login detected. Scraping jobs now.")

        page_number = 1
        try:
            while True:
                self.wait_for_page_ready()
                jobs = self.scrape_current_page(page_number)
                self.output_writer.append_page(jobs, page_number)
                if self.progress_callback is not None:
                    self.progress_callback(
                        pages_completed=page_number,
                        jobs_saved=len(jobs),
                        message=f"Saved page {page_number} ({len(jobs)} jobs).",
                    )
                self.logger.info(
                    "Page %d complete: saved %d jobs to MySQL run %s.",
                    page_number,
                    len(jobs),
                    self.output_writer.run_id,
                )

                if not self.next_page_available():
                    self.logger.info("Reached the final page after %d page(s).", page_number)
                    return

                self.click_next_page()
                page_number += 1
        finally:
            self.log_anomaly_report()

    def wait_for_page_ready(self):
        self.ensure_browser_is_alive()
        wait = WebDriverWait(self.driver, PAGE_READY_TIMEOUT_SECONDS)
        try:
            wait.until(lambda driver: driver.execute_script("return document.readyState") == "complete")
            wait.until(EC.visibility_of_all_elements_located((By.CSS_SELECTOR, CARD_SELECTOR)))
        except TimeoutException as exc:
            raise RuntimeError(
                "The search page did not become ready: visible jobs were not found "
                f"within {PAGE_READY_TIMEOUT_SECONDS} seconds."
            ) from exc

    def next_page_available(self):
        try:
            button = WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, NEXT_PAGE_SELECTOR))
            )
            return button.is_displayed() and button.is_enabled() and button.get_attribute("disabled") is None
        except (TimeoutException, WebDriverException):
            return False

    def click_next_page(self):
        try:
            button = WebDriverWait(self.driver, NEXT_PAGE_TIMEOUT_SECONDS).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, NEXT_PAGE_SELECTOR))
            )
            self._click_element(button)
            self.logger.info("Moving to the next result page.")
        except TimeoutException as exc:
            raise RuntimeError("The next-page control was not available after the page was ready.") from exc

    def scrape_current_page(self, page_number):
        self.ensure_browser_is_alive()
        jobs = []
        cards = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
        card_count = len(cards)
        expected_titles = [self._read_card_text(card, "#opptitle") for card in cards]
        self.logger.info("Found %d job card(s) on the current page.", card_count)

        for card_index in range(card_count):
            job = self.scrape_job_card(
                page_number,
                card_index,
                expected_titles[card_index] if card_index < len(expected_titles) else "",
                card_count,
            )
            if job:
                jobs.append(job)

        return jobs

    def scrape_job_card(self, page_number, card_index, expected_title, expected_card_count):
        title = expected_title or "unknown title"
        for attempt in range(1, CARD_RETRY_ATTEMPTS + 1):
            panel_open = False
            try:
                self.ensure_browser_is_alive()
                self.close_detail_panel(expected_card_count)
                card = self._get_card(card_index)
                title = self._read_card_text(card, "#opptitle") or title
                employer = self._read_card_text(card, "#oppprovider")
                self._click_element(card)
                self.wait_for_detail_panel()
                panel_open = True

                job = self.extract_job(title, employer)
                self.logger.info(
                    "Scraped job %d: %s at %s.",
                    card_index + 1,
                    title,
                    employer or "unknown employer",
                )
                return job
            except StaleElementReferenceException as exc:
                self._record_anomaly(page_number, card_index, title, attempt, exc)
            except RuntimeError as exc:
                if "disappeared" not in str(exc).lower():
                    raise
                self._record_anomaly(page_number, card_index, title, attempt, exc)
            except WebDriverException as exc:
                self.ensure_browser_is_alive()
                self._record_anomaly(page_number, card_index, title, attempt, exc)
                break
            finally:
                if panel_open:
                    restored = self.close_detail_panel(expected_card_count)
                    if not restored:
                        self._record_anomaly(
                            page_number,
                            card_index,
                            title,
                            attempt,
                            RuntimeError("The full card list was not restored after closing the detail panel."),
                        )

            if attempt < CARD_RETRY_ATTEMPTS:
                time.sleep(CARD_RETRY_DELAY_SECONDS)

        self.logger.error(
            "Skipped page %d, job %d (%s) after %d attempts.",
            page_number,
            card_index + 1,
            title,
            CARD_RETRY_ATTEMPTS,
        )
        return None

    def close_detail_panel(self, expected_card_count):
        self.driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        try:
            WebDriverWait(self.driver, DETAIL_PANEL_TIMEOUT_SECONDS).until(
                lambda driver: len(driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)) >= expected_card_count
            )
            return True
        except TimeoutException as exc:
            self.logger.warning("The full card list was not restored after closing the detail panel: %s", exc)
            return False

    def _record_anomaly(self, page_number, card_index, title, attempt, exception):
        anomaly = {
            "page": page_number,
            "job": card_index + 1,
            "title": title,
            "attempt": attempt,
            "error": str(exception),
        }
        self.anomalies.append(anomaly)
        self.logger.warning(
            "Scrape anomaly: page %d, job %d, title=%r, attempt %d/%d: %s",
            anomaly["page"],
            anomaly["job"],
            anomaly["title"],
            anomaly["attempt"],
            CARD_RETRY_ATTEMPTS,
            anomaly["error"],
        )

    def log_anomaly_report(self):
        if not self.anomalies:
            self.logger.info("Final anomaly report: no anomalies recorded.")
            return

        self.logger.warning(
            "Final anomaly report: %d anomaly event(s) recorded.",
            len(self.anomalies),
        )
        for anomaly in self.anomalies:
            self.logger.warning(
                "  page %d, job %d, title=%r, attempt %d/%d: %s",
                anomaly["page"],
                anomaly["job"],
                anomaly["title"],
                anomaly["attempt"],
                CARD_RETRY_ATTEMPTS,
                anomaly["error"],
            )

    def wait_for_detail_panel(self):
        try:
            WebDriverWait(self.driver, DETAIL_PANEL_TIMEOUT_SECONDS).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, "#orgname"))
            )
        except TimeoutException as exc:
            raise RuntimeError("The job details panel did not become visible after selecting a job.") from exc

    def extract_job(self, title, employer):
        return {
            "title": title,
            "employer": employer,
            "displayed_job_title": self.safe_text("#orgname"),
            "metadata": self.extract_metadata(),
            "location": self.safe_text('[aria-label^="location "]'),
            "description": self.extract_description(),
            "qualifications": self.extract_qualifications(),
            "requirements": self.extract_requirements(),
        }

    def safe_text(self, selector):
        for _ in range(10):
            try:
                element = WebDriverWait(self.driver, 5).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, selector))
                )
                return (element.text or "").strip()
            except StaleElementReferenceException:
                time.sleep(0.2)
            except TimeoutException:
                return ""
            except WebDriverException as exc:
                self._raise_if_browser_closed(exc)
                return ""
        return ""

    def extract_requirements(self):
        for _ in range(10):
            try:
                container = self.driver.find_element(By.CSS_SELECTOR, "#jobreq")
                requirements = []
                for paragraph in container.find_elements(By.CSS_SELECTOR, "p"):
                    text = paragraph.text.strip()
                    if text:
                        requirements.append(text)
                return requirements
            except StaleElementReferenceException:
                time.sleep(0.2)
            except WebDriverException as exc:
                self._raise_if_browser_closed(exc)
                return []
        return []

    def extract_description(self):
        for _ in range(10):
            try:
                heading = self.driver.find_element(By.CSS_SELECTOR, "#jobdescheading")
                root = heading.find_element(By.XPATH, "..")
                parts = []
                for node in root.find_elements(
                    By.XPATH, ".//*[self::p or self::li or self::ul or self::ol]"
                ):
                    text = node.text.strip()
                    if text and text not in parts:
                        parts.append(text)
                return "\n\n".join(parts) or heading.text.strip()
            except StaleElementReferenceException:
                time.sleep(0.2)
            except WebDriverException as exc:
                self._raise_if_browser_closed(exc)
                return ""
        return ""

    def extract_qualifications(self):
        for _ in range(10):
            try:
                heading = self.driver.find_element(By.CSS_SELECTOR, "#qualifications")
                root = heading.find_element(By.XPATH, "..")
                values = [
                    paragraph.text.strip()
                    for paragraph in root.find_elements(By.CSS_SELECTOR, "p")
                    if paragraph.text.strip()
                ]
                return [
                    {
                        "name": values[index],
                        "value": values[index + 1] if index + 1 < len(values) else "",
                    }
                    for index in range(0, len(values), 2)
                ]
            except StaleElementReferenceException:
                time.sleep(0.2)
            except WebDriverException as exc:
                self._raise_if_browser_closed(exc)
                return []
        return []

    def extract_metadata(self):
        for _ in range(10):
            try:
                metadata = {}
                lists = self.driver.find_elements(By.CSS_SELECTOR, '[role="list"]')
                for list_container in lists:
                    items = list_container.find_elements(By.CSS_SELECTOR, '[role="listitem"]')
                    for index in range(0, len(items) - 1, 2):
                        label = items[index].text.strip().lower().strip(" :\n\t-")
                        canonical_label = self.METADATA_LABELS.get(label)
                        if canonical_label:
                            metadata[canonical_label] = items[index + 1].text.strip()
                return metadata
            except StaleElementReferenceException:
                time.sleep(0.2)
            except WebDriverException as exc:
                self._raise_if_browser_closed(exc)
                return {}
        return {}

    def ensure_browser_is_alive(self):
        if self.browser_monitor is not None:
            self.browser_monitor.raise_if_closed()
        try:
            self.driver.current_url
        except WebDriverException as exc:
            raise RuntimeError(
                "The browser tab or window was closed, so the scraper stopped gracefully."
            ) from exc

    @staticmethod
    def _raise_if_browser_closed(exception):
        message = str(exception).lower()
        if (
            isinstance(exception, (InvalidSessionIdException, NoSuchWindowException))
            or "not connected to devtools" in message
            or "invalid session id" in message
        ):
            raise RuntimeError(
                "The browser tab or window was closed, so the scraper stopped gracefully."
            ) from exception

    def _get_card(self, card_index):
        cards = self.driver.find_elements(By.CSS_SELECTOR, CARD_SELECTOR)
        if card_index >= len(cards):
            raise RuntimeError(f"Job card {card_index + 1} disappeared while scraping the page.")
        return cards[card_index]

    def _click_element(self, element):
        self.driver.execute_script(
            "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});",
            element,
        )
        try:
            element.click()
        except ElementClickInterceptedException:
            self.logger.debug("Normal click was intercepted; using the element's DOM click handler.")
            self.driver.execute_script("arguments[0].click();", element)

    @staticmethod
    def _read_card_text(card, selector):
        try:
            return card.find_element(By.CSS_SELECTOR, selector).text.strip()
        except WebDriverException:
            return ""
