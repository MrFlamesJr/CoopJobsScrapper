// Single source of truth for facet field ids + display labels, shared by the
// sidebar's facet groups and the active filter chips.
export const FACET_FIELDS = [
  { field: "employer", label: "Employer" },
  { field: "location", label: "Location" },
  { field: "work_model", label: "Work model" },
  { field: "term", label: "Term" },
  { field: "duration", label: "Duration" },
  { field: "round", label: "Round" },
];

export const FACET_FIELD_LABELS = Object.fromEntries(
  FACET_FIELDS.map(({ field, label }) => [field, label]),
);
