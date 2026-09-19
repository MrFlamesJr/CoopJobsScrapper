import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addFavorite, fetchFavorites, removeFavorite } from "../api.js";

/**
 * The favorites list, with optimistic add/remove.
 *
 * Every endpoint returns the full fresh list, so state is replaced from the
 * response; on an error we refetch to throw the optimistic guess away.
 * Refetches when `refreshKey` changes (after a scrape or a delete), so
 * re-linked and "no longer listed" rows update.
 */
export function useFavorites(refreshKey) {
  const [favorites, setFavorites] = useState([]);
  const [error, setError] = useState(null);
  // Bumped on each add only, so the Favorites button in TopBar can replay its pulse.
  const [pulseKey, setPulseKey] = useState(0);
  // Two fast clicks on a heart are two requests: only the answer to the
  // newest one may replace the list.
  const seqRef = useRef(0);

  const reload = useCallback(() => {
    const controller = new AbortController();
    const seq = (seqRef.current += 1);
    fetchFavorites(controller.signal)
      .then((data) => {
        if (seq !== seqRef.current) return;
        setFavorites(data?.favorites || []);
        setError(null);
      })
      .catch((err) => {
        if (err.name !== "AbortError" && seq === seqRef.current) setError(err);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => reload(), [reload, refreshKey]);

  const savedSet = useMemo(() => new Set(favorites.map((f) => f.job_number)), [favorites]);

  const apply = useCallback(
    (promise) => {
      const seq = (seqRef.current += 1);
      promise
        .then((data) => {
          if (seq !== seqRef.current) return;
          setFavorites(data?.favorites || []);
          setError(null);
        })
        .catch((err) => {
          if (seq !== seqRef.current) return;
          setError(err);
          reload();
        });
    },
    [reload],
  );

  /** `job` needs a `job_number`; the rest is used for the optimistic row. */
  const toggle = useCallback(
    (job) => {
      const jobNumber = job?.job_number;
      if (!jobNumber) return;
      const saved = favorites.some((f) => f.job_number === jobNumber);

      setFavorites((current) => {
        if (saved) return current.filter((f) => f.job_number !== jobNumber);
        // The list is newest-first, so the new favorite goes right at the top.
        const row = {
          job_number: jobNumber,
          title: job.title || "",
          employer: job.employer || "",
          created_at: "",
          job,
        };
        return [row, ...current];
      });

      if (!saved) setPulseKey((k) => k + 1);
      apply(saved ? removeFavorite(jobNumber) : addFavorite(jobNumber));
    },
    [favorites, apply],
  );

  return { favorites, savedSet, pulseKey, toggle, error, reload };
}
