import { useCallback, useEffect, useRef, useState } from "react";
import { devLogStatus } from "../devLog.js";
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
    devLogStatus(data);
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

  // Like applyStatus, but replaces the entire status instead of merging.
  // Used by deleteAll to clear stale report fields (finished_at, jobs_saved,
  // pages_completed, etc.) that would otherwise persist from the previous run.
  // Keeps all the same bookkeeping: version check, ref tracking, error clear.
  const resetStatus = useCallback((data) => {
    devLogStatus(data);
    if (typeof data.version === "number") {
      if (data.version < lastVersionRef.current) return;
      lastVersionRef.current = data.version;
    }
    const prev = prevStateRef.current;
    prevStateRef.current = data.state;
    // Replaced, not merged: this is used to reset after deleteAll.
    setStatus(data);
    statusRef.current = data;
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
      // Still show the dialog (and the install steps) when the database
      // can't be read, instead of "Loading status…" forever.
      if (!statusRef.current) applyStatus({ state: "idle" });
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
    // The database facts don't depend on the extension: show them (as idle)
    // at once, so a missing or silent extension never leaves the dialog stuck
    // on "Loading status…". A snapshot from the extension overrides this.
    loadStatus();
    return () => {
      unsubscribeStatus();
      unsubscribeConnection();
    };
  }, [applyStatus, loadStatus]);

  const checkExtensionInstalled = useCallback(async () => {
    setExtension("checking");
    const result = await checkExtension();
    setExtension(!result.installed ? "missing" : result.outdated ? "outdated" : "ready");
    return result;
  }, []);

  useEffect(() => {
    checkExtensionInstalled();
  }, [checkExtensionInstalled]);

  // Recheck on window focus too: a tab left open through an extension
  // install/reload never got its content script until background/index.js's
  // injection (or the user leaving and coming back) runs, so re-probing when
  // the tab regains focus catches that without requiring a manual reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("focus", checkExtensionInstalled);
    return () => window.removeEventListener("focus", checkExtensionInstalled);
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

  const resetToIdle = useCallback(async () => {
    resetStatus(await refreshScraperStatus({ state: "idle" }));
  }, [resetStatus]);

  const deleteAll = useCallback(async () => {
    const result = await deleteAllJobs();
    // Deliberately not loadStatus(): refreshScraperStatus() does not ask the
    // extension for anything, it only re-enriches the status object it is
    // handed. Using resetStatus() instead of applyStatus() ensures the
    // finished run's report fields (finished_at, jobs_saved, retries, events)
    // are fully cleared, not merged over. deleteAllJobs() has already
    // waited for the extension's reset ack, so idle is the truth now; the
    // extension's next pushed snapshot (higher version) confirms it.
    await resetToIdle();
    return result;
  }, [resetToIdle]);

  return {
    status,
    error,
    connection,
    extension,
    recheckExtension: checkExtensionInstalled,
    start,
    cancel,
    deleteAll,
    resetToIdle,
    refresh: loadStatus,
    isRunning,
  };
}
