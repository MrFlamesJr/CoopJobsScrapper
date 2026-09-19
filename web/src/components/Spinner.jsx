import "./Spinner.css";

/**
 * A small CSS ring. `size` is in px; `tone` picks the arc colour ("accent" or
 * "warn"). It always sits next to text that says what is happening, so it is
 * hidden from screen readers.
 */
export default function Spinner({ size = 14, tone = "accent" }) {
  return (
    <span
      className={`spinner spinner--${tone}`}
      style={{ "--spinner-size": `${size}px` }}
      aria-hidden="true"
    />
  );
}
