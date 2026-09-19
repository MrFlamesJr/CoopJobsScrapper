"""Liberal parsing of the portal's free-text deadline strings into dates."""

import logging
import re
from datetime import date, datetime

logger = logging.getLogger(__name__)

_LEADING_LABEL_RE = re.compile(r"(?i)^\s*(application\s+)?deadline\s*:?\s*")
_TIMEZONE_RE = re.compile(r"(?i)\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT|ET)\b\.?\s*$")
_TRAILING_TIME_RE = re.compile(
    r"(?i)\s*(at\s+)?\d{1,2}(:\d{2})?\s*(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*$"
)
_ORDINAL_RE = re.compile(r"(?i)\b(\d{1,2})(st|nd|rd|th)\b")
_SEPT_RE = re.compile(r"(?i)\bsept\b\.?")

_FORMATS = (
    "%Y-%m-%d",
    "%b %d, %Y",
    "%B %d, %Y",
    "%d %b %Y",
    "%d %B %Y",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%A, %B %d, %Y",
    "%a, %b %d, %Y",
    "%b %d %Y",
)


def _clean(text: str) -> str:
    cleaned = _LEADING_LABEL_RE.sub("", text.strip())
    cleaned = _TIMEZONE_RE.sub("", cleaned).strip()
    # Trailing time is only stripped when it looks like "HH:MM[:SS] [am/pm]",
    # not a bare trailing number that could be part of the date itself.
    if re.search(r"(?i)\d{1,2}:\d{2}|a\.?m\.?\s*$|p\.?m\.?\s*$", cleaned):
        cleaned = _TRAILING_TIME_RE.sub("", cleaned).strip()
    cleaned = cleaned.rstrip(",").strip()
    cleaned = _SEPT_RE.sub("Sep", cleaned)
    return cleaned


def parse_deadline(text: str | None) -> date | None:
    """Best-effort parse of a portal deadline string; never raises."""
    if not text:
        return None
    try:
        cleaned = _clean(text)
        if not cleaned:
            return None

        candidates = [cleaned]
        no_ordinals = _ORDINAL_RE.sub(r"\1", cleaned)
        if no_ordinals != cleaned:
            candidates.append(no_ordinals)

        for candidate in candidates:
            for fmt in _FORMATS:
                try:
                    return datetime.strptime(candidate, fmt).date()
                except ValueError:
                    continue
            try:
                return date.fromisoformat(candidate)
            except ValueError:
                continue
    except Exception:  # pragma: no cover - defensive, parser must never raise
        logger.debug("Failed to parse deadline text %r", text, exc_info=True)

    return None
