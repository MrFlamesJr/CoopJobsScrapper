import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How many columns the grid element currently has, read straight off its
 * resolved `grid-template-columns` — the browser has already done the
 * `auto-fill` maths, so nothing here has to guess at card widths.
 *
 * 1 until the first measure, which happens in a layout effect so the first
 * paint is already right.
 */
export function useGridColumns(ref) {
  const [columns, setColumns] = useState(1);
  const observedRef = useRef(null);
  const observerRef = useRef(null);

  // No dep array on purpose: the grid element comes and goes with the empty
  // states, and only a change of element does any work.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === observedRef.current) return;
    observerRef.current?.disconnect();
    observedRef.current = el;
    observerRef.current = null;
    if (!el) return;

    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns;
      const count = tracks && tracks !== "none" ? tracks.trim().split(/\s+/).length : 1;
      setColumns(Math.max(1, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observerRef.current = observer;
  });

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return columns;
}
