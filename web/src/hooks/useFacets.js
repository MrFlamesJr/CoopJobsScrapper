import { useCallback, useEffect, useState } from "react";
import { fetchFacets } from "../api.js";

/** Loads facet counts ({ employer: [{value,count}], ... }). */
export function useFacets(refreshKey) {
  const [facets, setFacets] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchFacets(controller.signal)
      .then((data) => {
        setFacets(data);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => reload(), [reload, refreshKey]);

  return { facets, loading, error, reload };
}
