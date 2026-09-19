/**
 * Native `title` hints for text the CSS cut off, and only then.
 *
 * Roughly a dozen places ellipsise text (facet labels, card title / employer /
 * snippet / meta, panel header, favorites drawer, status chip, top bar, scrape
 * progress). Per-element `title` props would mean touching all of them, would
 * lie whenever the text happens to fit, and on the job cards would not even
 * show: the text sits under the summary button's ::after click overlay, and the
 * browser looks the tooltip up on the top-most hit-tested element. So: one
 * document listener that, on hover, finds the truncated element under the
 * pointer and puts its full text on whatever element the pointer actually hit.
 *
 * `installTruncationTitles()` is idempotent and returns an uninstall function.
 */

// The uninstall function while installed, else null.
let installed = null;

/** Truncated = it overflows *and* the overflow is hidden behind an ellipsis. */
function isEllipsized(el) {
  // Cheap check first; only then pay for the computed style.
  if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return false;
  const style = getComputedStyle(el);
  if (style.textOverflow === "ellipsis") return true;
  const clamp = style.webkitLineClamp;
  return Boolean(clamp) && clamp !== "none";
}

/** The top-most ellipsized element under the pointer, or null. */
function findEllipsized(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === document.body || el === document.documentElement) break;
    // Those have the real tooltip (TooltipLayer); don't double up.
    if (el.hasAttribute("data-tooltip")) continue;
    if (isEllipsized(el)) return el;
  }
  return null;
}

export function installTruncationTitles() {
  if (installed) return installed;

  let frame = 0;
  let point = null; // last pointer position + its hit target
  let marked = null; // element we put a title on, so we can take it back
  let lastTarget = null;
  let lastText = "";

  const unmark = () => {
    if (!marked) return;
    marked.removeAttribute("title");
    marked.removeAttribute("data-auto-title");
    marked = null;
  };

  const update = () => {
    frame = 0;
    const { x, y, target } = point;
    if (!target.isConnected) {
      unmark();
      lastTarget = null;
      lastText = "";
      return;
    }
    const source = target.hasAttribute("data-tooltip") ? null : findEllipsized(x, y);
    const text = source ? source.textContent.trim() : "";
    // Same element, same text: nothing to write.
    if (target === lastTarget && text === lastText) return;
    lastTarget = target;
    lastText = text;
    if (marked !== target) unmark();
    if (!text) {
      unmark();
      return;
    }
    // Never clobber a title the author wrote.
    if (target.hasAttribute("title") && !target.hasAttribute("data-auto-title")) return;
    target.setAttribute("title", text);
    target.setAttribute("data-auto-title", "");
    marked = target;
  };

  const onPointerMove = (e) => {
    if (!(e.target instanceof Element)) return;
    point = { x: e.clientX, y: e.clientY, target: e.target };
    if (frame) return; // one measurement per frame at most
    frame = requestAnimationFrame(update);
  };

  document.addEventListener("pointermove", onPointerMove, { passive: true });

  const uninstall = () => {
    if (installed !== uninstall) return;
    installed = null;
    document.removeEventListener("pointermove", onPointerMove);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    unmark();
  };

  installed = uninstall;
  return uninstall;
}
