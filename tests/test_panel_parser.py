from pathlib import Path

from app.scraper.panel_parser import normalize_text, parse_job_panel

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_normalize_text_matches_regardless_of_accent_composition():
    """"e" + combining acute accent (decomposed) must normalize the same as the
    single precomposed "é" codepoint -- otherwise visually identical text (e.g. an
    employer name with accents) can silently fail to match. NFKC also folds a
    non-breaking space to a regular one.
    """
    precomposed = "Caisse de dépôt et placement du Québec"
    decomposed = "Caisse de dépôt et placement du Québec"
    with_nbsp = "Caisse de dépôt et placement du Québec"

    assert normalize_text(precomposed) == normalize_text(decomposed)
    assert normalize_text(precomposed) == normalize_text(with_nbsp)


def test_full_panel_parses_every_field_and_ignores_extra_badge_item():
    job = parse_job_panel(_load("panel_full.html"))

    assert job["displayed_title"] == "Software Developer Co-op"
    assert job["job_number"] == "JOB-1001"
    assert job["duration"] == "4 months"
    assert job["work_model"] == "Hybrid"
    assert job["term"] == "Winter 2027"
    assert job["deadline_text"] == "Oct 3, 2026"
    assert job["round"] == "Round 1"
    assert job["salary"] == "$20.00/hour"
    assert job["location"] == "Ottawa, ON, Canada"


def test_full_panel_description_dedupes_list_text():
    job = parse_job_panel(_load("panel_full.html"))

    assert "Write and review code" in job["description"]
    assert "Attend daily standups" in job["description"]
    # The <ul> itself must not appear as a separate, duplicated block of text.
    assert job["description"].count("Write and review code") == 1


def test_full_panel_qualifications_group_multi_paragraph_value_by_dom():
    job = parse_job_panel(_load("panel_full.html"))

    assert job["qualifications"] == [
        {"name": "Programming languages", "value": "Python"},
        {
            "name": "Education",
            "value": "Currently enrolled in a Computer Science program.\nThird year or above preferred.",
        },
    ]


def test_full_panel_requirements_skip_empty_paragraphs():
    job = parse_job_panel(_load("panel_full.html"))

    assert job["requirements"] == [
        "Must be legally entitled to work in Canada.",
        "Must be enrolled full-time.",
    ]


def test_missing_optional_metadata_defaults_to_empty_string():
    job = parse_job_panel(_load("panel_missing_optional.html"))

    assert job["job_number"] == "JOB-2002"
    assert job["duration"] == "8 months"
    assert job["term"] == "Summer 2027"
    # Never present in this fixture -- must default cleanly, not steal a nearby value.
    assert job["work_model"] == ""
    assert job["round"] == ""
    assert job["salary"] == ""
    assert job["deadline_text"] == ""


def test_flat_qualifications_fall_back_to_positional_pairs():
    job = parse_job_panel(_load("panel_missing_optional.html"))

    assert job["qualifications"] == [
        {"name": "SQL", "value": "Comfortable writing joins and aggregations."},
        {"name": "Excel", "value": "Advanced pivot tables."},
    ]


def test_label_colon_value_form_is_parsed_even_amid_a_full_card_list_document():
    job = parse_job_panel(_load("panel_label_colon.html"))

    assert job["displayed_title"] == "Marketing Assistant Co-op"
    assert job["job_number"] == "JOB-3003"
    assert job["deadline_text"] == "Nov 15, 2026"
    assert job["salary"] == "$19.50/hour"
    # Two-item-pair fields still work alongside "Label: value" ones in the same panel.
    assert job["duration"] == "4 months"
    assert job["work_model"] == "On-site"
    assert job["round"] == "Round 2"
    assert job["location"] == "Gatineau, QC"
    assert job["qualifications"] == [
        {"name": "Communication", "value": "Strong written and verbal communication skills."}
    ]


def test_metadata_ignores_lookalike_label_text_inside_description():
    job = parse_job_panel(_load("panel_metadata_leak.html"))

    # A description bullet reads "Duration: 8 months (a typical assignment, not this
    # one)" -- that must never win over the real metadata list's "4 months".
    assert job["duration"] == "4 months"
    assert job["term"] == "Winter 2027"
    assert "8 months" not in job["duration"]


def test_normalize_text_collapses_whitespace_and_casefolds():
    assert normalize_text("  Software   Developer\nCo-op ") == "software developer co-op"
    assert normalize_text(None) == ""


# -- Real portal snapshots (data\debug\*.html), copied verbatim -------------------
#
# The live portal wraps every description paragraph in an extra <p> (and wraps
# each <li>'s text in its own nested <p>), and lays out qualifications as a grid
# of bold-label / plain-value <p> cells. These fixtures pin that real markup so a
# regression that reintroduces description duplication or merged qualifications
# is caught even if the synthetic fixtures above don't exercise it.


def test_real_panel_metadata_and_qualifications():
    job = parse_job_panel(_load("real_panel_2-8-948.html"))

    assert job["displayed_title"] == (
        "Software Engineering, Optical Transport and IP Networking Intern, CIENA Corporation"
    )
    assert job["location"] == "Kanata"
    assert job["job_number"] == "948"
    assert job["duration"] == "4 months"
    assert job["work_model"] == "Hybrid"
    assert job["term"] == "2027, Winter"
    assert job["deadline_text"] == "2026-09-30"
    assert job["round"] == "2"
    assert job["requirements"] == ["No requirements for the job."]
    # Two distinct qualifications, not one merged blob.
    assert job["qualifications"] == [
        {"name": "Language", "value": "English or Bilingual"},
        {"name": "CGPA", "value": "0"},
    ]


def test_real_panel_description_is_not_duplicated():
    job = parse_job_panel(_load("real_panel_2-8-948.html"))
    description = job["description"]

    assert description.count("Full job list and application process here") == 1
    assert description.count("You must therefore apply directly on the employer's website") == 1
    assert description.startswith("*" * 20)


def test_real_panel_salary_grid_pair_without_role_listitem_is_parsed():
    """Real-run evidence: the portal renders Salary as a plain MudBlazor grid pair
    (a bold-label <p> cell followed by a sibling value <p> cell) with no
    role="listitem" on either cell, unlike every other metadata field -- so it was
    silently dropped by the role=listitem sweep alone."""
    job = parse_job_panel(_load("real_panel_10-8-750.html"))

    assert job["salary"] == "$18.84 - $28.30"
    # Sanity check the rest of the metadata still comes from the normal sweep.
    assert job["job_number"] == "750"
    assert job["work_model"] == "Hybrid"
    assert job["deadline_text"] == "2026-09-18"
    assert job["location"] == "Gatineau"


def test_real_panel_with_nested_list_description_and_qualifications():
    job = parse_job_panel(_load("real_panel_2-5-943.html"))

    assert job["location"] == "Gatineau"
    assert job["job_number"] == "943"
    assert job["deadline_text"] == "2026-09-22"
    assert job["qualifications"] == [
        {"name": "Language", "value": "Bilingual"},
        {"name": "CGPA", "value": "0"},
    ]

    description = job["description"]
    # Each bullet's leaf <p> (nested inside <li><p>...</p></li>) must appear once,
    # not once as part of the wrapper's concatenated text and again on its own.
    assert description.count("across the wor") == 1
    assert description.count("ttend team meetings") == 1
    # Paragraphs are joined with blank lines, not run together.
    assert "\n\n" in description
