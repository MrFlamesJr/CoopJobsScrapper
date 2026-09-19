import { useEffect, useRef } from "react";
import "./TooltipLayer.css";

/**
 * The one tooltip bubble for the whole app: every element carrying
 * `data-tooltip` gets it, through delegated listeners on `document`.
 *
 * Why one shared popover instead of a `::after` per trigger: a pseudo element
 * is clipped by any `overflow: hidden/auto` ancestor (the cards, the favorites
 * list) and loses z-index fights. `showPopover()` puts this div in the
 * browser's *top layer*, which is above everything — including the modal
 * <dialog> the scraper opens, where even a document.body portal would end up
 * behind the dialog.
 *
 * Placement: a top-layer `position: fixed` box is laid out against the
 * viewport, so the trigger's `getBoundingClientRect()` values are used exactly
 * as they come — no scroll offsets, no offsetParent maths, unaffected by
 * transformed ancestors. TooltipLayer.css holds the UA resets that keep that
 * true (the UA would otherwise centre the popover).
 *
 * `data-tooltip-placement="top-start"` puts it above the trigger with their
 * left edges flush; the default is below with the right edges flush, which is
 * where the deadline chip's old bubble sat.
 */

const DELAY = 150; // hover delay, same as the old CSS tooltip's
const GAP = 6; // trigger → bubble, matching the old 0.35rem
const EDGE = 4; // smallest gap kept to the viewport edges
// A trigger can be unmounted while the bubble is up (a card collapses under
// the pointer) without any pointerout firing, which would leave the bubble
// hanging; poll for that instead.
const ALIVE_MS = 400;

export default function TooltipLayer() {
  const tipRef = useRef(null);

  useEffect(() => {
    const tip = tipRef.current;
    // No Popover API: no tooltip at all (triggers keep their aria-label /
    // aria-describedby). Not worth a second, clippable code path.
    if (!tip || typeof tip.showPopover !== "function") return undefined;

    let trigger = null; // the [data-tooltip] the bubble is currently showing
    let pending = null; // the one waiting out the delay
    let showTimer = 0;
    let aliveTimer = 0;
    let frame = 0;
    let open = false;

    const hide = () => {
      clearTimeout(showTimer);
      clearInterval(aliveTimer);
      cancelAnimationFrame(frame);
      showTimer = aliveTimer = frame = 0;
      trigger = null;
      pending = null;
      tip.classList.remove("tooltip--shown");
      if (open) {
        open = false;
        try {
          tip.hidePopover();
        } catch {
          // Already closed (light dismiss, dialog teardown): nothing to do.
        }
      }
    };

    const place = (el) => {
      const r = el.getBoundingClientRect();
      const { width, height } = tip.getBoundingClientRect();
      const topStart = el.dataset.tooltipPlacement === "top-start";
      const above = r.top - GAP - height;
      const below = r.bottom + GAP;
      let top = topStart ? above : below;
      let left = topStart ? r.left : r.right - width;
      // Flip to the other side when the preferred one leaves the viewport.
      if (topStart ? top < EDGE : top + height > window.innerHeight - EDGE) {
        top = topStart ? below : above;
      }
      left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    };

    const show = (el) => {
      showTimer = 0;
      pending = null;
      const text = el.getAttribute("data-tooltip");
      if (!text || !el.isConnected) return;
      trigger = el;
      tip.textContent = text;
      if (!open) {
        tip.showPopover();
        open = true;
      }
      // Measured only now: before showPopover() the bubble has no box. Placed
      // in the same frame as the reveal, and still at opacity 0, so it never
      // paints in the wrong spot.
      place(el);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (trigger === el) tip.classList.add("tooltip--shown");
      });
      aliveTimer = setInterval(() => {
        if (!el.isConnected) hide();
      }, ALIVE_MS);
    };

    const enter = (e) => {
      const el = e.target instanceof Element ? e.target.closest("[data-tooltip]") : null;
      // Bubbling from a child of the same trigger: leave the delay running.
      if (!el || el === trigger || el === pending) return;
      hide(); // moving straight from another trigger: drop that one first
      pending = el;
      showTimer = setTimeout(() => show(el), DELAY);
    };

    const leave = (e) => {
      const el = trigger || pending;
      if (!el) return;
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      hide();
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", onKeyDown, true);
    // Capture, so scrolling an inner list counts too — the bubble is anchored
    // to viewport coordinates that any scroll invalidates.
    document.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);

    return () => {
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      hide();
    };
  }, []);

  return <div ref={tipRef} popover="manual" role="tooltip" className="tooltip" />;
}
