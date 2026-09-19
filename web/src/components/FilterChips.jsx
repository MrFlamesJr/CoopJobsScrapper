import { FACET_FIELD_LABELS as FIELD_LABELS } from "../facetFields.js";
import "./FilterChips.css";

export default function FilterChips({ filters, onRemove, onClearAll }) {
  const chips = [];
  Object.entries(filters).forEach(([field, values]) => {
    (values || []).forEach((value) => {
      chips.push({ field, value });
    });
  });

  if (chips.length === 0) return null;

  return (
    <div className="filter-chips">
      {chips.map(({ field, value }) => (
        <button
          key={`${field}:${value}`}
          type="button"
          className="filter-chip"
          onClick={() => onRemove(field, value)}
          title={`Remove ${FIELD_LABELS[field] || field}: ${value}`}
        >
          <span className="filter-chip__field">{FIELD_LABELS[field] || field}:</span>
          <span>{value}</span>
          <span className="filter-chip__x" aria-hidden="true">
            ×
          </span>
        </button>
      ))}
      {chips.length > 1 && (
        <button type="button" className="filter-chip filter-chip--clear" onClick={onClearAll}>
          Clear all
        </button>
      )}
    </div>
  );
}
