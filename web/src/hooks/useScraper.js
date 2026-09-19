import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelScraper,
  deleteAllJobs,
  fetchScraperStatus,
  startScraper,
  SCRAPER_STREAM_URL,
} from "../api.js";

// "cancelling" is still a run: the worker is unwinding and a new scrape can't
// start until it reaches "cancelled".
const RUNNING_STATES = new Set(["starting", "waiting_for_login", "scraping", "cancelling"]);

function isRunning(state) {
  return RUNNING_STATES.has(state);
}

/**
 * Single source of truth for scraper state. One EventSource stays open for the
 * life of the app: the server pushes the whole status object on every change,
 * so there is nothing to poll. `onFinished` fires once per run, when a running
 * state turns terminal.
 *
 * `connection` is "live" while the stream is connected and "reconnecting" while
 * EventSource is retrying (it reconnects on its own).
 */
export function useScraper({ onFinished } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [connection, setConnection] = useState("reconnecting");

  const prevStateRef = useRef(null);
  const lastVersionRef = useRef(-1);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  // Every snapshot goes through here, so the running -> finished transition is
  // detected exactly once no matter where the snapshot came from.
  const applyStatus = useCallback((data) => {
    // Snapshots can arrive out of order: a start/cancel response is built
    // before a stream message that overtakes it. `version` is monotonic, so an
    // older snapshot is dropped whole — state included. An equal version still
    // applies: clearing the jobs table changes job_count without bumping it.
    if (typeof data.version === "number") {
      if (data.version < lastVersionRef.current) return;
      lastVersionRef.current = data.version;
    }
    const prev = prevStateRef.current;
    prevStateRef.current = data.state;
    // Merged, because the runner's own responses (start/cancel) carry no
    // job_count / last_scraped_at: those keep the values the stream gave us.
    setStatus((current) => ({ ...current, ...data }));
    setError(null);
    if (prev && isRunning(prev) && !isRunning(data.state)) {
      onFinishedRef.current?.(data);
    }
  }, []);

  // Kept for the one-off refresh after deleteAll: clearing the table changes
  // job_count without any runner event, so the stream stays silent.
  const loadStatus = useCallback(async () => {
    try {
      applyStatus(await fetchScraperStatus());
    } catch (err) {
      setError(err);
    }
  }, [applyStatus]);

  useEffect(() => {
    const source = new EventSource(SCRAPER_STREAM_URL);
    source.onopen = () => {
      // A restarted server counts versions from 0 again, and a fresh
      // connection always opens with a full, authoritative snapshot.
      lastVersionRef.current = -1;
      setConnection("live");
    };
    source.onmessage = (event) => {
      setConnection("live");
      try {
        applyStatus(JSON.parse(event.data));
      } catch {
        // A truncated frame: the next message carries the full snapshot anyway.
      }
    };
    source.onerror = () => setConnection("reconnecting");
    return () => source.close();
  }, [applyStatus]);

  const start = useCallback(async () => {
    setError(null);
    const data = await startScraper();
    applyStatus(data);
    return data;
  }, [applyStatus]);

  const cancel = useCallback(async () => {
    const data = await cancelScraper();
    applyStatus(data);
    return data;
  }, [applyStatus]);

  const deleteAll = useCallback(async () => {
    const result = await deleteAllJobs();
    await loadStatus();
    return result;
  }, [loadStatus]);

  return { status, error, connection, start, cancel, deleteAll, refresh: loadStatus, isRunning };
}
