import { useEffect, useRef } from "react";
import FacetGroup from "./FacetGroup.jsx";
import StatusChip from "./StatusChip.jsx";
import SortStack from "./SortStack.jsx";
import RatingFilter from "./RatingFilter.jsx";
import InfoDot from "./InfoDot.jsx";
import { FACET_FIELDS } from "../facetFields.js";
import "./Sidebar.css";

// Small stroke highlighter/marker pen: a pen barrel touching down on the mark
// it left. currentColor, so the button's own color drives it.
function HighlighterIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 11 3 17v3h9l3-3" />
      <path d="M22 12 17.4 16.6a2 2 0 0 1-2.8 0L9.4 11.4a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  );
}

const WIDTH_KEY = "sidebarWidth";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = DEFAULT_WIDTH;

// Never wider than half the window, so the grid keeps room on small screens.
function clampWidth(px) {
  const max = Math.min(560, window.innerWidth / 2);
  return Math.round(Math.max(MIN_WIDTH, Math.min(px, max)));
}

// Both .sidebar and .app-main read --sidebar-width, so setting it on <html>
// is all the layout needs to reflow.
function applyWidth(px) {
  document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
}

function saveWidth(px) {
  try {
    localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
    // Storage can be unavailable (private mode); the width just won't persist.
  }
}

export default function Sidebar({
  q,
  onQChange,
  sorts,
  onSortsChange,
  ratingFilter,
  onRatingFilterChange,
  deadlineMode,
  onDeadlineModeChange,
  facets,
  selectedFilters,
  onFacetToggle,
  activeFilterCount,
  onClearFilters,
  status,
  onOpenScraper,
  statusChipRef,
  isOpen,
  onCloseMobile,
  highlightOn,
  onToggleHighlight,
  onOpenAbout,
}) {
  const draggingRef = useRef(false);

  // Restore the saved width once on mount.
  useEffect(() => {
    let saved = null;
    try {
      saved = localStorage.getItem(WIDTH_KEY);
    } catch {
      // Storage can be unavailable; fall back to the default width.
    }
    const px = Number(saved);
    if (px > 0) {
      const clamped = clampWidth(px);
      applyWidth(clamped);
      // If the saved value was below the new minimum, re-save the clamped value
      // so it doesn't sit stale in storage.
      if (clamped !== px) {
        saveWidth(clamped);
      }
    }
  }, []);

  function handleResizeStart(e) {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  }

  function handleResizeMove(e) {
    if (!draggingRef.current) return;
    applyWidth(clampWidth(e.clientX));
  }

  function handleResizeEnd(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    saveWidth(clampWidth(e.clientX));
  }

  function handleResizeReset() {
    applyWidth(DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  }

  return (
    <>
      {isOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <aside className={`sidebar ${isOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__scroll">
          <div className="sidebar__brand-row">
            <span className="sidebar__brand">Co-op Jobs</span>
            <InfoDot
              className="sidebar__info"
              label="About"
              tip="About the web app"
              onClick={() => onOpenAbout?.()}
            />
          </div>

          <div className="sidebar__search-row">
            <input
              type="search"
              className="sidebar__search"
              placeholder="Search jobs…"
              value={q}
              onChange={(e) => onQChange(e.target.value)}
              aria-label="Search jobs"
            />
            <button
              type="button"
              className="sidebar__highlight"
              onClick={() => onToggleHighlight?.()}
              aria-pressed={Boolean(highlightOn)}
              title="Highlight matches"
            >
              <HighlighterIcon />
            </button>
          </div>

          <div className="sidebar__block">
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span className="sidebar__field-label">Sort by</span>
              <InfoDot
                className="sidebar__info"
                label="Sort by"
                tip="Add sorts and drag to reorder."
              />
            </div>
            <SortStack sorts={sorts} onChange={onSortsChange} />
          </div>

          <div className="sidebar__block">
            <span className="sidebar__field-label">Ratings</span>
            <RatingFilter value={ratingFilter} onChange={onRatingFilterChange} />
          </div>

          <label
            className="sidebar__toggle"
            title="Hide jobs whose application deadline has passed"
          >
            <input
              type="checkbox"
              checked={deadlineMode === "open"}
              onChange={(e) => onDeadlineModeChange(e.target.checked ? "open" : "all")}
            />
            <span>Hide closed</span>
          </label>

          <section className="sidebar__filters">
            <div className="sidebar__filters-header">
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="sidebar__filters-count">{activeFilterCount}</span>
              )}
              {activeFilterCount > 0 && (
                <button type="button" className="sidebar__clear" onClick={onClearFilters}>
                  Clear
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
          </section>
        </div>

        <div className="sidebar__footer">
          <StatusChip status={status} onClick={onOpenScraper} chipRef={statusChipRef} />
        </div>

        <div
          className="sidebar__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize · double-click to reset"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={handleResizeReset}
        />
      </aside>
    </>
  );
}
