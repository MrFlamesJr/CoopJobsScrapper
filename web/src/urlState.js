import { FACET_FIELDS } from "./facetFields.js";
import { SORT_FIELD_NAMES } from "./components/SortStack.jsx";

const VALID_SORT_FIELDS = SORT_FIELD_NAMES;

// Facet field names
const VALID_FACET_FIELDS = FACET_FIELDS.map((f) => f.field);

// Default state
const DEFAULTS = {
  q: "",
  sorts: [{ field: "employer", dir: "asc" }],
  ratingFilter: "all",
  deadlineMode: "open",
  facetFilters: {},
};

/** Parse URL search params and return filter state, falling back to defaults for
 * anything missing or unrecognized. */
export function readUrlState() {
  const params = new URLSearchParams(window.location.search);

  // q: free text search
  const q = params.get("q") || DEFAULTS.q;

  // sorts: comma-separated "field:dir" pairs
  const sortsParam = params.get("sort");
  let sorts = DEFAULTS.sorts;
  if (sortsParam) {
    const parsed = [];
    for (const part of sortsParam.split(",")) {
      const [field, dir] = part.split(":");
      if (field && VALID_SORT_FIELDS.includes(field) && (dir === "asc" || dir === "desc")) {
        parsed.push({ field, dir });
      }
    }
    if (parsed.length > 0) sorts = parsed;
  }

  // ratingFilter: "all" | "liked" | "hide_disliked"
  const ratingParam = params.get("rating");
  const ratingFilter = ratingParam && ["liked", "hide_disliked"].includes(ratingParam) ? ratingParam : DEFAULTS.ratingFilter;

  // deadlineMode: "open" | "all" (closed=show means "all")
  const closedParam = params.get("closed");
  const deadlineMode = closedParam === "show" ? "all" : DEFAULTS.deadlineMode;

  // facetFilters: object of field -> array of values
  const facetFilters = {};
  for (const field of VALID_FACET_FIELDS) {
    const values = params.getAll(`f.${field}`);
    if (values.length > 0) facetFilters[field] = values;
  }

  return {
    q,
    sorts,
    ratingFilter,
    deadlineMode,
    facetFilters,
  };
}

/** Build a URL query string from filter state, omitting anything equal to its
 * default. Calls history.replaceState to update the URL. */
export function writeUrlState(state) {
  const params = new URLSearchParams();

  // Add non-default q
  if (state.q && state.q !== DEFAULTS.q) {
    params.set("q", state.q);
  }

  // Add non-default sorts
  if (state.sorts && state.sorts.length > 0) {
    const sortsStr = state.sorts.map((s) => `${s.field}:${s.dir}`).join(",");
    const defaultSortsStr = DEFAULTS.sorts.map((s) => `${s.field}:${s.dir}`).join(",");
    if (sortsStr !== defaultSortsStr) {
      params.set("sort", sortsStr);
    }
  }

  // Add non-default ratingFilter
  if (state.ratingFilter && state.ratingFilter !== DEFAULTS.ratingFilter) {
    params.set("rating", state.ratingFilter);
  }

  // Add non-default deadlineMode
  if (state.deadlineMode && state.deadlineMode !== DEFAULTS.deadlineMode) {
    params.set("closed", "show");
  }

  // Add facet filters
  for (const [field, values] of Object.entries(state.facetFilters || {})) {
    if (Array.isArray(values) && values.length > 0) {
      for (const value of values) {
        params.append(`f.${field}`, value);
      }
    }
  }

  // Build URL and update history
  const queryString = params.toString();
  const url = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}
