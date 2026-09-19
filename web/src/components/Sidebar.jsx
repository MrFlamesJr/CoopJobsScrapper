import FacetGroup from "./FacetGroup.jsx";
import StatusChip from "./StatusChip.jsx";
import { EXPORT_JSON_URL } from "../api.js";
import { FACET_FIELDS } from "../facetFields.js";
import "./Sidebar.css";

const SORT_OPTIONS = [
  { value: "deadline", label: "Deadline" },
  { value: "title", label: "Title" },
  { value: "employer", label: "Employer" },
  { value: "newest", label: "Newest" },
];

export default function Sidebar({
  q,
  onQChange,
  sort,
  onSortChange,
  deadlineMode,
  onDeadlineModeChange,
  facets,
  selectedFilters,
  onFacetToggle,
  activeFilterCount,
  onClearFilters,
  status,
  onOpenScraper,
  isOpen,
  onCloseMobile,
}) {
  return (
    <>
      {isOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <aside className={`sidebar ${isOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__scroll">
          <div className="sidebar__brand">Co-op Jobs</div>

          <input
            type="search"
            className="sidebar__search"
            placeholder="Search jobs…"
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            aria-label="Search jobs"
          />

          <label className="sidebar__field">
            <span className="sidebar__field-label">Sort by</span>
            <select value={sort} onChange={(e) => onSortChange(e.target.value)}>
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <div className="sidebar__toggles">
            <label className="sidebar__toggle">
              <input
                type="checkbox"
                checked={deadlineMode === "open"}
                onChange={(e) => onDeadlineModeChange(e.target.checked ? "open" : "all")}
              />
              <span>Hide closed</span>
            </label>
            <label className="sidebar__toggle">
              <input
                type="checkbox"
                checked={deadlineMode === "week"}
                onChange={(e) => onDeadlineModeChange(e.target.checked ? "week" : "all")}
              />
              <span>Closing this week</span>
            </label>
          </div>

          <div className="sidebar__filters-header">
            <span>
              Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
            </span>
            {activeFilterCount > 0 && (
              <button type="button" className="sidebar__clear" onClick={onClearFilters}>
                Clear filters
              </button>
            )}
          </div>

          {FACET_FIELDS.map(({ field, label }) => (
            <FacetGroup
              key={field}
              field={field}
              label={label}
              options={facets[field] || []}
              selected={selectedFilters[field] || []}
              onToggle={onFacetToggle}
            />
          ))}
        </div>

        <div className="sidebar__footer">
          <StatusChip status={status} onClick={onOpenScraper} />
          <a className="sidebar__export" href={EXPORT_JSON_URL}>
            Export JSON
          </a>
        </div>
      </aside>
    </>
  );
}
