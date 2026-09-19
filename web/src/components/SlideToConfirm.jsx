import { useCallback, useEffect, useRef, useState } from "react";
import "./SlideToConfirm.css";

const CONFIRM_THRESHOLD = 92; // percent
const KEY_STEP = 20;
const IDLE_RESET_MS = 2000;
const THUMB_SIZE = 34;

/**
 * A "slide to unlock"-style confirm: the only way to fire `onConfirm` is to
 * drag (or arrow-key) the thumb to the end. Clicks, double-clicks and rapid
 * clicking on the thumb or track never move it far enough to confirm.
 *
 * The drag position lives in a CSS variable set straight on the DOM (the
 * pattern the sidebar resizer uses), so dragging doesn't cost a re-render
 * per pixel. `busy` (controlled by the caller) parks the thumb at the end
 * and shows `busyLabel`; if the `onConfirm` promise it triggered rejects,
 * the thumb springs back to the start on its own.
 */
export default function SlideToConfirm({ label, busyLabel, busy, onConfirm }) {
  const trackRef = useRef(null);
  const thumbRef = useRef(null);
  const draggingRef = useRef(false);
  const percentRef = useRef(0);
  const startXRef = useRef(0);
  const startPercentRef = useRef(0);
  const confirmInFlightRef = useRef(false);
  const confirmedRef = useRef(false);
  const idleTimerRef = useRef(null);

  const setPos = useCallback((percent) => {
    percentRef.current = percent;
    trackRef.current?.style.setProperty("--pos", String(percent));
    thumbRef.current?.setAttribute("aria-valuenow", String(Math.round(percent)));
  }, []);

  const reset = useCallback(() => {
    confirmedRef.current = false;
    setPos(0);
  }, [setPos]);

  // Busy is a prop, not internal state: the caller owns when a delete/stop
  // is actually in flight. We just reflect it visually.
  useEffect(() => {
    if (busy) setPos(100);
    else reset();
  }, [busy, reset, setPos]);

  useEffect(() => () => clearTimeout(idleTimerRef.current), []);

  const confirm = useCallback(() => {
    if (confirmedRef.current || confirmInFlightRef.current || busy) return;
    confirmedRef.current = true;
    confirmInFlightRef.current = true;
    setPos(100);
    const result = onConfirm?.();
    if (result && typeof result.then === "function") {
      result
        .catch(() => reset())
        .finally(() => {
          confirmInFlightRef.current = false;
        });
    } else {
      confirmInFlightRef.current = false;
    }
  }, [busy, onConfirm, reset, setPos]);

  const usableRange = () => {
    const track = trackRef.current;
    if (!track) return 1;
    return Math.max(1, track.clientWidth - THUMB_SIZE);
  };

  const handlePointerDown = (e) => {
    if (busy) return;
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startPercentRef.current = percentRef.current;
    trackRef.current?.classList.add("slide-to-confirm--dragging");
    thumbRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    const deltaPercent = ((e.clientX - startXRef.current) / usableRange()) * 100;
    setPos(Math.max(0, Math.min(100, startPercentRef.current + deltaPercent)));
  };

  const endDrag = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    trackRef.current?.classList.remove("slide-to-confirm--dragging");
    thumbRef.current?.releasePointerCapture(e.pointerId);
    if (percentRef.current >= CONFIRM_THRESHOLD) confirm();
    else setPos(0);
  };

  const scheduleIdleReset = () => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => reset(), IDLE_RESET_MS);
  };

  const move = (next) => {
    setPos(next);
    if (next >= 100) confirm();
  };

  const handleKeyDown = (e) => {
    if (busy) return;
    switch (e.key) {
      case "ArrowRight":
        // A held key auto-repeats its way to 100 in well under a second;
        // require five deliberate presses instead.
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        move(Math.min(100, percentRef.current + KEY_STEP));
        scheduleIdleReset();
        break;
      case "ArrowLeft":
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        setPos(Math.max(0, percentRef.current - KEY_STEP));
        scheduleIdleReset();
        break;
      case "Home":
      case "Escape":
        e.preventDefault();
        clearTimeout(idleTimerRef.current);
        reset();
        break;
      default:
        break;
    }
  };

  const handleBlur = () => {
    clearTimeout(idleTimerRef.current);
    reset();
  };

  return (
    <div ref={trackRef} className="slide-to-confirm" style={{ "--pos": 0 }}>
      <span className="slide-to-confirm__fill" aria-hidden="true" />
      <span className="slide-to-confirm__label">{busy ? busyLabel : label}</span>
      <div
        ref={thumbRef}
        className="slide-to-confirm__thumb"
        role="slider"
        tabIndex={busy ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        aria-disabled={busy || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
    </div>
  );
}
