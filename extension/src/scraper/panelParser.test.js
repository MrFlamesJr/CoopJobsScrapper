import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeText, parseJobPanel } from "./panelParser.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name) {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

it("test_normalize_text_matches_regardless_of_accent_composition", () => {
  // "e" + combining acute accent (decomposed) must normalize the same as the
  // single precomposed "é" codepoint -- otherwise visually identical text (e.g. an
  // employer name with accents) can silently fail to match. NFKC also folds a
  // non-breaking space to a regular one.
  const precomposed = "Caisse de dépôt et placement du Québec";
  const decomposed = "Caisse de dépôt et placement du Québec";
  const withNbsp = "Caisse de dépôt et placement du Québec";

  expect(normalizeText(precomposed)).toBe(normalizeText(decomposed));
  expect(normalizeText(precomposed)).toBe(normalizeText(withNbsp));
});

it("test_full_panel_parses_every_field_and_ignores_extra_badge_item", () => {
  const job = parseJobPanel(load("panel_full.html"));

  expect(job.displayed_title).toBe("Software Developer Co-op");
  expect(job.job_number).toBe("JOB-1001");
  expect(job.duration).toBe("4 months");
  expect(job.work_model).toBe("Hybrid");
  expect(job.term).toBe("Winter 2027");
  expect(job.deadline_text).toBe("Oct 3, 2026");
  expect(job.round).toBe("Round 1");
  expect(job.salary).toBe("$20.00/hour");
  expect(job.location).toBe("Ottawa, ON, Canada");
});

it("test_full_panel_description_dedupes_list_text", () => {
  const job = parseJobPanel(load("panel_full.html"));

  expect(job.description).toContain("Write and review code");
  expect(job.description).toContain("Attend daily standups");
  // The <ul> itself must not appear as a separate, duplicated block of text.
  expect(job.description.split("Write and review code").length - 1).toBe(1);
});

it("test_full_panel_qualifications_group_multi_paragraph_value_by_dom", () => {
  const job = parseJobPanel(load("panel_full.html"));

  expect(job.qualifications).toEqual([
    { name: "Programming languages", value: "Python" },
    {
      name: "Education",
      value: "Currently enrolled in a Computer Science program.\nThird year or above preferred.",
    },
  ]);
});

it("test_full_panel_requirements_skip_empty_paragraphs", () => {
  const job = parseJobPanel(load("panel_full.html"));

  expect(job.requirements).toEqual([
    "Must be legally entitled to work in Canada.",
    "Must be enrolled full-time.",
  ]);
});

it("test_missing_optional_metadata_defaults_to_empty_string", () => {
  const job = parseJobPanel(load("panel_missing_optional.html"));

  expect(job.job_number).toBe("JOB-2002");
  expect(job.duration).toBe("8 months");
  expect(job.term).toBe("Summer 2027");
  // Never present in this fixture -- must default cleanly, not steal a nearby value.
  expect(job.work_model).toBe("");
  expect(job.round).toBe("");
  expect(job.salary).toBe("");
  expect(job.deadline_text).toBe("");
});

it("test_flat_qualifications_fall_back_to_positional_pairs", () => {
  const job = parseJobPanel(load("panel_missing_optional.html"));

  expect(job.qualifications).toEqual([
    { name: "SQL", value: "Comfortable writing joins and aggregations." },
    { name: "Excel", value: "Advanced pivot tables." },
  ]);
});

it("test_label_colon_value_form_is_parsed_even_amid_a_full_card_list_document", () => {
  const job = parseJobPanel(load("panel_label_colon.html"));

  expect(job.displayed_title).toBe("Marketing Assistant Co-op");
  expect(job.job_number).toBe("JOB-3003");
  expect(job.deadline_text).toBe("Nov 15, 2026");
  expect(job.salary).toBe("$19.50/hour");
  // Two-item-pair fields still work alongside "Label: value" ones in the same panel.
  expect(job.duration).toBe("4 months");
  expect(job.work_model).toBe("On-site");
  expect(job.round).toBe("Round 2");
  expect(job.location).toBe("Gatineau, QC");
  expect(job.qualifications).toEqual([
    { name: "Communication", value: "Strong written and verbal communication skills." },
  ]);
});

