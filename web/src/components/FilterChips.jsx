import { useLayoutEffect, useRef } from "react";
import { FACET_FIELD_LABELS as FIELD_LABELS } from "../facetFields.js";
import { useScrollDirection } from "../hooks/useScrollDirection.js";
import "./FilterChips.css";

// Two strokes through the exact centre of the viewBox, so the cross shares
// its badge's centre and the hover scale grows it evenly — same trick as
// FacetGroup's chevron.
function CrossIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 5l6 6M11 5l-6 6" />
    </svg>
  );
}

/**
 * The active-filter chip row, sitting under the top bar. In order: a
 * `Search: <q>` chip (App owns `q` directly, not `filters`), a `Hide closed`
 * chip, a rating-filter chip (`Liked only` / `Disliked hidden`), then one
 * chip per selected facet value, then "Clear all" once there's more than
 * one.
 *
 * The bar hides only while the page is scrolling down, comes back on the
 * first small scroll up, and is always visible within the top 80px of the
 * page. It publishes its own height as `--chips-offset` on `:root`, so
 * sticky content further down (the details rail) can sit right under it.
 */
export default function FilterChips({
  filters,
  onRemove,
  onClearAll,
  q,
  onClearSearch,
  hideClosed,
  onShowClosed,
  ratingFilter,
  onClearRatingFilter,
}) {
  const chips = [];
  const search = (q || "").trim();
  if (search) chips.push({ key: "__search", label: `Search: ${search}`, onClick: onClearSearch });
  if (hideClosed) chips.push({ key: "__hide-closed", label: "Hide closed", onClick: onShowClosed });
  if (ratingFilter === "liked") {
    chips.push({ key: "__rating", label: "Liked only", onClick: onClearRatingFilter });
  } else if (ratingFilter === "hide_disliked") {
    chips.push({ key: "__rating", label: "Disliked hidden", onClick: onClearRatingFilter });
  }
  Object.entries(filters).forEach(([field, values]) => {
    (values || []).forEach((value) => {
      chips.push({ key: `${field}:${value}`, field, value, onClick: () => onRemove(field, value) });
    });
  });
  const hasChips = chips.length > 0;

  const direction = useScrollDirection({ showAfter: 6, hideAfter: 24, topOffset: 80 });
  const barRef = useRef(null);

  const hidden = hasChips && direction === "down";

  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = barRef.current;
    if (!hasChips || !el || hidden) {
      root.style.setProperty("--chips-offset", "0px");
      return undefined;
    }
    const update = () => root.style.setProperty("--chips-offset", `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.setProperty("--chips-offset", "0px");
    };
  }, [hasChips, hidden]);

  return (
    hasChips && (
      <div
        ref={barRef}
        className={`filter-chips-bar ${hidden ? "filter-chips-bar--hidden" : ""}`}
        inert={hidden ? "" : undefined}
      >
        <div className="filter-chips">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="filter-chip"
              onClick={chip.onClick}
              title={
                chip.field
                  ? `Remove ${FIELD_LABELS[chip.field] || chip.field}: ${chip.value}`
                  : `Remove ${chip.label}`
              }
            >
              {chip.field ? (
                <>
                  <span className="filter-chip__field">{FIELD_LABELS[chip.field] || chip.field}:</span>
                  <span>{chip.value}</span>
                </>
              ) : (
                <span>{chip.label}</span>
              )}
              <span className="filter-chip__x" aria-hidden="true">
                <CrossIcon />
              </span>
            </button>
          ))}
          {chips.length > 1 && (
            <button
              type="button"
              className="filter-chip filter-chip--clear"
              onClick={() => {
                onClearAll();
                onClearSearch();
                onShowClosed();
                onClearRatingFilter();
              }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>
    )
  );
}
