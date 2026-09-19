"""Entry point: `python -m app` (also called by the PyInstaller launcher)."""

import logging
import os
import socket
import sys
import threading
import webbrowser

from app import config, db
from app.server import create_app

logger = logging.getLogger(__name__)


def _port_in_use(port: int) -> bool:
    """Return True if something is already listening on 127.0.0.1:port.

    Werkzeug sets SO_REUSEADDR, which on Windows allows binding over a live
    listener instead of failing, so app.run() alone can't be trusted to catch this.
    """
    try:
        probe = socket.create_connection(("127.0.0.1", port), timeout=0.5)
    except OSError:
        return False
    probe.close()
    return True


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )

    if _port_in_use(config.PORT):
        logger.error(
            "Port %s is already in use — another CoopJobs instance or a leftover "
            "chromedriver.exe may be holding it. Close it or set COOPJOBS_PORT.",
            config.PORT,
        )
        sys.exit(1)

    conn = db.connect(config.DB_PATH)
    try:
        db.init_db(conn)
    finally:
        conn.close()

    app = create_app(config.DB_PATH)

    if os.getenv("COOPJOBS_NO_BROWSER") != "1":
        url = f"http://127.0.0.1:{config.PORT}/"
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()

    logger.info("Starting server on http://127.0.0.1:%s", config.PORT)
    try:
        app.run(host="127.0.0.1", port=config.PORT, threaded=True)
    except KeyboardInterrupt:
        logger.info("Shutting down.")
    finally:
        app.extensions["runner"].cancel()


if __name__ == "__main__":
    main()
