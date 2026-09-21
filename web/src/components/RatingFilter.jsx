import { ThumbUpIcon, ThumbDownIcon } from "./RatingButtons.jsx";
import "./RatingFilter.css";

// Middle segment on purpose: "All" is the neutral default between the two
// rating-based filters, not just another option in the list.
const SEGMENTS = [
  { value: "liked", label: "Liked", title: "Only liked jobs", Icon: ThumbUpIcon },
  { value: "all", label: "All", title: "Show all jobs", Icon: null },
  { value: "hide_disliked", label: "Hidden", title: "Hide disliked jobs", Icon: ThumbDownIcon },
];

/**
 * A 3-way segmented pill for filtering by rating: liked-only, everything, or
 * disliked jobs hidden. Sits right under the sort stack, above "Hide closed".
 */
export default function RatingFilter({ value, onChange }) {
  return (
    <div className="rating-filter" role="group" aria-label="Rating filter">
      {SEGMENTS.map(({ value: segValue, label, title, Icon }) => {
        const active = value === segValue;
        return (
          <button
            key={segValue}
            type="button"
            className={`rating-filter__segment ${active ? "rating-filter__segment--active" : ""}`}
            aria-pressed={active}
            title={title}
            aria-label={title}
            onClick={() => onChange(segValue)}
          >
            {Icon && <Icon />}
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
