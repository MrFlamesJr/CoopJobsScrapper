"""Pure parsing of a job detail panel's HTML into the contract job dict.

No Selenium here: `parse_job_panel` takes the panel's outerHTML (read from the browser
in a single `execute_script` call by portal.py) and returns plain data. Keeping this
pure makes it fast and easy to unit test against small, synthetic HTML fixtures.

Metadata (job number, duration, work model, term, deadline, round, salary) and
qualifications are parsed by matching *labels*, never by pairing elements by position
-- a single extra or missing element in the DOM must not shift every later value into
the wrong field, which was the root cause of the "mixed up data" bug in the old code.
"""

import re
import unicodedata
from typing import Optional

from bs4 import BeautifulSoup, Tag

METADATA_LABELS = {
    "job number": "job_number",
    "duration": "duration",
    "work model": "work_model",
    "term": "term",
    "deadline": "deadline_text",
    "round": "round",
    "salary": "salary",
}


def normalize_text(text: Optional[str]) -> str:
    """Casefold and collapse whitespace, for label matching and identity checks.

    NFKC normalization runs first so text that is visually identical but composed
    differently (e.g. an accented letter as one precomposed codepoint vs. a base
    letter + combining accent, or a non-breaking space vs. a regular space) still
    compares equal -- this was seen failing to match "Caisse de dépôt et placement
    du Québec" between the card and the panel despite the text looking the same.
    """
    normalized = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", normalized).strip().casefold()


def _normalize_label(text: str) -> str:
    return normalize_text(text).rstrip(":").strip()


def _text(tag: Optional[Tag]) -> str:
    return tag.get_text(" ", strip=True) if tag is not None else ""


def _non_metadata_containers(root: Tag) -> list:
    """Containers whose [role=listitem]s must never be read as metadata.

    A description bullet or qualification paragraph can coincidentally read like
    "Duration: 8 months"; only the real metadata list may set those fields.
    """
    containers = []
    desc_heading = root.select_one("#jobdescheading")
    if desc_heading is not None and desc_heading.parent is not None:
        containers.append(desc_heading.parent)
    quals_heading = root.select_one("#qualifications")
    if quals_heading is not None and quals_heading.parent is not None:
        containers.append(quals_heading.parent)
    jobreq = root.select_one("#jobreq")
    if jobreq is not None:
        containers.append(jobreq)
    return containers


def _extract_metadata(root: Tag) -> dict:
    metadata = {key: "" for key in METADATA_LABELS.values()}
    excluded = _non_metadata_containers(root)

    for item in root.select('[role="listitem"]'):
        if any(container in item.parents for container in excluded):
            continue
        raw_text = _text(item)
        if not raw_text:
            continue

        # Form 1: "Label: value" inside a single list item.
        if ":" in raw_text:
            label_part, _, value_part = raw_text.partition(":")
            field = METADATA_LABELS.get(_normalize_label(label_part))
            if field and value_part.strip() and not metadata[field]:
                metadata[field] = value_part.strip()
                continue

        # Form 2: the item's text IS a known label; the value is the next listitem.
        field = METADATA_LABELS.get(_normalize_label(raw_text))
        if field and not metadata[field]:
            sibling = item.find_next_sibling(attrs={"role": "listitem"})
            if sibling is not None:
                metadata[field] = _text(sibling)

    # Form 3: a bold label cell (e.g. Salary) that ISN'T marked role="listitem" at
    # all -- real-run evidence: the portal renders "Salary" as a plain MudBlazor
    # grid pair (a <p><strong>Salary</strong></p> cell followed by a sibling <p>
    # value cell), so it never shows up in the role=listitem sweep above and was
    # silently dropped. Only fills fields Form 1/2 left empty, and only from a cell
    # whose own text is *exactly* its bold label (not a bolded word inside a longer
    # sentence, e.g. in the description).
    for field, value in _extract_grid_label_value_pairs(root, excluded).items():
        if not metadata[field]:
            metadata[field] = value

    return metadata


def _extract_grid_label_value_pairs(root: Tag, excluded: list) -> dict:
    pairs: dict = {}
    for label_p in root.select("p"):
        if any(container in label_p.parents for container in excluded):
            continue
        strong = label_p.find(["strong", "b"])
        if strong is None or _text(label_p) != _text(strong):
            continue  # not a cell whose ENTIRE text is the bold label
        field = METADATA_LABELS.get(_normalize_label(_text(strong)))
        if not field or field in pairs:
            continue  # unknown label, or a field already captured (first wins)
        label_cell = label_p.parent
        if label_cell is None or label_cell.get("role") == "listitem":
            continue  # role=listitem cells are handled by the sweep above
        value_cell = label_cell.find_next_sibling()
        if value_cell is None:
            continue
        value = _text(value_cell)
        if value:
            pairs[field] = value
    return pairs


