import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchRatings, setJobRating } from "../api.js";

/**
 * The ratings list (thumbs up/down), with optimistic set/clear.
 *
 * Every endpoint returns the full fresh list, so state is replaced from the
 * response; on an error we refetch to throw the optimistic guess away.
 * Refetches when `refreshKey` changes (after a scrape or a delete), so
 * re-linked and "no longer listed" rows update.
 */
export function useRatings(refreshKey) {
  const [ratings, setRatings] = useState([]);
  const [error, setError] = useState(null);
  // Bumped only when a like is added, so the Ratings button in TopBar can replay its pulse.
  const [pulseKey, setPulseKey] = useState(0);
  // Two fast clicks on a thumb are two requests: only the answer to the
  // newest one may replace the list.
  const seqRef = useRef(0);

  const reload = useCallback(() => {
    const controller = new AbortController();
    const seq = (seqRef.current += 1);
    fetchRatings(controller.signal)
      .then((data) => {
        if (seq !== seqRef.current) return;
        setRatings(data?.ratings || []);
        setError(null);
      })
      .catch((err) => {
        if (err.name !== "AbortError" && seq === seqRef.current) setError(err);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => reload(), [reload, refreshKey]);

  const ratingMap = useMemo(() => new Map(ratings.map((r) => [r.job_number, r.rating])), [ratings]);
  // These back the top bar's stats, and `r.job` is checked because a rating
  // for a job that is no longer scraped must not count toward the triage
  // total (the same rule `ratingCounts` encodes in web/src/db/queries.js).
  const likedCount = useMemo(() => ratings.filter((r) => r.job && r.rating === 1).length, [ratings]);
  const dislikedCount = useMemo(() => ratings.filter((r) => r.job && r.rating === -1).length, [ratings]);

  const apply = useCallback(
    (promise) => {
      const seq = (seqRef.current += 1);
      // Returned, so a caller can wait for the write to land before
      // refetching the grid (see App.jsx: a rating filter hides the job the
      // click just changed).
      return promise
        .then((data) => {
          if (seq !== seqRef.current) return;
          setRatings(data?.ratings || []);
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

  /** `job` needs a `job_number`; the rest is used for the optimistic row.
   * Clicking the same rating again clears it (sends 0). */
  const setRating = useCallback(
    (job, rating) => {
      const jobNumber = job?.job_number;
      if (!jobNumber) return Promise.resolve();
      const current = ratingMap.get(jobNumber);
      const next = current === rating ? 0 : rating;

      setRatings((currentList) => {
        const rest = currentList.filter((r) => r.job_number !== jobNumber);
        if (next === 0) return rest;
        // The list is newest-first, so the new/updated rating goes right at the top.
        const row = {
          job_number: jobNumber,
          title: job.title || "",
          employer: job.employer || "",
          rating: next,
          created_at: "",
          job,
        };
        return [row, ...rest];
      });

      if (next === 1 && current !== 1) setPulseKey((k) => k + 1);
      return apply(setJobRating(jobNumber, next));
    },
    [ratingMap, apply],
  );

  return { ratings, ratingMap, likedCount, dislikedCount, setRating, pulseKey, error, reload };
}
