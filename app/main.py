import logging
import os
import subprocess
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

from app.database.mysql_database import MySQLDatabase
from app.database.mysql_job_writer import MySQLJobWriter
from app.scraper.browser_status_monitor import BrowserStatusMonitor
from app.scraper.job_portal_scraper import JobPortalScraper
from app.ui.startup_menu import StartupMenu


SEARCH_URL = "https://experiential-learning.uottawa.ca/search"
DATABASE_NAME = "coop_jobs"


def configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    return logging.getLogger("job_scraper")


def create_webdriver():
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    service = Service(popen_kw={"creation_flags": creation_flags})
    return webdriver.Chrome(options=options, service=service)


def create_database():
    return MySQLDatabase(
        host=os.environ.get("MYSQL_HOST", "127.0.0.1"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        database=os.environ.get("MYSQL_DATABASE", DATABASE_NAME),
        user=os.environ["MYSQL_USER"],
        password=os.environ["MYSQL_PASSWORD"],
        schema_path=Path(__file__).resolve().parents[1] / "database" / "schema.sql",
    )


def scrape_jobs(database, logger):
    output_writer = MySQLJobWriter(
        host=database.host,
        port=database.port,
        database=database.database,
        user=database.user,
        password=database.password,
        search_url=SEARCH_URL,
    )
    driver = None
    browser_monitor = None
    scrape_completed = False

    logger.info("Starting automatic job scrape.")
    logger.info("Saving jobs to MySQL run %s.", output_writer.run_id)

    try:
        driver = create_webdriver()
        browser_monitor = BrowserStatusMonitor(driver, logger)
        browser_monitor.start()
        logger.info("Chrome browser started.")
        JobPortalScraper(
            driver,
            output_writer,
            logger,
            SEARCH_URL,
            browser_monitor,
        ).run()
        scrape_completed = True
        logger.info("Scrape completed successfully.")
    except RuntimeError as exc:
        logger.error("Scrape stopped: %s", exc)
    except KeyboardInterrupt:
        logger.info("Scrape interrupted by the user.")
    except WebDriverException as exc:
        message = str(exc).lower()
        if (
            "invalid session id" in message
            or "not connected to devtools" in message
            or "no such window" in message
        ):
            logger.error("The browser tab or window was closed; the scraper stopped gracefully.")
        else:
            logger.exception("WebDriver failure: %s", exc)
    finally:
        output_writer.close(completed=scrape_completed)
        if browser_monitor is not None:
            browser_monitor.close_browser()
        elif driver is not None:
            try:
                driver.quit()
                logger.info("Chrome browser closed.")
            except WebDriverException:
                logger.warning("Chrome browser was already closed.")


def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    logger = configure_logging()
    try:
        database = create_database()
        action = StartupMenu(database).choose_action()
        if action == "scrape":
            database.ensure()
            scrape_jobs(database, logger)
        elif action == "placeholder":
            print("Hello world")
    except mysql.connector.Error as exc:
        logger.error("Database setup failed: %s", exc)
    except KeyError as exc:
        logger.error("Missing required environment variable: %s", exc.args[0])


if __name__ == "__main__":
    main()
