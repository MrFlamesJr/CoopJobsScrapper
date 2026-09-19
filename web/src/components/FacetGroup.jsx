import { useMemo, useState } from "react";
import "./FacetGroup.css";

const VISIBLE_LIMIT = 8;

export default function FacetGroup({ label, field, options, selected, onToggle }) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  const isLong = options.length > VISIBLE_LIMIT;

  const filtered = useMemo(() => {
    if (!isLong || !filter.trim()) return options;
    const needle = filter.trim().toLowerCase();
    // A checked value stays in the list even if the mini-filter would otherwise hide it,
    // so the user can always see (and untick) what's actually selected.
    return options.filter((o) => o.value.toLowerCase().includes(needle) || selected.includes(o.value));
  }, [options, filter, isLong, selected]);

  const visible = useMemo(() => {
    if (!isLong || showAll) return filtered;
    const topSlice = filtered.slice(0, VISIBLE_LIMIT);
    // Likewise, a checked value beyond the "show more" cutoff is appended so it
    // never silently disappears from view while still being an active filter.
    const hiddenChecked = filtered
      .slice(VISIBLE_LIMIT)
      .filter((o) => selected.includes(o.value));
    return hiddenChecked.length > 0 ? [...topSlice, ...hiddenChecked] : topSlice;
  }, [filtered, isLong, showAll, selected]);

  const hiddenCount = filtered.length - visible.length;

  if (options.length === 0) return null;

  return (
    <div className="facet-group">
      <button
        type="button"
        className="facet-group__header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <span className="facet-group__caret" data-open={open} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="facet-group__body">
          {isLong && (
            <input
              type="text"
              className="facet-group__filter"
              placeholder={`Filter ${label.toLowerCase()}…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label={`Filter ${label}`}
            />
          )}

          <ul className="facet-group__list">
            {visible.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <li key={opt.value}>
                  <label className="facet-group__item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(field, opt.value)}
                    />
                    <span className="facet-group__item-label">{opt.value}</span>
                    <span className="facet-group__item-count">{opt.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>

          {isLong && hiddenCount > 0 && (
            <button
              type="button"
              className="facet-group__more"
              onClick={() => setShowAll(true)}
            >
              Show {hiddenCount} more
            </button>
          )}
          {isLong && showAll && filtered.length > VISIBLE_LIMIT && (
            <button
              type="button"
              className="facet-group__more"
              onClick={() => setShowAll(false)}
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}
