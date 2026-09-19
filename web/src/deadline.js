// Pure helpers for turning a job's deadline into a short human label + a
// "tone" used to color the deadline chip. No dependencies, no Date parsing
// that could shift across timezones.

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
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

// Short form, for the chip label (the tooltip keeps the full month via MONTHS).
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Parses an ISO "YYYY-MM-DD" string as a LOCAL calendar date (midnight local
// time), avoiding the UTC shift that `new Date("YYYY-MM-DD")` performs.
function parseLocalIsoDate(iso) {
  if (!iso || typeof iso !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(from, to) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function monthDayLabel(date, today) {
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() !== today.getFullYear()
    ? `${base}, ${date.getFullYear()}`
    : base;
}

// Short month + day, e.g. "Sep 30"; year appended only when it differs from
// today's (chip label — the tooltip's exactDeadline() spells the month out).
function shortMonthDayLabel(date, today) {
  const base = `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() !== today.getFullYear()
    ? `${base}, ${date.getFullYear()}`
    : base;
}

/**
 * @param {string|null|undefined} deadline_date ISO "YYYY-MM-DD" or falsy
 * @param {string|null|undefined} deadline_text raw text from the portal
 * @param {Date} today defaults to `new Date()`, injectable for tests
 * @returns {{label: string, tone: "closed"|"today"|"tomorrow"|"week"|"open"|"unknown"}}
 */
export function deadlineInfo(deadline_date, deadline_text, today = new Date()) {
  const date = parseLocalIsoDate(deadline_date);

  if (!date) {
    const text = (deadline_text || "").trim();
    return { label: text || "No deadline", tone: "unknown" };
  }

  const todayMidnight = startOfDay(today);
  const diff = daysBetween(todayMidnight, date);

  // Labels only: no "Closing"/"Closed" verb (DeadlineChip adds that back for
  // its aria-label from the tone). Tones below are unchanged from before.
  if (diff < 0) {
    if (diff === -1) return { label: "Yesterday", tone: "closed" };
    if (diff >= -3) return { label: `${-diff} days ago`, tone: "closed" };
    return { label: shortMonthDayLabel(date, todayMidnight), tone: "closed" };
  }

  if (diff === 0) return { label: "Today", tone: "today" };
  if (diff === 1) return { label: "Tomorrow", tone: "tomorrow" };
  if (diff <= 3) return { label: `In ${diff} days`, tone: "week" };
  if (diff <= 7) return { label: shortMonthDayLabel(date, todayMidnight), tone: "week" };
  return { label: shortMonthDayLabel(date, todayMidnight), tone: "open" };
}

// The portal's text carries more than the date when it mentions a time.
const HAS_TIME = /\d{1,2}\s*:\s*\d{2}|\b\d{1,2}\s*[ap]\.?\s?m\.?\b/i;

/**
 * The full deadline, for the chip's tooltip: e.g. "Friday, December 21, 2026".
 * When the raw portal text adds something the date doesn't carry (a time), it
 * is appended. With no parsable date, the raw text is all we have.
 *
 * @param {string|null|undefined} deadline_date ISO "YYYY-MM-DD" or falsy
 * @param {string|null|undefined} deadline_text raw text from the portal
 * @returns {string} "" when nothing is known
 */
export function exactDeadline(deadline_date, deadline_text) {
  const text = (deadline_text || "").trim();
  const date = parseLocalIsoDate(deadline_date);
  if (!date) return text;

  const full = `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  return HAS_TIME.test(text) ? `${full} · ${text}` : full;
}
