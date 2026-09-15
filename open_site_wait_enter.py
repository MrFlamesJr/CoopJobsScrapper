from pprint import pformat
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

URL = "https://experiential-learning.uottawa.ca/search"


def click_next_page(driver, timeout=10):
    """Click the visible MudBlazor 'Next page' pagination button."""
    selector = 'button[aria-label="Next page"]'
    next_button = WebDriverWait(driver, timeout).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
    )
    next_button.click()
    return next_button


def safe_text(driver, selector, timeout=5):
    try:
        element = WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, selector))
        )
        return (element.text or "").strip()
    except Exception:
        return ""


def extract_requirements(driver):
    try:
        container = driver.find_element(By.CSS_SELECTOR, "#jobreq")
    except Exception:
        return []

    requirements = []
    for paragraph in container.find_elements(By.CSS_SELECTOR, "p"):
        text = paragraph.text.strip()
        if text:
            requirements.append(text)
    return requirements


def extract_description(driver):
    try:
        heading = driver.find_element(By.CSS_SELECTOR, "#jobdescheading")
    except Exception:
        return ""

    root = heading.find_element(By.XPATH, "..")
    parts = []
    for node in root.find_elements(By.XPATH, ".//*[self::p or self::li or self::ul or self::ol]"):
        text = node.text.strip()
        if text and text not in parts:
            parts.append(text)

    if parts:
        return "\n\n".join(parts)

    return heading.text.strip()


def extract_metadata(driver):
    metadata = {}
    labels = [
        "Job number",
        "Duration",
        "Work model",
        "Term",
        "Deadline",
        "Round",
        "Salary",
    ]

    for item in driver.find_elements(By.CSS_SELECTOR, '[role="listitem"]'):
        text = (item.text or "").strip()
        if not text:
            continue

        for label in labels:
            lower_label = label.lower()
            if text.lower().startswith(lower_label):
                value = text[len(label):].strip(" :\n\t-")
                metadata[label] = value
                break

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


def scrape_current_page_jobs(driver):
    jobs = []
    cards = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Job Card"]')

    for index in range(len(cards)):
        cards = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Job Card"]')
        card = cards[index]

        try:
            title = card.find_element(By.CSS_SELECTOR, "#opptitle").text.strip()
        except Exception:
            title = ""

        try:
            employer = card.find_element(By.CSS_SELECTOR, "#oppprovider").text.strip()
        except Exception:
            employer = ""

        card.click()

        try:
            WebDriverWait(driver, 10).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, "#orgname")
            )
        except Exception:
            pass

        job = extract_job_from_details_panel(driver, title=title, employer=employer)
        jobs.append(job)
        print(pformat(job, sort_dicts=False))

    return jobs


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
print("Commands: 'next', 'scrape', 'quit'")

try:
    while True:
        command = input().strip().lower()
        if command == "next":
            try:
                click_next_page(driver)
                print("Clicked Next page.")
            except Exception as exc:
                print(f"Could not click Next page: {exc}")
        elif command == "scrape":
            try:
                jobs = scrape_current_page_jobs(driver)
                print(pformat({"jobs": jobs}, sort_dicts=False))
            except Exception as exc:
                print(f"Could not scrape current page: {exc}")
        elif command in {"quit", "exit"}:
            break
        else:
            print("Unknown command. Try: 'next', 'scrape', or 'quit'.")
except KeyboardInterrupt:
    print("\nStopping browser...")
finally:
    driver.quit()