def _extract_location(root: Tag) -> str:
    element = root.select_one('[aria-label^="location "]')
    return _text(element)


def _extract_requirements(root: Tag) -> list:
    container = root.select_one("#jobreq")
    if container is None:
        return []
    return [text for p in container.find_all("p") if (text := _text(p))]


def _extract_description(root: Tag) -> str:
    """Join the description's leaf text blocks with blank lines.

    The portal wraps every real paragraph/bullet in an extra <p> (and wraps each
    <li>'s text in its own nested <p>), so a naive "every p/li under the container"
    walk picks up both the wrapper (whose text is all its children's text
    concatenated) and the real blocks, duplicating the whole description. Only
    p/li elements with no nested p/li are real content; the rest are wrappers.
    """
    heading = root.select_one("#jobdescheading")
    if heading is None:
        return ""
    container = heading.parent or heading

    parts = []
    for node in container.find_all(["p", "li"]):
        if node.find(["p", "li"]) is not None:
            continue  # wrapper: its text duplicates its own leaf descendants
        text = _text(node)
        if text and text not in parts:
            parts.append(text)
    if parts:
        return "\n\n".join(parts)

    # Fallback for bare text/divs/<br> with no p/li blocks: the container's own
    # text, minus the heading's, preserving line breaks.
    body = container.get_text("\n", strip=True)
    heading_text = heading.get_text("\n", strip=True)
    if heading_text and body.startswith(heading_text):
        body = body[len(heading_text):].strip()
    return body


def _qualifications_from_bold_labels(container: Tag) -> list:
    """Pair each bolded label (<strong>/<b>) with the plain-text value(s) after it.

    The real portal markup is a grid of "cells" (one <p> each): a bold cell for a
    label like "Language" or "CGPA", followed by one or more plain cells for its
    value. Grouping by boldness -- rather than by position or DOM sibling grouping
    -- keeps each qualification separate regardless of how the grid cells nest.
    """
    qualifications = []
    name = None
    values = []
    for p in container.find_all("p"):
        text = _text(p)
        if not text:
            continue
        if p.find(["strong", "b"]) is not None:
            if name is not None:
                qualifications.append({"name": name, "value": "\n".join(values)})
            name, values = text, []
        elif name is not None:
            values.append(text)
    if name is not None:
        qualifications.append({"name": name, "value": "\n".join(values)})
    return qualifications


def _extract_qualifications(root: Tag) -> list:
    heading = root.select_one("#qualifications")
    if heading is None:
        return []
    container = heading.parent or heading

    labeled = _qualifications_from_bold_labels(container)
    if labeled:
        return labeled

    # Fallback: each direct child block (other than the heading) groups its own
    # <p> tags -- first is the qualification name, the rest are its value.
    blocks = []
    for child in container.find_all(recursive=False):
        if child is heading or child.name == "p":
            continue
        paragraphs = [text for p in child.find_all("p") if (text := _text(p))]
        if paragraphs:
            blocks.append(paragraphs)

    if blocks:
        return [
            {"name": paragraphs[0], "value": "\n".join(paragraphs[1:])}
            for paragraphs in blocks
        ]

    # Last resort for a flat structure: pair up consecutive <p> tags under the container.
    paragraphs = [text for p in container.find_all("p") if (text := _text(p))]
    return [
        {"name": paragraphs[index], "value": paragraphs[index + 1] if index + 1 < len(paragraphs) else ""}
        for index in range(0, len(paragraphs), 2)
    ]


def parse_job_panel(html: str) -> dict:
    """Parse a job detail panel's outerHTML into the contract job dict.

    Returns every field the contract job dict needs except title/employer/page_number
    (the scraper fills those in from the job card), plus `displayed_title` so the
    caller can re-verify the panel matches the card it clicked.
    """
    root = BeautifulSoup(html, "html.parser")

    job = {
        "location": _extract_location(root),
        "description": _extract_description(root),
        "requirements": _extract_requirements(root),
        "qualifications": _extract_qualifications(root),
        "displayed_title": _text(root.select_one("#orgname")),
    }
    job.update(_extract_metadata(root))
    return job
