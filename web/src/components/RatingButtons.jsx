import { useState } from "react";
import "./RatingButtons.css";

// Fill-based thumbs icons. Both use the same path; thumbs-down is rotated 180°
// in CSS to avoid duplicating the path. The icons inherit color via currentColor.
export function ThumbUpIcon({ className = "" }) {
  return (
    <svg className={`thumb-up-icon ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15.0501 7.04419C15.4673 5.79254 14.5357 4.5 13.2163 4.5C12.5921 4.5 12.0062 4.80147 11.6434 5.30944L8.47155 9.75H5.85748L5.10748 10.5V18L5.85748 18.75H16.8211L19.1247 14.1428C19.8088 12.7747 19.5406 11.1224 18.4591 10.0408C17.7926 9.37439 16.8888 9 15.9463 9H14.3981L15.0501 7.04419ZM9.60751 10.7404L12.864 6.1813C12.9453 6.06753 13.0765 6 13.2163 6C13.5118 6 13.7205 6.28951 13.627 6.56984L12.317 10.5H15.9463C16.491 10.5 17.0133 10.7164 17.3984 11.1015C18.0235 11.7265 18.1784 12.6814 17.7831 13.472L15.8941 17.25H9.60751V10.7404ZM8.10751 17.25H6.60748V11.25H8.10751V17.25Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

export function ThumbDownIcon({ className = "" }) {
  return (
    <svg className={`thumb-down-icon ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15.0501 7.04419C15.4673 5.79254 14.5357 4.5 13.2163 4.5C12.5921 4.5 12.0062 4.80147 11.6434 5.30944L8.47155 9.75H5.85748L5.10748 10.5V18L5.85748 18.75H16.8211L19.1247 14.1428C19.8088 12.7747 19.5406 11.1224 18.4591 10.0408C17.7926 9.37439 16.8888 9 15.9463 9H14.3981L15.0501 7.04419ZM9.60751 10.7404L12.864 6.1813C12.9453 6.06753 13.0765 6 13.2163 6C13.5118 6 13.7205 6.28951 13.627 6.56984L12.317 10.5H15.9463C16.491 10.5 17.0133 10.7164 17.3984 11.1015C18.0235 11.7265 18.1784 12.6814 17.7831 13.472L15.8941 17.25H9.60751V10.7404ZM8.10751 17.25H6.60748V11.25H8.10751V17.25Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

/**
 * Two buttons for rating a job: thumbs-up (liked, rating=1) and thumbs-down
 * (disliked, rating=-1). Both buttons fit in the space the old single heart
 * occupied. A click on the active button clears the rating (parent does not
 * handle it — the rating just stays as-is until onRate is called).
 */
export default function RatingButtons({ jobNumber, rating, onRate }) {
  // A short scale pop on click, driven by state so rated items don't all pop
  // when the list first loads.
  const [popping, setPopping] = useState(null);

  // Nothing to key a rating on without a job number.
  if (!jobNumber) return null;

  const handleThumbUp = (e) => {
    e.stopPropagation();
    setPopping("up");
    onRate?.(1);
  };

  const handleThumbDown = (e) => {
    e.stopPropagation();
    setPopping("down");
    onRate?.(-1);
  };

  return (
    <div className="rating-buttons">
      <button
        type="button"
        className={`rating-button rating-button--up ${rating === 1 ? "rating-button--active" : ""}`}
        aria-pressed={rating === 1}
        aria-label="Like this job"
        onClick={handleThumbUp}
        onAnimationEnd={(e) => {
          if (e.animationName === "rating-ring") {
            setPopping(null);
          }
        }}
      >
        <ThumbUpIcon className={popping === "up" ? "thumb-icon--pop" : ""} />
      </button>
      <button
        type="button"
        className={`rating-button rating-button--down ${rating === -1 ? "rating-button--active" : ""}`}
        aria-pressed={rating === -1}
        aria-label="Dislike this job"
        onClick={handleThumbDown}
        onAnimationEnd={(e) => {
          if (e.animationName === "rating-ring") {
            setPopping(null);
          }
        }}
      >
        <ThumbDownIcon className={popping === "down" ? "thumb-icon--pop" : ""} />
      </button>
    </div>
  );
}
