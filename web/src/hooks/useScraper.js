import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelScraper,
  deleteAllJobs,
  fetchScraperStatus,
  startScraper,
} from "../api.js";

const RUNNING_STATES = new Set(["starting", "waiting_for_login", "scraping"]);
const POLL_MS = 1000;

function isRunning(state) {
  return RUNNING_STATES.has(state);
}

/**
 * Single source of truth for scraper state. Fetches status on mount and
 * whenever `isOpen` flips true, polls every second while a run is active,
 * and calls `onFinished` once when a run transitions into a terminal state.
 */
export function useScraper({ isOpen, onFinished } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const prevStateRef = useRef(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchScraperStatus();
      const prev = prevStateRef.current;
      prevStateRef.current = data.state;
      setStatus(data);
      setError(null);
      if (prev && isRunning(prev) && !isRunning(data.state)) {
        onFinishedRef.current?.(data);
      }
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (isOpen) loadStatus();
  }, [isOpen, loadStatus]);

  const state = status?.state;
  useEffect(() => {
    if (!isRunning(state)) return undefined;
    const id = setInterval(loadStatus, POLL_MS);
    return () => clearInterval(id);
  }, [state, loadStatus]);

  const start = useCallback(async () => {
    setError(null);
    const data = await startScraper();
    prevStateRef.current = data.state;
    setStatus(data);
    return data;
  }, []);

  const cancel = useCallback(async () => {
    const data = await cancelScraper();
    prevStateRef.current = data.state;
    setStatus(data);
    return data;
  }, []);

  const deleteAll = useCallback(async () => {
    const result = await deleteAllJobs();
    await loadStatus();
    return result;
  }, [loadStatus]);

  return { status, error, start, cancel, deleteAll, refresh: loadStatus, isRunning };
}
