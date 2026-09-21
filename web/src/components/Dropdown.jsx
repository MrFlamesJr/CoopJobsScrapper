import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./Dropdown.css";

// Gap between the trigger and the menu, and the margin the menu keeps from
// the viewport edges.
const GAP = 4;
const EDGE = 8;

// Small inline chevron, flipped by CSS while the menu is open.
function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/**
 * The app's one dropdown: a styled trigger plus a menu, meant to be reused
 * wherever a native <select> would otherwise turn up.
 *
 * The menu is portalled to <body> and positioned `fixed` from the trigger's
 * viewport rect, so no scrolling ancestor can clip it and nothing on the page
 * can paint over it. It opens downward, and only flips above the trigger when
 * there isn't room below and there is more room above; either way it's capped
 * to the space it actually has and scrolls inside.
 * Keyboard: arrows move the highlight, Enter/Space picks, Escape closes.
 */
export default function Dropdown({ value, options, onChange, placeholder, ariaLabel, className = "" }) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const selected = options.find((o) => o.value === value);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const rect = trigger.getBoundingClientRect();
    const roomAbove = rect.top - GAP - EDGE;
    const roomBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    // scrollHeight, not offsetHeight: the menu may already be capped by a
    // maxHeight from an earlier pass, and we want the content's full height.
    const wanted = menu.scrollHeight;
    // Downward is the default; going up is the last resort for a trigger near
    // the bottom of the window, and only when there is more room up there.
    const up = wanted > roomBelow && roomAbove > roomBelow;

    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - menu.offsetWidth));

    setMenuStyle({
      left: `${left}px`,
      minWidth: `${rect.width}px`,
      maxHeight: `${Math.max(80, up ? roomAbove : roomBelow)}px`,
      ...(up ? { bottom: `${window.innerHeight - rect.top + GAP}px` } : { top: `${rect.bottom + GAP}px` }),
    });
  }, []);

  // Positioned before the browser paints, so the menu never shows up in the
  // wrong spot first. Any ancestor scrolling (capture phase) or a resize moves
  // the trigger, so both re-place it.
  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return undefined;
    }
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // Only on open: `options` is usually a fresh array each render, so watching
  // it here would reset the highlight on every keystroke.
  useLayoutEffect(() => {
    if (!open) return;
    const index = options.findIndex((o) => o.value === value);
    setHighlighted(index >= 0 ? index : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function pick(optionValue) {
    onChange(optionValue);
    setOpen(false);
  }

  // Focus stays on the trigger while the menu is open, so this one handler
  // covers both states.
  function handleKeyDown(e) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (options[highlighted]) pick(options[highlighted].value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`dropdown__trigger ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
      >
        <span className="dropdown__label">{selected?.label || placeholder}</span>
        <ChevronIcon />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="dropdown__menu"
            // Hidden for the first layout pass, which is where it gets measured.
            style={menuStyle || { visibility: "hidden", top: 0, left: 0 }}
            role="listbox"
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`dropdown__option ${index === highlighted ? "dropdown__option--highlighted" : ""}`}
                onClick={() => pick(option.value)}
                onMouseEnter={() => setHighlighted(index)}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
