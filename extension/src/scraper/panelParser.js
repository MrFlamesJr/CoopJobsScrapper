// Pure parsing of a job detail panel's HTML into the contract job dict.
//
// Port of app/scraper/panel_parser.py (Python/BeautifulSoup) to plain DOM
// APIs so it can run both in a jsdom test environment and in a real content
// script (against a live Document/Element, no re-parsing required).
//
// Metadata (job number, duration, work model, term, deadline, round, salary)
// and qualifications are parsed by matching *labels*, never by pairing
// elements by position -- a single extra or missing element in the DOM must
// not shift every later value into the wrong field, which was the root cause
// of the "mixed up data" bug in the old code.

export const METADATA_LABELS = {
  "job number": "job_number",
  duration: "duration",
  "work model": "work_model",
  term: "term",
  deadline: "deadline_text",
  round: "round",
  salary: "salary",
};

/**
 * Casefold (via toLowerCase) and collapse whitespace, for label matching and
 * identity checks.
 *
 * NFKC normalization runs first so text that is visually identical but
 * composed differently (e.g. an accented letter as one precomposed codepoint
 * vs. a base letter + combining accent, or a non-breaking space vs. a
 * regular space) still compares equal -- this was seen failing to match
 * "Caisse de dépôt et placement du Québec" between the card and the panel
 * despite the text looking the same.
 *
 * Divergence from Python: Python uses str.casefold(), which differs from
 * toLowerCase() for a handful of codepoints (e.g. German "ß" casefolds to
 * "ss" but lowercases to itself). None of the fixtures/tests exercise that,
 * so toLowerCase() is used here as instructed.
 */
