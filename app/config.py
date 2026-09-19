"""Runtime configuration: constants with environment-variable overrides."""

import os
import sys
from pathlib import Path

SEARCH_URL = os.getenv(
    "COOPJOBS_SEARCH_URL", "https://experiential-learning.uottawa.ca/search"
)
PORT = int(os.getenv("COOPJOBS_PORT", "8000"))
DEBUG_SNAPSHOTS = os.getenv("COOPJOBS_DEBUG") == "1"

FROZEN = getattr(sys, "frozen", False)  # True when bundled by PyInstaller

# Where bundled resources (app/schema.sql, web/dist) live.
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", "")) if FROZEN else Path(__file__).resolve().parent.parent

_default_data_dir = (
    Path(os.environ["LOCALAPPDATA"]) / "CoopJobs" if FROZEN else RESOURCE_DIR / "data"
)
DATA_DIR = Path(os.getenv("COOPJOBS_DATA_DIR") or _default_data_dir)

DB_PATH = DATA_DIR / "jobs.db"
BROWSER_PROFILE_DIR = DATA_DIR / "browser-profile"
DEBUG_DIR = DATA_DIR / "debug"
WEB_DIST_DIR = RESOURCE_DIR / "web" / "dist"
