import InfoIcon from "./InfoIcon.jsx";

/**
 * Shared info "i". One rule for the whole app: a short, single-line tip is a
 * native `title` and nothing else, so only one tooltip ever shows. Pass `long`
 * for paragraph- or list-length text, which the native tooltip renders badly;
 * that goes to the custom bubble in TooltipLayer instead.
 *
 * With `onClick` it is a button (the About icon opens a dialog); without, a
 * focusable note, so keyboard users can still reach the tip.
 */
export default function InfoDot({
  tip,
  label,
  long = false,
  onClick,
  className,
  placement,
}) {
  if (long) {
    // The bubble is not announced, so the full text goes in the label.
    return (
      <span
        className={className}
        aria-label={`${label}: ${tip}`}
        data-tooltip={tip}
        data-tooltip-placement={placement}
        tabIndex={0}
        role="note"
      >
        <InfoIcon />
      </span>
    );
  }

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={tip} aria-label={tip}>
        <InfoIcon />
      </button>
    );
  }

  return (
    <span className={className} title={tip} aria-label={tip} tabIndex={0} role="note">
      <InfoIcon />
    </span>
  );
}
