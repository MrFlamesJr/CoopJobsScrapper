import { useEffect, useRef, useState } from "react";
import { Highlight } from "../highlight.jsx";
import "./JobNumber.css";

// How long "Copied" stays out after a successful copy.
const COPIED_MS = 1200;

// 12px stroke icons in the same inline-SVG style as ChevronIcon: two
// overlapping rounded sheets, swapped for a check while copied.
function CopyIcon({ copied }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {copied ? (
        <path d="M3 8.5 6.2 11.7 13 5" />
      ) : (
        <>
          <rect x="6" y="6" width="7.5" height="7.5" rx="1.6" />
          <path d="M10 3.6a1.6 1.6 0 0 0-1.6-1.6h-4.8A1.6 1.6 0 0 0 2 3.6v4.8A1.6 1.6 0 0 0 3.6 10" />
        </>
      )}
    </svg>
  );
}

/**
 * The job number, click to copy. `as="button"` where it isn't already nested
 * in one (the panel header); inside the card's summary button it stays a
 * `<span>`, since a nested button is invalid HTML.
 */
export default function JobNumber({ value, as: Tag = "span" }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Nothing to copy: plain text, no hint, no click target.
  if (!value) return <span className="job-number job-number--empty">—</span>;

  const copy = (e) => {
    // The card's summary button must not toggle on this click.
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {
        // Clipboard permission denied / unavailable: leave the number as is.
      },
    );
  };

  const buttonProps =
    Tag === "button" ? { type: "button", "aria-label": `Copy job number ${value}` } : {};

  return (
    <Tag className="job-number" data-copied={copied} onClick={copy} {...buttonProps}>
      <span className="job-number__value">
        <Highlight text={value} />
      </span>
      <span className="job-number__hint" aria-hidden="true">
        <CopyIcon copied={copied} />
        {copied ? "Copied" : "Click to copy"}
      </span>
    </Tag>
  );
}
