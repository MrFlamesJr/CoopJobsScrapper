import { flushSync } from "react-dom";

/**
 * Expanding and collapsing a job card, run as a View Transition.
 *
 * The grid's cards and panels carry a `view-transition-name` only for the
 * length of a toggle, set imperatively so no re-render is needed: the card
 * being opened (or the panel being closed) is named `vt-morph` in the old
 * state and its counterpart takes the same name in the new one, so the
 * browser grows one box into the other while everything else named just
 * slides to its new place. The animation itself lives in JobPanel.css.
 */

const GRID_SELECTOR = ".job-grid > .job-card, .job-grid > .job-panel";
const MORPH = "vt-morph";

// Everything we named, so cleanup never has to search the DOM.
const tagged = new Set();
// Bumped per transition: a skipped transition's cleanup must not strip the
// names of the one that replaced it.
let runId = 0;

function clearTags() {
  tagged.forEach((el) => {
    el.style.viewTransitionName = "";
  });
  tagged.clear();
}

// A name has to be a valid custom-ident; job ids are database row ids, but
// don't take that on trust.
function nameFor(el) {
  const kind = el.classList.contains("job-panel") ? "panel" : "card";
  return `vt-${kind}-${String(el.dataset.jobId).replace(/[^\w-]/g, "_")}`;
}

function gridEl(id, wantPanel) {
  if (id == null) return null;
  const kind = wantPanel ? "job-panel" : "job-card";
  return document.querySelector(
    `.job-grid > .${kind}[data-job-id="${CSS.escape(String(id))}"]`,
  );
}

/**
 * Names one snapshot and returns the names, for the next pass to carry over:
 * the morph element first, then everything named in the previous snapshot
 * that is still in the document (so nothing fades out in place), then
 * whatever else is within a viewport-height of the viewport. Cards further
 * away than that aren't worth a snapshot, which keeps the cost flat however
 * many jobs are loaded. A duplicate name aborts the whole transition, so no
 * element is ever named twice here.
 */
function applyTags(morphEl, carry) {
  const names = new Map();
  if (morphEl) names.set(morphEl, MORPH);
  carry?.forEach((name, el) => {
    // The old morph source doesn't keep `vt-morph` — that name now belongs to
    // the element it grows into — it falls through to the pass below and gets
    // its ordinary name instead.
    if (name !== MORPH && el !== morphEl && el.isConnected) names.set(el, name);
  });

  const vh = window.innerHeight;
  document.querySelectorAll(GRID_SELECTOR).forEach((el) => {
    if (names.has(el) || !el.dataset.jobId) return;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < -vh || rect.top > vh * 2) return;
    names.set(el, nameFor(el));
  });

  names.forEach((name, el) => {
    el.style.viewTransitionName = name;
    tagged.add(el);
  });
  return names;
}

/**
 * `update` is the state flip (it runs either way). `morphId` is the job whose
 * card and panel swap places; leave it out and everything simply slides.
 */
export function runPanelTransition({ morphId = null, update }) {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reduced) {
    update();
    return;
  }

  // A panel already open for this id means this is a collapse: the panel is
  // the box that shrinks back into the card.
  const closing = Boolean(gridEl(morphId, true));
  const run = (runId += 1);
  // Clicking during a transition skips it, and its cleanup is then suppressed
  // below — so start from a clean slate, or the previous run's `vt-morph`
  // would still be on an element and the duplicate name would abort this
  // transition outright. Nothing repaints between here and the retag.
  clearTags();
  const oldNames = applyTags(gridEl(morphId, closing), null);

  let transition;
  try {
    transition = document.startViewTransition(() => {
      flushSync(update);
      // After React's effects, so the panel's focus-on-mount scroll — if it
      // scrolls at all — is part of the state being measured.
      applyTags(gridEl(morphId, !closing), oldNames);
    });
  } catch {
    // Nothing captured; fall back to the plain flip.
    clearTags();
    update();
    return;
  }

  // Both reject with an AbortError when the next click skips this transition.
  transition.ready.catch(() => {});
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (run === runId) clearTags();
    });
}
