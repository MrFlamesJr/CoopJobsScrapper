"""Create the Selenium WebDriver used to drive the co-op jobs portal.

Opens a normal, visible browser window with a persistent profile directory so the
user's portal login survives between scraper runs. Chrome is tried first; if it is
not available on the machine, Edge is used instead (Selenium Manager resolves the
matching driver binary for either browser, so no paths are hardcoded here).
"""

import logging

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.edge.service import Service as EdgeService

from app import config

logger = logging.getLogger(__name__)

WINDOW_SIZE = "1280,900"

# Selenium's Service defaults close_fds to False on Windows, so chromedriver/msedgedriver
# can inherit the server's open socket handles (e.g. its 127.0.0.1:8000 listening socket).
# If the server dies and the driver process survives, that inherited handle keeps the port
# "in use" and can shadow the server's next listener. Python's usual non-inheritable-handle
# behaviour isn't reliable here on Windows when a Winsock LSP is installed, so force it.
_POPEN_KW = {"close_fds": True}


def _chrome_options(profile_dir: str) -> "webdriver.ChromeOptions":
    options = webdriver.ChromeOptions()
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument(f"--window-size={WINDOW_SIZE}")
    # Deliberately not suppressing "Chrome is being controlled by automated test
    # software" -- the user relies on that infobar as the visual cue that a given
    # window is the scraper's.
    return options


def _edge_options(profile_dir: str) -> "webdriver.EdgeOptions":
    options = webdriver.EdgeOptions()
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument(f"--window-size={WINDOW_SIZE}")
    return options


def create_driver() -> "webdriver.Remote":
    """Launch a real, visible browser window with a persistent login profile.

    Tries Chrome first, then falls back to Edge if Chrome cannot be started.
    """
    profile_dir = config.BROWSER_PROFILE_DIR
    chrome_profile = str(profile_dir / "chrome")
    try:
        service = ChromeService(popen_kw=_POPEN_KW)
        driver = webdriver.Chrome(options=_chrome_options(chrome_profile), service=service)
        logger.info("Launched Chrome for the scraper.")
        return driver
    except WebDriverException as exc:
        logger.warning("Chrome was not available (%s); falling back to Edge.", exc)

    edge_profile = str(profile_dir / "edge")
    service = EdgeService(popen_kw=_POPEN_KW)
    driver = webdriver.Edge(options=_edge_options(edge_profile), service=service)
    logger.info("Launched Edge for the scraper.")
    return driver
