import { useEffect, useRef, useState } from "react";
import { fetchJobs } from "../api.js";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Loads the job list for the current filter state.
 * `filters` shape: { q, sort, deadline, filters: { field: [values] } }
 * `refreshKey` bumps to force a refetch (e.g. after a scrape finishes).
 */
export function useJobs(filters, refreshKey) {
  const { q, sort, deadline, filters: facetFilters } = filters;

  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const params = { q: debouncedQ, sort, deadline, ...facetFilters };

    fetchJobs(params, controller.signal)
      .then((data) => {
        setJobs(data.jobs);
        setTotal(data.total);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, sort, deadline, JSON.stringify(facetFilters), refreshKey]);

  return { jobs, total, loading, error };
}