export function normalizeText(text) {
  const normalized = (text ?? "").normalize("NFKC");
  return normalized.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLabel(text) {
  return normalizeText(text).replace(/:+$/, "").trim();
}

/**
 * Mirrors BeautifulSoup's `tag.get_text(separator, strip=True)`: the text of
 * each descendant text node, individually stripped, empty ones dropped, then
 * joined by `separator`. Comment nodes are naturally excluded because
 * NodeFilter.SHOW_TEXT only visits Text nodes (matching bs4's default
 * `get_text(types=(NavigableString, CData))`, which excludes the Comment
 * subclass).
 */
function getText(node, separator = " ") {
  if (!node) return "";
  const doc = node.nodeType === 9 ? node : node.ownerDocument;
  const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const parts = [];
  let current = walker.nextNode();
  while (current) {
    const text = current.nodeValue.trim();
    if (text) parts.push(text);
    current = walker.nextNode();
  }
  return parts.join(separator);
}

function containsNode(container, node) {
  return !!container && typeof container.contains === "function" && container.contains(node);
}

/**
 * Containers whose [role=listitem]s must never be read as metadata.
 *
 * A description bullet or qualification paragraph can coincidentally read
 * like "Duration: 8 months"; only the real metadata list may set those
 * fields.
 */
function nonMetadataContainers(root) {
  const containers = [];
  const descHeading = root.querySelector("#jobdescheading");
  if (descHeading && descHeading.parentElement) {
    containers.push(descHeading.parentElement);
  }
  const qualsHeading = root.querySelector("#qualifications");
  if (qualsHeading && qualsHeading.parentElement) {
    containers.push(qualsHeading.parentElement);
  }
  const jobreq = root.querySelector("#jobreq");
  if (jobreq) containers.push(jobreq);
  return containers;
}

// Next sibling ELEMENT matching role="listitem", searching forward through
// all following siblings (not just the immediate one) -- mirrors bs4's
// `item.find_next_sibling(attrs={"role": "listitem"})`.
function findNextListItemSibling(item) {
  let sibling = item.nextElementSibling;
  while (sibling) {
    if (sibling.getAttribute("role") === "listitem") return sibling;
    sibling = sibling.nextElementSibling;
  }
  return null;
}

function extractMetadata(root) {
  const metadata = {};
  for (const field of Object.values(METADATA_LABELS)) metadata[field] = "";
  const excluded = nonMetadataContainers(root);

  for (const item of Array.from(root.querySelectorAll('[role="listitem"]'))) {
    if (excluded.some((container) => containsNode(container, item))) continue;
    const rawText = getText(item);
    if (!rawText) continue;

    // Form 1: "Label: value" inside a single list item.
    const colonIndex = rawText.indexOf(":");
    if (colonIndex !== -1) {
      const labelPart = rawText.slice(0, colonIndex);
      const valuePart = rawText.slice(colonIndex + 1);
      const field = METADATA_LABELS[normalizeLabel(labelPart)];
      if (field && valuePart.trim() && !metadata[field]) {
        metadata[field] = valuePart.trim();
        continue;
      }
    }

    // Form 2: the item's text IS a known label; the value is the next listitem.
    const field = METADATA_LABELS[normalizeLabel(rawText)];
    if (field && !metadata[field]) {
      const sibling = findNextListItemSibling(item);
      if (sibling) metadata[field] = getText(sibling);
    }
  }

  // Form 3: a bold label cell (e.g. Salary) that ISN'T marked role="listitem"
  // at all -- real-run evidence: the portal renders "Salary" as a plain
  // MudBlazor grid pair (a <p><strong>Salary</strong></p> cell followed by a
  // sibling <p> value cell), so it never shows up in the role=listitem sweep
  // above and was silently dropped. Only fills fields Form 1/2 left empty,
  // and only from a cell whose own text is *exactly* its bold label (not a
  // bolded word inside a longer sentence, e.g. in the description).
  const gridPairs = extractGridLabelValuePairs(root, excluded);
  for (const [field, value] of Object.entries(gridPairs)) {
    if (!metadata[field]) metadata[field] = value;
  }

  return metadata;
}

function extractGridLabelValuePairs(root, excluded) {
  const pairs = {};
  for (const labelP of Array.from(root.querySelectorAll("p"))) {
    if (excluded.some((container) => containsNode(container, labelP))) continue;
    const strong = labelP.querySelector("strong, b");
    if (!strong || getText(labelP) !== getText(strong)) continue; // not a cell whose ENTIRE text is the bold label
    const field = METADATA_LABELS[normalizeLabel(getText(strong))];
    if (!field || field in pairs) continue; // unknown label, or a field already captured (first wins)
    const labelCell = labelP.parentElement;
    if (!labelCell || labelCell.getAttribute("role") === "listitem") continue; // role=listitem cells are handled by the sweep above
    const valueCell = labelCell.nextElementSibling;
    if (!valueCell) continue;
    const value = getText(valueCell);
    if (value) pairs[field] = value;
  }
  return pairs;
}

function extractLocation(root) {
  const element = root.querySelector('[aria-label^="location "]');
  return getText(element);
}

function extractRequirements(root) {
  const container = root.querySelector("#jobreq");
  if (!container) return [];
  const requirements = [];
  for (const p of Array.from(container.querySelectorAll("p"))) {
    const text = getText(p);
    if (text) requirements.push(text);
  }
  return requirements;
}

/**
 * Join the description's leaf text blocks with blank lines.
 *
 * The portal wraps every real paragraph/bullet in an extra <p> (and wraps
 * each <li>'s text in its own nested <p>), so a naive "every p/li under the
 * container" walk picks up both the wrapper (whose text is all its
 * children's text concatenated) and the real blocks, duplicating the whole
 * description. Only p/li elements with no nested p/li are real content; the
 * rest are wrappers.
 */
function extractDescription(root) {
  const heading = root.querySelector("#jobdescheading");
  if (!heading) return "";
  const container = heading.parentElement || heading;

  const parts = [];
  for (const node of Array.from(container.querySelectorAll("p, li"))) {
    if (node.querySelector("p, li")) continue; // wrapper: its text duplicates its own leaf descendants
    const text = getText(node);
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (parts.length) return parts.join("\n\n");

  // Fallback for bare text/divs/<br> with no p/li blocks: the container's own
  // text, minus the heading's, preserving line breaks.
  let body = getText(container, "\n");
  const headingText = getText(heading, "\n");
  if (headingText && body.startsWith(headingText)) {
    body = body.slice(headingText.length).trim();
  }
  return body;
}

/**
 * Pair each bolded label (<strong>/<b>) with the plain-text value(s) after it.
 *
 * The real portal markup is a grid of "cells" (one <p> each): a bold cell for
 * a label like "Language" or "CGPA", followed by one or more plain cells for
 * its value. Grouping by boldness -- rather than by position or DOM sibling
 * grouping -- keeps each qualification separate regardless of how the grid
 * cells nest.
 */
function qualificationsFromBoldLabels(container) {
  const qualifications = [];
  let name = null;
  let values = [];
  for (const p of Array.from(container.querySelectorAll("p"))) {
    const text = getText(p);
    if (!text) continue;
    if (p.querySelector("strong, b")) {
      if (name !== null) qualifications.push({ name, value: values.join("\n") });
      name = text;
      values = [];
    } else if (name !== null) {
      values.push(text);
    }
  }
  if (name !== null) qualifications.push({ name, value: values.join("\n") });
  return qualifications;
}

function extractQualifications(root) {
  const heading = root.querySelector("#qualifications");
  if (!heading) return [];
  const container = heading.parentElement || heading;

  const labeled = qualificationsFromBoldLabels(container);
  if (labeled.length) return labeled;

  // Fallback: each direct child block (other than the heading) groups its
  // own <p> tags -- first is the qualification name, the rest are its value.
  const blocks = [];
  for (const child of Array.from(container.children)) {
    if (child === heading || child.tagName.toLowerCase() === "p") continue;
    const paragraphs = Array.from(child.querySelectorAll("p"))
      .map((p) => getText(p))
      .filter((text) => text);
    if (paragraphs.length) blocks.push(paragraphs);
  }

  if (blocks.length) {
    return blocks.map((paragraphs) => ({
      name: paragraphs[0],
      value: paragraphs.slice(1).join("\n"),
    }));
  }

  // Last resort for a flat structure: pair up consecutive <p> tags under the container.
  const paragraphs = Array.from(container.querySelectorAll("p"))
    .map((p) => getText(p))
    .filter((text) => text);
  const result = [];
  for (let index = 0; index < paragraphs.length; index += 2) {
    result.push({
      name: paragraphs[index],
      value: index + 1 < paragraphs.length ? paragraphs[index + 1] : "",
    });
  }
  return result;
}

function toRoot(input) {
  if (typeof input === "string") {
    return new DOMParser().parseFromString(input, "text/html");
  }
  return input; // already a Document or Element (e.g. a content script's live panel node)
}

/**
 * Parse a job detail panel's outerHTML (or an already-parsed Document/Element)
 * into the contract job dict.
 *
 * Returns every field the contract job dict needs except title/employer/page_number
 * (the scraper fills those in from the job card), plus `displayed_title` so the
 * caller can re-verify the panel matches the card it clicked.
 *
 * Field names are kept snake_case (matching the Python port) so the DB layer matches.
 */
export function parseJobPanel(input) {
  const root = toRoot(input);

  const job = {
    location: extractLocation(root),
    description: extractDescription(root),
    requirements: extractRequirements(root),
    qualifications: extractQualifications(root),
    displayed_title: getText(root.querySelector("#orgname")),
  };
  Object.assign(job, extractMetadata(root));
  return job;
}
