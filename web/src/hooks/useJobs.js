import { useEffect, useRef, useState } from "react";
import { fetchJobs } from "../api.js";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Loads the job list for the current filter state.
 * `filters` shape: { q, sorts: [{field, dir}], rating, deadline, filters: { field: [values] } }
 * `refreshKey` bumps to force a refetch (e.g. after a scrape finishes).
 * `silent` marks that bump as a background refresh (jobs arriving live during
 * a scrape): the list is swapped in without a loading flag, so the grid never
 * dims and expanded cards stay put.
 *
 * Also returns `appliedQ`, the debounced query the current `jobs` actually
 * came from — set only once that fetch resolves, so it never runs ahead of
 * `debouncedQ` while a request for a newer query is still in flight. Callers
 * that highlight matches key off this, not the raw `q`, so marks never run
 * ahead of the results while typing.
 */
export function useJobs(filters, refreshKey, silent = false) {
  const { q, sorts, rating, deadline, filters: facetFilters } = filters;

  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [appliedQ, setAppliedQ] = useState(q);

  const abortRef = useRef(null);
  // Read inside the effect, never a dependency: `silent` only describes the
  // refreshKey bump it arrived with.
  const silentRef = useRef(silent);
  silentRef.current = silent;
  const lastRefreshRef = useRef(refreshKey);

  useEffect(() => {
    // Anything the user did (search, sort, filters) still shows loading.
    const quiet = silentRef.current && refreshKey !== lastRefreshRef.current;
    lastRefreshRef.current = refreshKey;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!quiet) {
      setLoading(true);
      setError(null);
    }

    const params = { q: debouncedQ, sorts, rating, deadline, ...facetFilters };

    fetchJobs(params, controller.signal)
      .then((data) => {
        setJobs(data.jobs);
        setTotal(data.total);
        setAppliedQ(debouncedQ);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        // A dropped background refresh keeps the list it already has; the next
        // one is a second and a half away.
        if (quiet) return;
        setError(err);
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, JSON.stringify(sorts), rating, deadline, JSON.stringify(facetFilters), refreshKey]);

  return { jobs, total, loading, error, appliedQ };
}
