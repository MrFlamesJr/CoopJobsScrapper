import { deadlineInfo, exactDeadline } from "../deadline.js";
import "./DeadlineChip.css";

export default function DeadlineChip({ deadline_date, deadline_text }) {
  const { label, tone } = deadlineInfo(deadline_date, deadline_text);
  // The short label hides the exact date, so hovering shows it in a bubble.
  const exact = exactDeadline(deadline_date, deadline_text);
  // The label itself dropped its "Closing"/"Closed" verb; restore it for
  // screen readers. "unknown" has no known deadline to describe that way.
  const prefix = tone === "unknown" ? "" : tone === "closed" ? "Closed" : "Closes";
  // Relative labels ("Today", "In 2 days", "3 days ago", …) read as a
  // sentence once the verb is back, so lower-case their first letter; date
  // labels ("Sep 30") keep their capital month.
  const isDateLabel = /^[A-Z][a-z]{2} \d/.test(label);
  const spokenLabel = prefix && !isDateLabel ? label[0].toLowerCase() + label.slice(1) : label;
  const spoken = prefix ? `${prefix} ${spokenLabel}` : spokenLabel;

  return (
    <span
      className={`deadline-chip deadline-chip--${tone}`}
      title={exact || undefined}
      aria-label={exact ? `${spoken}, ${exact}` : undefined}
    >
      {label}
    </span>
  );
}
