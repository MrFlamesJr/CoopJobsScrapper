// Liberal parsing of the portal's free-text deadline strings into dates.
// Exact JS port of app/deadlines.py (parse_deadline). Never throws; returns a
// "YYYY-MM-DD" string or null.

const LEADING_LABEL_RE = /^\s*(application\s+)?deadline\s*:?\s*/i;
const TIMEZONE_RE = /\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT|ET)\b\.?\s*$/i;
const TRAILING_TIME_RE = /\s*(at\s+)?\d{1,2}(:\d{2})?(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i;
const TRAILING_TIME_HINT_RE = /\d{1,2}:\d{2}|a\.?m\.?\s*$|p\.?m\.?\s*$/i;
const ORDINAL_RE = /\b(\d{1,2})(st|nd|rd|th)\b/gi;
const SEPT_RE = /\bsept\b\.?/gi;
const TRAILING_COMMAS_RE = /,+$/;

const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Same ordered format list as app/deadlines.py's _FORMATS, expressed with the
// same strptime-style directives, hand-implemented below.
const FORMATS = [
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
];

// Directive -> regex fragment with a named capture group, mirroring the
// leniency of cpython's _strptime (%d/%m accept unpadded single digits).
const DIRECTIVES = {
  d: "(?<d>3[01]|[12]\\d|0[1-9]|[1-9])",
  m: "(?<m>1[0-2]|0[1-9]|[1-9])",
  Y: "(?<Y>\\d\\d\\d\\d)",
  b: `(?<b>${MONTHS_ABBR.join("|")})`,
  B: `(?<B>${MONTHS_FULL.join("|")})`,
  a: `(?<a>${WEEKDAYS_ABBR.join("|")})`,
  A: `(?<A>${WEEKDAYS_FULL.join("|")})`,
};

function escapeRegExpChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile one strptime-style format string into a case-insensitive, fully
 * anchored regex, the same way cpython's TimeRE builds a pattern: literal
 * whitespace becomes `\s+` (lenient about run length), other literals are
 * escaped, and %x directives become named groups. */
function compileFormat(fmt) {
  let pattern = "^";
  for (let i = 0; i < fmt.length; i += 1) {
    const ch = fmt[i];
    if (ch === "%" && i + 1 < fmt.length) {
      const directive = fmt[i + 1];
      const fragment = DIRECTIVES[directive];
      if (!fragment) throw new Error(`Unsupported strptime directive: %${directive}`);
      pattern += fragment;
      i += 1;
    } else if (/\s/.test(ch)) {
      pattern += "\\s+";
    } else {
      pattern += escapeRegExpChar(ch);
    }
  }
  pattern += "$";
  return new RegExp(pattern, "i");
}

const COMPILED_FORMATS = new Map(FORMATS.map((fmt) => [fmt, compileFormat(fmt)]));

function indexOfCaseInsensitive(list, value) {
  const lower = value.toLowerCase();
  return list.findIndex((item) => item.toLowerCase() === lower);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Whether (year, month, day) is a real calendar date (rejects e.g. Feb 30). */
function isValidCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** Try to parse `candidate` against one strptime-style format string. Returns
 * a "YYYY-MM-DD" string, or null if the candidate doesn't match the format or
 * doesn't form a real calendar date (mirrors datetime.strptime raising
 * ValueError in either case). */
function tryFormat(candidate, fmt) {
  const regex = COMPILED_FORMATS.get(fmt);
  const match = regex.exec(candidate);
  if (!match) return null;
  const g = match.groups || {};

  let year = null;
  let month = null;
  let day = null;
  if (g.Y !== undefined) year = parseInt(g.Y, 10);
  if (g.d !== undefined) day = parseInt(g.d, 10);
  if (g.m !== undefined) month = parseInt(g.m, 10);
  if (g.b !== undefined) month = indexOfCaseInsensitive(MONTHS_ABBR, g.b) + 1;
  if (g.B !== undefined) month = indexOfCaseInsensitive(MONTHS_FULL, g.B) + 1;
  // %a / %A (weekday name) are consumed but never contribute to the date
  // value, exactly like cpython's strptime.

  if (year === null || month === null || day === null) return null;
  if (!isValidCalendarDate(year, month, day)) return null;
  return isoDate(year, month, day);
}

/** Minimal stand-in for Python's date.fromisoformat fallback: strict
 * "YYYY-MM-DD". (Python 3.11+ accepts a broader ISO 8601 surface here, but
 * that extra leniency is never exercised by any recognized deadline text and
 * is not ported.) */
function tryIsoFormat(candidate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (!isValidCalendarDate(year, month, day)) return null;
  return isoDate(year, month, day);
}

function clean(text) {
  let cleaned = text.trim().replace(LEADING_LABEL_RE, "");
  cleaned = cleaned.replace(TIMEZONE_RE, "").trim();
  // Trailing time is only stripped when it looks like "HH:MM[:SS] [am/pm]",
  // not a bare trailing number that could be part of the date itself.
  if (TRAILING_TIME_HINT_RE.test(cleaned)) {
    cleaned = cleaned.replace(TRAILING_TIME_RE, "").trim();
  }
  cleaned = cleaned.replace(TRAILING_COMMAS_RE, "").trim();
  cleaned = cleaned.replace(SEPT_RE, "Sep");
  return cleaned;
}

/** Best-effort parse of a portal deadline string; never throws. Returns a
 * "YYYY-MM-DD" string or null. */
export function parseDeadline(text) {
  if (!text) return null;
  try {
    const cleaned = clean(text);
    if (!cleaned) return null;

    const candidates = [cleaned];
    const noOrdinals = cleaned.replace(ORDINAL_RE, "$1");
    if (noOrdinals !== cleaned) candidates.push(noOrdinals);

    for (const candidate of candidates) {
      for (const fmt of FORMATS) {
        const result = tryFormat(candidate, fmt);
        if (result) return result;
      }
      const iso = tryIsoFormat(candidate);
      if (iso) return iso;
    }
  } catch {
    // Defensive, like the Python parser's `except Exception`: never raise.
  }
  return null;
}
