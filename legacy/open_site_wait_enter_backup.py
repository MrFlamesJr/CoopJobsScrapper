import json
import time
from datetime import datetime
import os
from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

URL = "https://experiential-learning.uottawa.ca/search"


def next_page_available(driver, timeout=5):
    """Return True if the 'Next page' button is visible and enabled."""
    selector = 'button[aria-label="Next page"]'
    try:
        button = WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, selector))
        )
        return button.is_displayed() and button.is_enabled() and button.get_attribute("disabled") is None
    except Exception:
        return False


def click_next_page(driver, timeout=10):
    """Click the visible MudBlazor 'Next page' pagination button."""
    selector = 'button[aria-label="Next page"]'
    next_button = WebDriverWait(driver, timeout).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
    )
    next_button.click()
    return next_button


def wait_for_detail_panel(driver, timeout=15):
    """Wait for the selected job's details panel to become visible and stable."""
    def _panel_ready(d):
        try:
            orgname = d.find_element(By.CSS_SELECTOR, "#orgname")
            if orgname and orgname.is_displayed():
                return True
        except (StaleElementReferenceException, Exception):
            return False
        return False

    WebDriverWait(driver, timeout).until(_panel_ready)


def safe_text(driver, selector, timeout=5):
    last_error = None
    for _ in range(10):
        try:
            element = WebDriverWait(driver, timeout).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, selector))
            )
            return (element.text or "").strip()
        except StaleElementReferenceException as exc:
            last_error = exc
            time.sleep(0.2)
        except Exception:
            return ""
    if last_error:
        return ""
    return ""


def extract_requirements(driver):
    for _ in range(10):
        try:
            container = driver.find_element(By.CSS_SELECTOR, "#jobreq")
            requirements = []
            for paragraph in container.find_elements(By.CSS_SELECTOR, "p"):
                text = paragraph.text.strip()
                if text:
                    requirements.append(text)
            return requirements
        except StaleElementReferenceException:
            time.sleep(0.2)
        except Exception:
            return []
    return []


def extract_description(driver):
    for _ in range(10):
        try:
            heading = driver.find_element(By.CSS_SELECTOR, "#jobdescheading")
            root = heading.find_element(By.XPATH, "..")
            parts = []
            for node in root.find_elements(By.XPATH, ".//*[self::p or self::li or self::ul or self::ol]"):
                text = node.text.strip()
                if text and text not in parts:
                    parts.append(text)

            if parts:
                return "\n\n".join(parts)

            return heading.text.strip()
        except StaleElementReferenceException:
            time.sleep(0.2)
        except Exception:
            return ""
    return ""


def extract_metadata(driver):
    metadata = {}
    labels = {
        "job number": "Job number",
        "duration": "Duration",
        "work model": "Work model",
        "term": "Term",
        "deadline": "Deadline",
        "round": "Round",
        "salary": "Salary",
    }

    for _ in range(10):
        try:
            lists = driver.find_elements(By.CSS_SELECTOR, '[role="list"]')
            for list_container in lists:
                items = list_container.find_elements(By.CSS_SELECTOR, '[role="listitem"]')
                for i in range(0, len(items) - 1, 2):
                    label_text = (items[i].text or "").strip()
                    value_text = (items[i + 1].text or "").strip()
                    if not label_text:
                        continue

                    normalized = label_text.lower().strip(" :\n\t-")
                    canonical = labels.get(normalized)
                    if canonical:
                        metadata[canonical] = value_text
            return metadata
        except StaleElementReferenceException:
            time.sleep(0.2)
    return metadata


def extract_job_from_details_panel(driver, title="", employer=""):
    job = {
        "title": title,
        "employer": employer,
        "displayed_job_title": safe_text(driver, "#orgname"),
        "metadata": extract_metadata(driver),
        "location": safe_text(driver, '[aria-label^="location "]'),
        "description": extract_description(driver),
        "qualifications": safe_text(driver, "#qualifications"),
        "requirements": extract_requirements(driver),
    }
    return job


def make_unique_output_filename(base_name="scraped_jobs.json"):
    today = datetime.now().strftime("%Y_%m_%d")
    name, ext = os.path.splitext(base_name)
    candidate = f"{today}{ext}"
    counter = 1

    while os.path.exists(candidate):
        candidate = f"{today}_({counter}){ext}"
        counter += 1

    return candidate


