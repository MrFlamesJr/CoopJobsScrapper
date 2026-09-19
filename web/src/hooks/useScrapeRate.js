import { useEffect, useRef, useState } from "react";

// How far back "recent" looks, and how many saved jobs it takes for the
// blend to fully trust the whole-run average over that recent window.
const RECENT_WINDOW_MS = 45000;
const BLEND_SATURATION = 40;

function safeRate(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The `done` count recorded at or before time `t`, or 0 before the first sample. */
function doneAtOrBefore(samples, t) {
  let value = 0;
  for (const sample of samples) {
    if (sample.t > t) break;
    value = sample.done;
  }
  return value;
}

/**
 * Pure rate maths: no React, no `Date.now()` inside, so it can be replayed
 * from a plain node script. `samples` is `[{ t, done }]` in time order,
 * `now` and `estimatedJobs` are numbers (ms epoch / job count, the latter
 * nullable). Every rate is jobs per second; never negative, NaN or Infinite.
 */
export function computeRate(samples, now, estimatedJobs) {
  if (!samples || samples.length === 0) {
    return { average: 0, recent: 0, blended: 0, timeLeftSeconds: null, sampleCount: 0 };
  }

  // The clock starts at the first sample, not at `started_at`: the login
  // wait shouldn't count against the run's average speed. `done0` is the
  // count already reached at that moment — e.g. after a page reload mid-scrape
  // the first sample can already read `done: 120`, and none of that is work
  // "observed" during the measured window, so every rate below is relative
  // to `done0`, never to 0.
  const t0 = samples[0].t;
  const done0 = samples[0].done;
  const doneNow = samples[samples.length - 1].done;
  const elapsed = Math.max((now - t0) / 1000, 0.001);
  const observed = doneNow - done0;
  const average = safeRate(observed / elapsed);

  const windowStart = Math.max(t0, now - RECENT_WINDOW_MS);
  const doneAtWindowStart = windowStart <= t0 ? done0 : doneAtOrBefore(samples, windowStart);
  const recentElapsed = Math.max((now - windowStart) / 1000, 0.001);
  const recent = safeRate((doneNow - doneAtWindowStart) / recentElapsed);

  // More history -> lean on the steadier whole-run average; early on, the
  // recent window is all there is.
  const w = Math.min(1, observed / BLEND_SATURATION);
  const blended = safeRate(w * average + (1 - w) * recent);

  let timeLeftSeconds = null;
  if (Number.isFinite(estimatedJobs) && blended > 0) {
    const remaining = Math.max(0, estimatedJobs - doneNow);
    const seconds = remaining / blended;
    if (Number.isFinite(seconds)) timeLeftSeconds = Math.max(0, seconds);
  }

  return { average, recent, blended, timeLeftSeconds, sampleCount: samples.length };
}

function formatRateValue(perSecond) {
  if (perSecond >= 1) return `${Math.round(perSecond * 10) / 10} jobs/s`;
  const perMinute = Math.round(perSecond * 60);
  return `${perMinute} ${perMinute === 1 ? "job" : "jobs"}/min`;
}

function formatMinutes(seconds) {
  if (seconds < 30) return "<1 min";
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Turns a `computeRate` result into the two strings the dialog shows. The
 * displayed speed is `recent` (last 45s) per the plan — `blended` only
 * feeds the time-left estimate, which stays steadier across a stall.
 */
export function formatRate({ recent, timeLeftSeconds, sampleCount }) {
  if (sampleCount < 3) return { rateText: "measuring…", timeLeftText: "" };
  const rateText = formatRateValue(recent);
  if (timeLeftSeconds == null) return { rateText, timeLeftText: "" };
  // Under 16 samples there isn't much history behind the estimate yet.
  const approx = sampleCount <= 15;
  return { rateText, timeLeftText: `${approx ? "~" : ""}${formatMinutes(timeLeftSeconds)} left` };
}

/**
 * Thin wrapper around `computeRate`: records a `{t, done}` sample whenever
 * `jobs_saved + failed + duplicates` changes during `scraping`, and ticks
 * once a second so "time left" counts down even between samples (e.g.
 * during a stall). Samples reset when a fresh run begins ("starting"), so
 * the finished run's numbers stay put for the report that follows it.
 */
export default function useScrapeRate(status) {
  const samplesRef = useRef([]);
  const lastDoneRef = useRef(null);
  const [, forceTick] = useState(0);

  const state = status?.state || "idle";
  const done = (status?.jobs_saved ?? 0) + (status?.failed ?? 0) + (status?.duplicates ?? 0);

  useEffect(() => {
    if (state === "starting") {
      samplesRef.current = [];
      lastDoneRef.current = null;
    }
  }, [state]);

  useEffect(() => {
    if (state !== "scraping" || lastDoneRef.current === done) return;
    lastDoneRef.current = done;
    samplesRef.current = [...samplesRef.current, { t: Date.now(), done }];
  }, [state, done]);

  useEffect(() => {
    if (state !== "scraping") return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  const samples = samplesRef.current;
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      average: 0,
      blended: 0,
      timeLeftSeconds: null,
      rateText: "",
      timeLeftText: "",
      averageText: "",
    };
  }

  const result = computeRate(samples, Date.now(), status?.estimated_jobs ?? null);
  const { rateText, timeLeftText } = formatRate(result);
  const averageText = result.sampleCount >= 3 ? formatRateValue(result.average) : "";
  return { ...result, rateText, timeLeftText, averageText };
}
