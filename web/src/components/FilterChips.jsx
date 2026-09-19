import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * chip, then one chip per selected facet value, then "Clear all" once
 * there's more than one.
 *
 * The bar hides itself on scroll-down once it's actually stuck to the top
 * (a zero-height sentinel just above it flags that with an
 * IntersectionObserver), so nothing slides at the top of the page, and it
 * reappears on the smallest scroll-up. It also publishes its own height as
 * `--chips-offset` on `:root`, so sticky content further down (the details
 * rail) can sit right under it.
 */
export default function FilterChips({
  filters,
  onRemove,
  onClearAll,
  q,
  onClearSearch,
  hideClosed,
  onShowClosed,
}) {
  const chips = [];
  const search = (q || "").trim();
  if (search) chips.push({ key: "__search", label: `Search: ${search}`, onClick: onClearSearch });
  if (hideClosed) chips.push({ key: "__hide-closed", label: "Hide closed", onClick: onShowClosed });
  Object.entries(filters).forEach(([field, values]) => {
    (values || []).forEach((value) => {
      chips.push({ key: `${field}:${value}`, field, value, onClick: () => onRemove(field, value) });
    });
  });
  const hasChips = chips.length > 0;

  const direction = useScrollDirection({ showAfter: 6, hideAfter: 12 });
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef(null);
  const barRef = useRef(null);

  // The 800px breakpoint changes --app-topbar-h / --topbar-h (and so the
  // bar's sticky offset), so the observer below needs rebuilding when it's
  // crossed — a state bump is the simplest way to make that an effect dep.
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 800px)");
    const onChange = (e) => setIsNarrow(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!hasChips) {
      setStuck(false);
      return undefined;
    }
    const sentinel = sentinelRef.current;
    const bar = barRef.current;
    if (!sentinel || !bar) return undefined;
    // The bar sticks at `top: <offset>`, so the sentinel is already fully
    // covered by it well before the sentinel itself reaches the viewport's
    // top edge. Shrinking the observer's root by that offset makes `stuck`
    // flip exactly when the bar starts sticking, not later.
    const offset = parseFloat(getComputedStyle(bar).top) || 0;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      rootMargin: `-${Math.ceil(offset)}px 0px 0px 0px`,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasChips, isNarrow]);

  const hidden = hasChips && stuck && direction === "down";

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
    <>
      <div ref={sentinelRef} className="filter-chips-bar__sentinel" aria-hidden="true" />
      {hasChips && (
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
                }}
              >
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