def append_jobs_to_file(jobs, filename="scraped_jobs.json"):
    if not os.path.exists(filename):
        with open(filename, "w", encoding="utf-8") as f:
            json.dump([], f, ensure_ascii=False, indent=2)
            f.write("\n")

    with open(filename, "r", encoding="utf-8") as f:
        existing = json.load(f)

    if not isinstance(existing, list):
        existing = []

    existing.append(jobs)
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Appended {len(jobs)} jobs to {filename}")
    return filename


RUN_OUTPUT_FILE = make_unique_output_filename()


def browser_is_alive(driver):
    try:
        driver.current_url
        return True
    except Exception:
        return False


def wait_for_page_ready(driver, timeout=180):
    """Wait until the page is loaded and the job cards are visible."""
    wait = WebDriverWait(driver, timeout)
    wait.until(lambda d: d.execute_script("return document.readyState") == "complete")
    wait.until(EC.visibility_of_all_elements_located((By.CSS_SELECTOR, '[aria-label="Job Card"]')))
    return True


def scrape_current_page_jobs(driver):
    if not browser_is_alive(driver):
        raise RuntimeError("The browser window closed unexpectedly. The scraper has stopped.")

    jobs = []
    cards = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Job Card"]')

    for index in range(len(cards)):
        if not browser_is_alive(driver):
            raise RuntimeError("The browser window closed unexpectedly while scraping. The scraper has stopped.")

        cards = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Job Card"]')
        if index >= len(cards):
            break

        card = cards[index]

        try:
            title = card.find_element(By.CSS_SELECTOR, "#opptitle").text.strip()
        except Exception:
            title = ""

        try:
            employer = card.find_element(By.CSS_SELECTOR, "#oppprovider").text.strip()
        except Exception:
            employer = ""

        try:
            card.click()
            wait_for_detail_panel(driver, timeout=15)
        except StaleElementReferenceException:
            cards = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Job Card"]')
            if index < len(cards):
                cards[index].click()
            wait_for_detail_panel(driver, timeout=15)
        except Exception:
            if not browser_is_alive(driver):
                raise RuntimeError("The browser window closed unexpectedly while scraping. The scraper has stopped.")
            pass

        if not browser_is_alive(driver):
            raise RuntimeError("The browser window closed unexpectedly while scraping. The scraper has stopped.")

        job = extract_job_from_details_panel(driver, title=title, employer=employer)
        jobs.append(job)

    append_jobs_to_file(jobs, filename=RUN_OUTPUT_FILE)
    return jobs


def auto_scrape_all_pages(driver, timeout=180):
    page_number = 1
    while True:
        if not wait_for_page_ready(driver, timeout=timeout):
            print("Page not ready yet: jobs did not appear within the wait window.")
            break

        print(f"Scraping page {page_number}...")
        scrape_current_page_jobs(driver)

        if not next_page_available(driver, timeout=10):
            print("No more pages available. Finished scraping.")
            break

        click_next_page(driver)
        print("Clicked Next page.")
        page_number += 1
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
        WebDriverWait(driver, timeout).until(
            EC.visibility_of_all_elements_located((By.CSS_SELECTOR, '[aria-label="Job Card"]'))
        )


print(f"Using output file: {RUN_OUTPUT_FILE}")
print("Preparing Chrome browser...")
options = Options()
options.add_argument("--start-maximized")
options.add_argument("--disable-gpu")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")

try:
    driver = webdriver.Chrome(options=options)
    print("Browser launched.")
except Exception as exc:
    print(f"Chrome failed to start: {exc}")
    print("Close any open Chrome windows and try again.")
    raise

print(f"Opening page: {URL}")
driver.get(URL)
print("Page loaded. Keep the browser open to watch the login flow.")

try:
    if wait_for_page_ready(driver, timeout=180):
        print("Page ready: jobs are visible and the page has finished loading.")
        auto_scrape_all_pages(driver)
    else:
        print("Page not ready yet: jobs did not appear within the wait window.")
except RuntimeError as exc:
    print(exc)

print("Stopping browser...")
try:
    if driver is not None and browser_is_alive(driver):
        driver.quit()
except Exception:
    pass
