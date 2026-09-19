import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelScraper,
  checkExtension,
  deleteAllJobs,
  refreshScraperStatus,
  startScraper,
  subscribeScraperStatus,
} from "../api.js";
import { getExtensionBridge } from "../extensionBridge.js";

// "cancelling" is still a run: the worker is unwinding and a new scrape can't
// start until it reaches "cancelled".
const RUNNING_STATES = new Set(["starting", "waiting_for_login", "scraping", "cancelling"]);

function isRunning(state) {
  return RUNNING_STATES.has(state);
}

/**
 * Single source of truth for scraper state. Where this used to hold one
 * EventSource open for the life of the app, it now holds one subscription to
 * the CoopJobs extension's status stream (extensionBridge.js) -- the
 * extension pushes the whole status object on every change, exactly like the
 * server used to, so there is still nothing to poll. `onFinished` fires once
 * per run, when a running state turns terminal.
 *
 * `connection` is "live" while the extension's heartbeat is being heard and
 * "reconnecting" otherwise (extensionBridge.js flips it after ~20s of
 * silence, comfortably more than the extension's 15s heartbeat).
 *
 * `extension` is "checking" until the install/version probe resolves, then
 * "missing" (no pong within ~1s), "outdated" (pong, but protocolVersion is
 * behind), or "ready". Browsing jobs never depends on this -- only the
 * Scraper dialog does.
 */
export function useScraper({ onFinished } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [connection, setConnection] = useState("reconnecting");
  const [extension, setExtension] = useState("checking");

  const prevStateRef = useRef(null);
  const lastVersionRef = useRef(-1);
  const statusRef = useRef(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  // Every snapshot goes through here, so the running -> finished transition is
  // detected exactly once no matter where the snapshot came from.
  const applyStatus = useCallback((data) => {
    // Snapshots can arrive out of order: a start/cancel response is built
    // before a subscription message that overtakes it. `version` is
    // monotonic, so an older snapshot is dropped whole -- state included. An
    // equal version still applies: clearing the jobs table changes job_count
    // without bumping it.
    if (typeof data.version === "number") {
      if (data.version < lastVersionRef.current) return;
      lastVersionRef.current = data.version;
    }
    const prev = prevStateRef.current;
    prevStateRef.current = data.state;
    // Merged, because the runner's own responses (start/cancel) carry no
    // job_count / last_scraped_at: those keep the values the stream gave us.
    setStatus((current) => {
      const next = { ...current, ...data };
      statusRef.current = next;
      return next;
    });
    setError(null);
    if (prev && isRunning(prev) && !isRunning(data.state)) {
      onFinishedRef.current?.(data);
    }
  }, []);

  // Kept for the one-off refresh after deleteAll: clearing the table changes
  // job_count without any runner event, so the subscription stays silent.
  const loadStatus = useCallback(async () => {
    try {
      applyStatus(await refreshScraperStatus(statusRef.current));
    } catch (err) {
      setError(err);
    }
  }, [applyStatus]);

  useEffect(() => {
    // A fresh subscription always starts counting versions from -1 again,
    // matching the old "a restarted server counts from 0" reset on
    // EventSource open: the first snapshot the extension pushes on connect
    // is always full and authoritative.
    lastVersionRef.current = -1;
    const bridge = getExtensionBridge();
    const unsubscribeStatus = subscribeScraperStatus(applyStatus);
    const unsubscribeConnection = bridge.onConnectionChange(setConnection);
    setConnection(bridge.getConnectionState());
    bridge.requestStatus();
    return () => {
      unsubscribeStatus();
      unsubscribeConnection();
    };
  }, [applyStatus]);

  const checkExtensionInstalled = useCallback(async () => {
    setExtension("checking");
    const result = await checkExtension();
    setExtension(!result.installed ? "missing" : result.outdated ? "outdated" : "ready");
    return result;
  }, []);

  useEffect(() => {
    checkExtensionInstalled();
  }, [checkExtensionInstalled]);

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

  return {
    status,
    error,
    connection,
    extension,
    recheckExtension: checkExtensionInstalled,
    start,
    cancel,
    deleteAll,
    refresh: loadStatus,
    isRunning,
  };
}
