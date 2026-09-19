import { useState } from "react";
import "./FavoriteButton.css";

// Inline so CSS can fill and outline it. Shared with the drawer's edge tab.
export function HeartIcon({ className = "" }) {
  return (
    <svg className={`heart-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21 3.9 12.9a5 5 0 0 1 7.1-7.1l1 1 1-1a5 5 0 0 1 7.1 7.1Z" />
    </svg>
  );
}

/**
 * The heart. It is right-aligned, so its label grows leftward out of the icon
 * on hover; the meta text next to it shrinks with its own ellipsis.
 */
export default function FavoriteButton({ jobNumber, saved, onToggle }) {
  // A short scale pop on click, driven by state so saved hearts don't all pop
  // when the list first loads.
  const [popping, setPopping] = useState(false);

  // Nothing to key a favorite on without a job number.
  if (!jobNumber) return null;

  const label = saved ? "Remove from favorites" : "Save to favorites";

  const handleClick = (e) => {
    // The card's click overlay sits under this button; don't expand the card.
    e.stopPropagation();
    setPopping(true);
    onToggle?.();
  };

  return (
    <button
      type="button"
      className={`favorite-button ${saved ? "favorite-button--saved" : ""}`}
      aria-pressed={Boolean(saved)}
      aria-label={label}
      onClick={handleClick}
      onAnimationEnd={() => setPopping(false)}
    >
      <span className="favorite-button__label" aria-hidden="true">
        {label}
      </span>
      <HeartIcon className={popping ? "heart-icon--pop" : ""} />
    </button>
  );
}