it("test_metadata_ignores_lookalike_label_text_inside_description", () => {
  const job = parseJobPanel(load("panel_metadata_leak.html"));

  // A description bullet reads "Duration: 8 months (a typical assignment, not this
  // one)" -- that must never win over the real metadata list's "4 months".
  expect(job.duration).toBe("4 months");
  expect(job.term).toBe("Winter 2027");
  expect(job.duration).not.toContain("8 months");
});

it("test_normalize_text_collapses_whitespace_and_casefolds", () => {
  expect(normalizeText("  Software   Developer\nCo-op ")).toBe("software developer co-op");
  expect(normalizeText(null)).toBe("");
});

// -- Real portal snapshots (data\debug\*.html), copied verbatim -------------------
//
// The live portal wraps every description paragraph in an extra <p> (and wraps
// each <li>'s text in its own nested <p>), and lays out qualifications as a grid
// of bold-label / plain-value <p> cells. These fixtures pin that real markup so a
// regression that reintroduces description duplication or merged qualifications
// is caught even if the synthetic fixtures above don't exercise it.

it("test_real_panel_metadata_and_qualifications", () => {
  const job = parseJobPanel(load("real_panel_2-8-948.html"));

  expect(job.displayed_title).toBe(
    "Software Engineering, Optical Transport and IP Networking Intern, CIENA Corporation"
  );
  expect(job.location).toBe("Kanata");
  expect(job.job_number).toBe("948");
  expect(job.duration).toBe("4 months");
  expect(job.work_model).toBe("Hybrid");
  expect(job.term).toBe("2027, Winter");
  expect(job.deadline_text).toBe("2026-09-30");
  expect(job.round).toBe("2");
  expect(job.requirements).toEqual(["No requirements for the job."]);
  // Two distinct qualifications, not one merged blob.
  expect(job.qualifications).toEqual([
    { name: "Language", value: "English or Bilingual" },
    { name: "CGPA", value: "0" },
  ]);
});

it("test_real_panel_description_is_not_duplicated", () => {
  const job = parseJobPanel(load("real_panel_2-8-948.html"));
  const description = job.description;

  expect(description.split("Full job list and application process here").length - 1).toBe(1);
  expect(
    description.split("You must therefore apply directly on the employer's website").length - 1
  ).toBe(1);
  expect(description.startsWith("*".repeat(20))).toBe(true);
});

it("test_real_panel_salary_grid_pair_without_role_listitem_is_parsed", () => {
  // Real-run evidence: the portal renders Salary as a plain MudBlazor grid pair
  // (a bold-label <p> cell followed by a sibling value <p> cell) with no
  // role="listitem" on either cell, unlike every other metadata field -- so it was
  // silently dropped by the role=listitem sweep alone.
  const job = parseJobPanel(load("real_panel_10-8-750.html"));

  expect(job.salary).toBe("$18.84 - $28.30");
  // Sanity check the rest of the metadata still comes from the normal sweep.
  expect(job.job_number).toBe("750");
  expect(job.work_model).toBe("Hybrid");
  expect(job.deadline_text).toBe("2026-09-18");
  expect(job.location).toBe("Gatineau");
});

it("test_real_panel_with_nested_list_description_and_qualifications", () => {
  const job = parseJobPanel(load("real_panel_2-5-943.html"));

  expect(job.location).toBe("Gatineau");
  expect(job.job_number).toBe("943");
  expect(job.deadline_text).toBe("2026-09-22");
  expect(job.qualifications).toEqual([
    { name: "Language", value: "Bilingual" },
    { name: "CGPA", value: "0" },
  ]);

  const description = job.description;
  // Each bullet's leaf <p> (nested inside <li><p>...</p></li>) must appear once,
  // not once as part of the wrapper's concatenated text and again on its own.
  expect(description.split("across the wor").length - 1).toBe(1);
  expect(description.split("ttend team meetings").length - 1).toBe(1);
  // Paragraphs are joined with blank lines, not run together.
  expect(description).toContain("\n\n");
});
