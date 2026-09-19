import { useEffect, useRef, useState } from "react";

/**
 * Tracks which way the page is scrolling, debounced against jitter: flipping
 * to "down" needs `hideAfter` px of net downward movement since the last
 * flip, flipping to "up" needs `showAfter` px upward — a small back-and-forth
 * (trackpad wobble, a bouncing scroll) never flips it. Returning to the very
 * top of the page always resets to "up". One passive, rAF-throttled `window`
 * scroll listener; state only changes on an actual flip.
 */
export function useScrollDirection({ showAfter = 6, hideAfter = 12 } = {}) {
  const [direction, setDirection] = useState("up");
  const lastYRef = useRef(0);
  // Net movement since the last flip, in the current direction.
  const accRef = useRef(0);
  const dirRef = useRef("up");
  const tickingRef = useRef(false);

  useEffect(() => {
    lastYRef.current = window.scrollY;

    const update = () => {
      tickingRef.current = false;
      const y = window.scrollY;
      const delta = y - lastYRef.current;
      lastYRef.current = y;

      if (y <= 0) {
        accRef.current = 0;
        if (dirRef.current !== "up") {
          dirRef.current = "up";
          setDirection("up");
        }
        return;
      }

      // A step opposite the current direction starts a fresh count instead
      // of eating into the existing one, so it can't slowly cancel out a
      // real flip over many small wobbles.
      if ((delta > 0 && dirRef.current === "up") || (delta < 0 && dirRef.current === "down")) {
        accRef.current = delta;
      } else {
        accRef.current += delta;
      }

      if (dirRef.current === "up" && accRef.current >= hideAfter) {
        dirRef.current = "down";
        accRef.current = 0;
        setDirection("down");
      } else if (dirRef.current === "down" && accRef.current <= -showAfter) {
        dirRef.current = "up";
        accRef.current = 0;
        setDirection("up");
      }
    };

    const onScroll = () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [showAfter, hideAfter]);

  return direction;
}
