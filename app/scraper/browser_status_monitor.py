import atexit
import logging
import threading

from selenium.common.exceptions import WebDriverException


class BrowserStatusMonitor:
    """Monitor a Selenium browser connection until it closes or monitoring stops."""

    def __init__(self, driver, logger=None, interval_seconds=0.5):
        self.driver = driver
        self.logger = logger or logging.getLogger(__name__)
        self.interval_seconds = interval_seconds
        self._stop_event = threading.Event()
        self._closed_event = threading.Event()
        self._cleanup_lock = threading.Lock()
        self._cleanup_started = False
        self._thread = None

    def start(self):
        self._thread = threading.Thread(
            target=self._monitor,
            name="browser-status-monitor",
            daemon=True,
        )
        self._thread.start()
        atexit.register(self.close_browser)

    def stop(self):
        self._stop_event.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)

    def close_browser(self):
        """Stop monitoring and close the Selenium browser exactly once."""
        with self._cleanup_lock:
            if self._cleanup_started:
                return
            self._cleanup_started = True

        self.stop()
        if self._service_is_running():
            try:
                self._disable_connection_retries()
                self.driver.quit()
                self.logger.info("Chrome browser closed and the WebDriver session ended.")
            except Exception as exc:
                self.logger.warning(
                    "Could not contact ChromeDriver during cleanup; browser closure could not be confirmed: %s",
                    exc,
                )
        else:
            self.logger.info("ChromeDriver was already closed; skipping Selenium shutdown request.")

        self._stop_driver_service()

    def raise_if_closed(self):
        if self._closed_event.is_set():
            raise RuntimeError(
                "The browser tab or window was closed, so the scraper stopped gracefully."
            )

    def _monitor(self):
        while not self._stop_event.wait(self.interval_seconds):
            if not self._browser_is_reachable():
                self._closed_event.set()
                self.logger.error(
                    "The Selenium browser session ended; the scraper will stop gracefully."
                )
                return

    def _browser_is_reachable(self):
        service_process = getattr(getattr(self.driver, "service", None), "process", None)
        if service_process is not None and service_process.poll() is not None:
            return False

        try:
            self.driver.current_url
            return True
        except WebDriverException:
            return False

    def _service_is_running(self):
        service_process = getattr(getattr(self.driver, "service", None), "process", None)
        return service_process is None or service_process.poll() is None

    def _stop_driver_service(self):
        service = getattr(self.driver, "service", None)
        if service is None:
            return
        try:
            service.stop()
        except Exception as exc:
            self.logger.debug("ChromeDriver service cleanup did not complete: %s", exc)

    def _disable_connection_retries(self):
        """Prevent shutdown from retrying a ChromeDriver connection that is disappearing."""
        command_executor = getattr(self.driver, "command_executor", None)
        connection = getattr(command_executor, "_conn", None)
        if connection is None:
            return

        connection.connection_pool_kw["retries"] = 0
        connection.clear()

