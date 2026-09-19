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

  if (diff < 0) {
    if (diff === -1) return { label: "Closed yesterday", tone: "closed" };
    return { label: `Closed ${monthDayLabel(date, todayMidnight)}`, tone: "closed" };
  }

  if (diff === 0) return { label: "Closing today", tone: "today" };
  if (diff === 1) return { label: "Closing tomorrow", tone: "tomorrow" };
  if (diff <= 6) return { label: `Closing ${WEEKDAYS[date.getDay()]}`, tone: "week" };
  if (diff === 7) return { label: `Closing ${monthDayLabel(date, todayMidnight)}`, tone: "week" };
  return { label: `Closing ${monthDayLabel(date, todayMidnight)}`, tone: "open" };
}
