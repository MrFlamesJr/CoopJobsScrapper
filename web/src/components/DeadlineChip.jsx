import { deadlineInfo } from "../deadline.js";
import "./DeadlineChip.css";

export default function DeadlineChip({ deadline_date, deadline_text }) {
  const { label, tone } = deadlineInfo(deadline_date, deadline_text);
  return <span className={`deadline-chip deadline-chip--${tone}`}>{label}</span>;
}
