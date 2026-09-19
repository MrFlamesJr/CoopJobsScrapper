import { useEffect, useRef, useState } from "react";
import DeadlineChip from "./DeadlineChip.jsx";
import JobDetails from "./JobDetails.jsx";
import FavoriteButton, { HeartIcon } from "./FavoriteButton.jsx";
import "./FavoritesDrawer.css";

const WIDTH_KEY = "favoritesWidth";
const DEFAULT_WIDTH = 440;
// The width it has always had: the drag only makes it wider.
const MIN_WIDTH = 440;

// Never so wide that nothing of the page is left beside it.
function clampWidth(px) {
  const max = Math.min(900, window.innerWidth - 48);
  return Math.round(Math.max(MIN_WIDTH, Math.min(px, max)));
}

function applyWidth(el, px) {
  el?.style.setProperty("--favorites-width", `${px}px`);
}

function saveWidth(px) {
  try {
    localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
    // Storage can be unavailable (private mode); the width just won't persist.
  }
}

/**
 * The slide-over drawer listing every saved favorite, newest first. Its inner
 * edge is a drag handle for the drawer's width, saved across sessions.
 */
export default function FavoritesDrawer({ open, favorites = [], onClose, onToggle }) {
  // The drawer tracks its own expanded rows, by job number.
  const [expanded, setExpanded] = useState([]);
  const panelRef = useRef(null);
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
    if (px > 0) applyWidth(panelRef.current, clampWidth(px));
  }, []);

  // Right-anchored, so the width is the distance from the pointer to the
  // window's right edge.
  function handleResizeStart(e) {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  }

  function handleResizeMove(e) {
    if (!draggingRef.current) return;
    applyWidth(panelRef.current, clampWidth(window.innerWidth - e.clientX));
  }

  function handleResizeEnd(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    saveWidth(clampWidth(window.innerWidth - e.clientX));
  }

  function handleResizeReset() {
    applyWidth(panelRef.current, DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  }

  // Escape closes the drawer, and focus moves into it when it opens.
  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const toggleExpanded = (jobNumber) => {
    setExpanded((current) =>
      current.includes(jobNumber)
        ? current.filter((n) => n !== jobNumber)
        : [...current, jobNumber],
    );
  };

  const renderRow = (fav) => {
    const job = fav.job;
    const isOpen = expanded.includes(fav.job_number);

    const handleClick = () => {
      if (!job) return;
      toggleExpanded(fav.job_number);
    };

    return (
      <li
        key={fav.job_number}
        className={`favorites-drawer__item ${job ? "" : "favorites-drawer__item--orphan"}`}
      >
        <div className="favorites-drawer__row" onClick={handleClick}>
          {/* A real button for the keyboard; the whole row is clickable too,
              which is why this one stops the click from running twice. */}
          {job ? (
            <button
              type="button"
              className="favorites-drawer__text"
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                handleClick();
              }}
            >
              <span className="favorites-drawer__title">{fav.title || "Untitled position"}</span>
              <span className="favorites-drawer__employer">
                {fav.employer || "Unknown employer"}
              </span>
            </button>
          ) : (
            <span className="favorites-drawer__text">
              <span className="favorites-drawer__title">{fav.title || "Untitled position"}</span>
              <span className="favorites-drawer__employer">
                {fav.employer || "Unknown employer"}
              </span>
            </span>
          )}
          {job ? (
            <DeadlineChip deadline_date={job.deadline_date} deadline_text={job.deadline_text} />
          ) : (
            <span className="favorites-drawer__gone">No longer listed</span>
          )}
          <FavoriteButton jobNumber={fav.job_number} saved onToggle={() => onToggle(fav)} />
        </div>

        {job && isOpen && (
          <JobDetails jobId={job.id} onClose={() => toggleExpanded(fav.job_number)} />
        )}
      </li>
    );
  };

  return (
    <>
      {open && (
        <div className="favorites-drawer__backdrop" onClick={onClose} aria-hidden="true" />
      )}

      <aside
        className={`favorites-drawer ${open ? "favorites-drawer--open" : ""}`}
        aria-label="Favorites"
        aria-hidden={!open}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="favorites-drawer__header">
          <h2 className="favorites-drawer__heading">
            <HeartIcon className="favorites-drawer__heading-heart" />
            Favorites
            <span className="favorites-drawer__count">{favorites.length}</span>
          </h2>
          <button
            type="button"
            className="favorites-drawer__close"
            onClick={onClose}
            aria-label="Close favorites"
          >
            ×
          </button>
        </header>

        <div className="favorites-drawer__body">
          {favorites.length === 0 ? (
            <p className="favorites-drawer__empty">Click the ♡ on any job to save it here.</p>
          ) : (
            <ul className="favorites-drawer__list">{favorites.map(renderRow)}</ul>
          )}
        </div>

        <div
          className="favorites-drawer__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize favorites"
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
