// Port of tests/test_runner.py, adapted to ScrapeRunner's message-driven
// shape (see runner.js's module docstring for the execution-model mapping).
//
// There is no worker thread to wait on any more: the Python tests' behaviour
// scripts (FakeScraper.run()'s "one_page"/"with_accounting"/etc.) are ported
// here as short call sequences against the runner's handle*() methods --
// exactly what index.js will do in response to real port messages from
// src/content/portal.js. Tests that only existed to synchronise with that
// worker thread (_wait_until_not_running, _wait_for_current_card) have no
// equivalent: every runner call below already applies synchronously.
//
// Tests intentionally NOT ported here (moved to the web side, which is the
// only side with database access now that scraping and storage are on
// different origins/processes):
//   - test_start_raises_when_database_not_empty: the "is the database empty"
//     check now happens in web/src/api.js's startScraper before it ever
//     calls the extension bridge (see api.js). ScrapeRunner has no database.
//   - test_last_run_*: `last_run` is written to the SQLite database by
//     web/src/api.js (setLastRun on start and on every terminal status), not
//     by this class. The terminal-status content those writes are built from
//     is exactly what test_completed_run_*/test_last_run_is_recorded_when_*
//     assert here under their new names (see "terminal status" tests below).

import { beforeEach, describe, expect, test, vi } from "vitest";
import { AlreadyRunning, OutboxNotEmpty, RUNNING_STATES, ScrapeRunner } from "./runner.js";

/** In-memory stand-in for chrome.storage.local. */
function makeFakeStorage(seed = {}) {
  const store = { ...seed };
  return {
    store,
    async get(key) {
      return { [key]: store[key] };
    },
    async set(items) {
      Object.assign(store, items);
    },
  };
}

function makeFakeTransport() {
  return { sent: [], sendJob(entry) { this.sent.push(entry); } };
}

function scrapedEvent(page, index, total, job) {
  return {
    type: "scraped",
    page,
    index,
    total,
    title: job.title || "",
    employer: job.employer || "",
    job_number: job.job_number || "",
    job,
  };
}

/** Drives a runner through start -> waiting_for_login -> scraping, the
 * common prefix of every "a run is in flight" test below. */
function startAndBeginScraping(runner) {
  runner.start();
  runner.markWaitingForLogin();
  runner.handleReady();
}

describe("ScrapeRunner", () => {
  let runner;
  let transport;

  beforeEach(() => {
    transport = makeFakeTransport();
    runner = new ScrapeRunner({ transport });
  });

  test("test_start_raises_when_already_running", () => {
    runner.update({ state: "scraping" });
    expect(() => runner.start()).toThrow(AlreadyRunning);
  });

  test("test_start_refuses_when_outbox_is_not_empty", () => {
    startAndBeginScraping(runner);
    runner.handleEvent(scrapedEvent(1, 1, 1, { job_number: "J1", title: "Dev", employer: "Acme" }));
    runner.handleError({ name: "Cancelled" });
    expect(runner.status().outbox).toHaveLength(1);
    expect(() => runner.start()).toThrow(OutboxNotEmpty);
  });

  test("test_completed_run_saves_jobs_and_updates_status", () => {
    const status = runner.start();
    expect(["starting", "waiting_for_login", "scraping"]).toContain(status.state);
    runner.markWaitingForLogin();
    runner.handleReady();

    const job = { job_number: "J1", title: "Dev", employer: "Acme" };
    runner.handleEvent(scrapedEvent(1, 1, 1, job));
    const [entry] = runner.outbox();
    runner.ack(entry.seq, { inserted: 1, error: "" });
    runner.handlePage(1, 1, { cardsSeen: 1, duplicates: 0, failed: 0, failedJobs: [] });
    runner.handleFinished({ cardsSeen: 1, duplicates: 0, failedJobs: [] });

    const final = runner.status();
    expect(final.state).toBe("completed");
    expect(final.pages_completed).toBe(1);
    expect(final.jobs_saved).toBe(1);
    expect(final.finished_at).not.toBeNull();
  });

  test("test_completed_run_exposes_accounting_fields", () => {
    // "anomalies" must equal the FINAL (post-retry) failed count, exactly the
    // value handleFinished is given -- not whatever an intermediate
    // handlePage call saw while pages were still in flight.
    startAndBeginScraping(runner);
    const job = { job_number: "J1", title: "Dev", employer: "Acme" };
    runner.handleEvent(scrapedEvent(1, 1, 3, job), { cardsSeen: 3, duplicates: 1, failed: 1, failedJobs: [] });
    const [entry] = runner.outbox();
    runner.ack(entry.seq, { inserted: 1 });
    runner.handlePage(1, 1, { cardsSeen: 3, duplicates: 1, failed: 1, failedJobs: [] });
    const failedJobs = [{ page: 2, title: "Data Analyst Intern", employer: "Acme" }];
    runner.handleFinished({ cardsSeen: 3, duplicates: 1, failedJobs });

    const final = runner.status();
    expect(final.cards_seen).toBe(3);
    expect(final.duplicates).toBe(1);
    expect(final.failed).toBe(1);
    expect(final.failed_jobs).toEqual(failedJobs);
    expect(final.anomalies).toBe(1);
    expect(final.message).toBe("Saved 1 of 3 jobs (1 duplicates, 1 failed).");
  });

  test("test_failed_jobs_list_is_capped_at_50", () => {
    startAndBeginScraping(runner);
    const failedJobs = Array.from({ length: 75 }, (_, i) => ({ page: 1, title: `Job ${i}`, employer: "Acme" }));
    runner.handleFinished({ cardsSeen: 75, duplicates: 0, failedJobs });

    const final = runner.status();
    expect(final.failed).toBe(75);
    expect(final.failed_jobs).toHaveLength(50);
  });

  test("test_duplicate_jobs_list_is_capped_at_50", () => {
    startAndBeginScraping(runner);
    const duplicateJobs = Array.from({ length: 75 }, (_, i) => ({ page: 1, title: `Job ${i}`, employer: "Acme", job_number: `J${i}` }));
    runner.handleFinished({ cardsSeen: 75, duplicates: 75, failedJobs: [], duplicateJobs });

    const final = runner.status();
    expect(final.duplicates).toBe(75);
    expect(final.duplicate_jobs).toHaveLength(50);
  });

  test("test_retry_events_are_collected_and_capped_at_50", () => {
    startAndBeginScraping(runner);
    for (let i = 0; i < 60; i += 1) {
      runner.handleEvent({
        type: "retry",
        page: 1,
        index: 1,
        total: 10,
        title: `Job ${i}`,
      });
    }

    const final = runner.status();
    expect(final.retries).toBe(60);
    expect(final.retry_events).toHaveLength(50);
    // The first 10 retries are dropped (60 - 50), so the first retained event should be retry #10.
    expect(final.retry_events[0]).toContain("Job 10");
  });

  test("test_cancel_sets_state_to_cancelled", () => {
    startAndBeginScraping(runner);
    runner.handlePage(1, 1, {});
    runner.cancel();
    runner.handleError({ name: "Cancelled", message: "cancelled" });

    expect(runner.status().state).toBe("cancelled");
  });

  test("test_cancel_reports_cancelling_before_the_worker_has_unwound", () => {
    // The response to an abort must already say the scrape is being aborted
    // -- reaching "cancelled" is a later, separate handleError() call.
    startAndBeginScraping(runner);
    runner.handleEvent({ type: "card", page: 2, index: 5, total: 20, title: "Data Analyst" });

    const status = runner.cancel();

    expect(status.state).toBe("cancelling");
    expect(runner.isRunning).toBe(true); // still unwinding
    expect(status.current).not.toBeNull(); // the card being abandoned is still shown

    runner.handleError({ name: "Cancelled" });
    expect(runner.status().state).toBe("cancelled");
  });

  test("test_a_late_running_state_cannot_undo_cancelling", () => {
    // handleReady can fire just after cancel(); it must not put the state
    // back to "scraping".
    startAndBeginScraping(runner);
    runner.handleEvent({ type: "card", page: 2, index: 5, total: 20, title: "Data Analyst" });
    runner.cancel();
    runner.handleReady();

    expect(runner.status().state).toBe("cancelling");
    runner.handleError({ name: "Cancelled" });
    expect(runner.status().state).toBe("cancelled");
  });

  test("test_cancel_while_idle_leaves_the_state_alone", () => {
    const status = runner.cancel();

    expect(status.state).toBe("idle");
    expect(status.events).toEqual([]);
  });

  test("test_browser_closed_by_user_is_reported_as_cancelled", () => {
    startAndBeginScraping(runner);
    runner.handleError({ name: "TabClosed", message: "Browser window was closed." });

    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.message.toLowerCase()).toContain("closed");
  });

  test("test_browser_closed_message_without_dedicated_exception_type_is_cancelled", () => {
    startAndBeginScraping(runner);
    runner.handleError({
      name: "RuntimeError",
      message: "invalid session id: session deleted as the browser was closed",
    });

    expect(runner.status().state).toBe("cancelled");
  });

  test("test_unexpected_exception_is_reported_as_failed", () => {
    startAndBeginScraping(runner);
    runner.handleError({ name: "RuntimeError", message: "boom" });

    const status = runner.status();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("boom");
    expect(status.reason).toBe("failed");
  });

  test("a tab close reports reason browser_closed, an explicit cancel reports user_cancelled", () => {
    startAndBeginScraping(runner);
    runner.handleTabClosed();
    expect(runner.status().state).toBe("cancelled");
    expect(runner.status().reason).toBe("browser_closed");

    const cancelled = new ScrapeRunner({ transport: makeFakeTransport() });
    startAndBeginScraping(cancelled);
    cancelled.cancel();
    cancelled.handleError({ name: "Cancelled" });
    expect(cancelled.status().state).toBe("cancelled");
    expect(cancelled.status().reason).toBe("user_cancelled");
  });

  // -- Terminal status (last_run's source data; see the top-of-file note) --

  test("test_terminal_status_after_cancel_during_run_reports_pages_completed", () => {
    startAndBeginScraping(runner);
    runner.handlePage(1, 1, {});
    runner.cancel();
    runner.handleError({ name: "Cancelled" });

    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.pages_completed).toBe(1);
    expect(status.finished_at).not.toBeNull();
  });

  test("test_terminal_status_when_the_browser_never_opens_is_failed", () => {
    // driver_factory raising in Python became "the tab/window never opened";
    // index.js reports that the same way it reports any other startup
    // failure, via handleError.
    runner.start();
    runner.handleError({ name: "Error", message: "could not open the portal window" });

    expect(runner.status().state).toBe("failed");
  });

  // -- Live status: on_event, the activity log ------------------------------

  test("test_jobs_are_saved_when_scraped_events_arrive_not_by_on_page", () => {
    // Each job is enqueued to the outbox (and so counted) as soon as its
    // `scraped` event arrives; handlePage, which reports the same jobs again
    // at the end of a page (and again for the retry pass), must not enqueue
    // them a second time.
    startAndBeginScraping(runner);
    const jobs = [
      { job_number: "", title: "Unnumbered A", employer: "Acme" },
      { job_number: "", title: "Unnumbered B", employer: "Acme" },
    ];
    jobs.forEach((job, i) => runner.handleEvent(scrapedEvent(1, i + 1, 2, job)));
    runner.handlePage(1, 2, {});
    const retried = { job_number: "J9", title: "Recovered", employer: "Acme" };
    runner.handleEvent(scrapedEvent(2, 1, 1, retried));
    runner.handlePage(2, 1, {});

    expect(transport.sent).toHaveLength(3);
    for (const entry of runner.outbox()) runner.ack(entry.seq, { inserted: 1 });
    runner.handleFinished({ cardsSeen: 3, duplicates: 0, failedJobs: [] });

    const final = runner.status();
    expect(final.jobs_saved).toBe(3);
    expect(final.pages_completed).toBe(2);
    expect(final.outbox).toEqual([]);
  });

  test("test_events_track_progress_without_carrying_the_job_dict", () => {
    startAndBeginScraping(runner);
    runner.handleEvent({ type: "pages_found", total_pages: 39, cards_per_page: 20 });
    runner.handleEvent({ type: "page", page: 1, last_page: 39 });
    runner.handleEvent({ type: "card", page: 1, index: 5, total: 20, title: "Data Analyst" });
    runner.handleEvent({
      type: "retry", page: 1, index: 5, total: 20, title: "Data Analyst", attempt: 1, reason: "panel did not match",
    });
    const job = { job_number: "J5", title: "Data Analyst", employer: "Acme" };
    runner.handleEvent(scrapedEvent(1, 5, 20, job));
    runner.handleEvent({
      type: "skipped", page: 1, index: 6, total: 20, title: "Gone", employer: "Acme", reason: "timed out",
    });
    runner.handlePage(1, 1, {});
    const [entry] = runner.outbox();
    runner.ack(entry.seq, { inserted: 1 });
    runner.handleFinished({ cardsSeen: 20, duplicates: 0, failedJobs: [] });

    const final = runner.status();
    expect(final.total_pages).toBe(39);
    expect(final.estimated_jobs).toBe(39 * 20);
    expect(final.retries).toBe(1);
    expect(final.jobs_saved).toBe(1);
    // "current" follows the card events and is cleared once the run is over.
    expect(final.current).toBeNull();

    const events = final.events;
    expect(Array.isArray(events)).toBe(true);
    expect(events.every((event) => Object.keys(event).sort().join(",") === "level,message,time")).toBe(true);
    const levels = new Set(events.map((event) => event.level));
    expect(levels.has("info")).toBe(true);
    expect(levels.has("warn")).toBe(true);
    expect(levels.has("error")).toBe(true);
    const messages = events.map((event) => event.message);
    expect(messages.some((m) => m.includes("Found 39 page(s)"))).toBe(true);
    expect(messages.some((m) => m.includes("retry 1"))).toBe(true);
    expect(messages.some((m) => m.includes("skipped"))).toBe(true);
    // `card` updates `current` but must not spend a log line on every job.
    expect(messages.some((m) => m.endsWith(": saved."))).toBe(true);
    expect(messages.some((m) => m.includes("reading"))).toBe(false);
    expect(messages.some((m) => m === "Starting the scraper browser.")).toBe(true);
    expect(messages.some((m) => m.startsWith("Saved 1 of"))).toBe(true);
    expect(messages.every((m) => !m.includes("job_number"))).toBe(true);
  });

  test("test_current_card_is_reported_while_the_run_is_in_flight", () => {
    startAndBeginScraping(runner);
    runner.handleEvent({ type: "card", page: 2, index: 5, total: 20, title: "Data Analyst" });

    const current = runner.status().current;
    runner.cancel();
    runner.handleError({ name: "Cancelled" });

    expect(current).toEqual({ page: 2, index: 5, total: 20, title: "Data Analyst" });
  });

  test("test_card_events_update_current_and_the_version_without_logging_a_line", () => {
    const before = runner.status();
    startAndBeginScraping(runner);
    runner.handleEvent({ type: "card", page: 2, index: 5, total: 20, title: "Data Analyst" });
    const during = runner.status();
    runner.cancel();
    runner.handleError({ name: "Cancelled" });

    expect(during.current.title).toBe("Data Analyst");
    expect(during.version).toBeGreaterThan(before.version);
    expect(during.events.some((event) => event.message.includes("Data Analyst"))).toBe(false);
  });

  test("test_a_job_that_does_not_reach_the_database_is_logged_as_an_error", () => {
    // A `scraped` event whose ack reports nothing inserted must not be
    // counted or reported as saved -- the log says why instead.
    startAndBeginScraping(runner);
    const job = { job_number: "J1", title: "Dev", employer: "Acme" };
    runner.handleEvent(scrapedEvent(1, 1, 2, job));
    runner.handleEvent(scrapedEvent(1, 2, 2, { ...job, title: "Dev (again)" }));
    runner.handlePage(1, 2, {});
    const [first, second] = runner.outbox();
    runner.ack(first.seq, { inserted: 1 });
    runner.ack(second.seq, { inserted: 0 });
    runner.handleFinished({ cardsSeen: 2, duplicates: 0, failedJobs: [] });

    const final = runner.status();
    expect(final.jobs_saved).toBe(1);

    const failures = final.events.filter((event) => event.message.includes("could not be saved"));
    expect(failures).toHaveLength(1);
    expect(failures[0].level).toBe("error");
    expect(failures[0].message.startsWith("p1 · 2/2 · Dev (again): could not be saved (")).toBe(true);
  });

  test("test_events_log_is_capped", () => {
    startAndBeginScraping(runner);
    for (let index = 0; index < 250; index += 1) {
      runner.handleEvent({
        type: "retry", page: 1, index, total: 250, title: `Job ${index}`, attempt: 1, reason: "slow panel",
      });
    }

    expect(runner.status().events).toHaveLength(200);
  });

  test("test_status_is_json_serialisable", () => {
    startAndBeginScraping(runner);
    runner.handleEvent({ type: "pages_found", total_pages: 39, cards_per_page: 20 });
    runner.handleFinished({ cardsSeen: 0, duplicates: 0, failedJobs: [] });

    expect(() => JSON.stringify(runner.status())).not.toThrow();
  });

  // -- reset(): wipes a finished run's report -------------------------------

  test("reset clears a finished run's report and returns to idle", () => {
    startAndBeginScraping(runner);
    runner.handleFinished({ cardsSeen: 1, duplicates: 0, failedJobs: [] });
    expect(runner.status().state).toBe("completed");

    runner.reset();

    const status = runner.status();
    expect(status.state).toBe("idle");
    expect(status.finished_at).toBeNull();
    expect(status.jobs_saved).toBe(0);
    expect(status.pages_completed).toBe(0);
    expect(status.events).toEqual([]);
  });

  test("reset clears unacknowledged outbox entries and their counters", () => {
    // A stale outbox riding along in status() would get re-inserted into the
    // database the user just emptied by "delete all jobs" -- see the comment
    // in runner.js's reset().
    startAndBeginScraping(runner);
    runner.handleEvent(scrapedEvent(1, 1, 2, { job_number: "J1", title: "Dev", employer: "Acme" }));
    runner.handleEvent({
      type: "retry", page: 1, index: 2, total: 2, title: "Dev2", attempt: 1, reason: "slow panel",
    });
    runner.handleEvent(scrapedEvent(1, 2, 2, { job_number: "J2", title: "Dev2", employer: "Acme" }));
    runner.handlePage(1, 2, {});
    runner.handleFinished({ cardsSeen: 2, duplicates: 0, failedJobs: [] });
    expect(runner.status().outbox.length).toBeGreaterThan(0);

    runner.reset();

    const status = runner.status();
    expect(status.outbox).toEqual([]);
    expect(status.jobs_saved).toBe(0);
    expect(status.pages_completed).toBe(0);
    expect(status.retries).toBe(0);
    expect(status.events).toEqual([]);
  });

  test("reset is a no-op while a scrape is running", () => {
    startAndBeginScraping(runner);
    runner.handlePage(1, 1, {});

    const status = runner.reset();

    expect(status.state).toBe("scraping");
    expect(runner.status().pages_completed).toBe(1);
  });

  // -- subscribe(): replaces wait_for_change()/SSE --------------------------

  test("test_subscribe_is_notified_on_every_change", () => {
    const seen = [];
    runner.subscribe((snapshot) => seen.push(snapshot));

    runner.update({ message: "moved on" });

    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("moved on");
    expect(seen[0].version).toBe(runner.status().version);
  });

  test("test_unsubscribe_stops_notifications", () => {
    const listener = vi.fn();
    const unsubscribe = runner.subscribe(listener);
    unsubscribe();

    runner.update({ message: "moved on" });

    expect(listener).not.toHaveBeenCalled();
  });

  // -- outbox: ack / resend / restore ---------------------------------------

  test("outbox entries are hand to the transport as they are enqueued", () => {
    startAndBeginScraping(runner);
    const job = { job_number: "J1", title: "Dev", employer: "Acme" };
    runner.handleEvent(scrapedEvent(1, 1, 1, job));

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ seq: 0, job });
  });

  test("ack with an unknown seq is a silent no-op", () => {
    startAndBeginScraping(runner);
    expect(() => runner.ack(999, { inserted: 1 })).not.toThrow();
    expect(runner.status().jobs_saved).toBe(0);
  });

  test("acking the same seq twice only counts the job once", () => {
    startAndBeginScraping(runner);
    runner.handleEvent(scrapedEvent(1, 1, 1, { job_number: "J1", title: "Dev", employer: "Acme" }));
    const [entry] = runner.outbox();
    runner.ack(entry.seq, { inserted: 1 });
    runner.ack(entry.seq, { inserted: 1 }); // e.g. a duplicate ack after reconnecting

    expect(runner.status().jobs_saved).toBe(1);
  });

  test("resendOutbox re-sends every unacknowledged entry in order", () => {
    startAndBeginScraping(runner);
    const jobA = { job_number: "J1", title: "A", employer: "Acme" };
    const jobB = { job_number: "J2", title: "B", employer: "Acme" };
    runner.handleEvent(scrapedEvent(1, 1, 2, jobA));
    runner.handleEvent(scrapedEvent(1, 2, 2, jobB));
    transport.sent = []; // clear the initial sends

    runner.resendOutbox();

    expect(transport.sent.map((entry) => entry.job.job_number)).toEqual(["J1", "J2"]);
  });

  test("restore from storage brings back status and outbox after a restart", async () => {
    const storage = makeFakeStorage();
    const first = new ScrapeRunner({ storage, storageKey: "k" });
    await first.ready;
    startAndBeginScraping(first);
    first.handleEvent(scrapedEvent(1, 1, 1, { job_number: "J1", title: "Dev", employer: "Acme" }));
    await first.flush();

    const second = new ScrapeRunner({ storage, storageKey: "k" });
    await second.ready;

    expect(second.status().state).toBe("scraping");
    expect(second.outbox()).toHaveLength(1);
    expect(second.outbox()[0].job.job_number).toBe("J1");
    // The restored sequence counter must not collide with the entry already
    // in flight.
    second.handleEvent(scrapedEvent(1, 2, 2, { job_number: "J2", title: "Dev2", employer: "Acme" }));
    const seqs = second.outbox().map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(2);
  });

  test("a fresh runner with no storage starts idle with an empty outbox", () => {
    const fresh = new ScrapeRunner();
    expect(fresh.status().state).toBe("idle");
    expect(fresh.outbox()).toEqual([]);
    expect(RUNNING_STATES.has(fresh.status().state)).toBe(false);
  });

  // -- Terminal state assertions for window closing safety net --
  // These tests ensure the runner reaches terminal states via all paths,
  // so the index.js safety net subscriber (which closes the portal window
  // whenever a terminal state is reached) will catch every case.

  test("handleFinished() transitions to completed terminal state", () => {
    startAndBeginScraping(runner);
    runner.handleFinished({ cardsSeen: 0, duplicates: 0, failedJobs: [] });

    const status = runner.status();
    expect(status.state).toBe("completed");
    expect(status.finished_at).not.toBeNull();
  });

  test("handleError with Cancelled transitions to cancelled terminal state", () => {
    startAndBeginScraping(runner);
    runner.handleError({ name: "Cancelled" });

    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.reason).toBe("user_cancelled");
    expect(status.finished_at).not.toBeNull();
  });

  test("handleError with TabClosed transitions to cancelled terminal state", () => {
    startAndBeginScraping(runner);
    runner.handleError({ name: "TabClosed", message: "Browser window was closed." });

    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.reason).toBe("browser_closed");
    expect(status.finished_at).not.toBeNull();
  });

  test("handleError with browser closed message transitions to cancelled terminal state", () => {
    startAndBeginScraping(runner);
    runner.handleError({ name: "RuntimeError", message: "no such window" });

    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.reason).toBe("browser_closed");
    expect(status.finished_at).not.toBeNull();
  });

  test("handleError with unexpected error transitions to failed terminal state", () => {
    startAndBeginScraping(runner);
    runner.handleError({ name: "ScrapeError", message: "unexpected scraper failure" });

    const status = runner.status();
    expect(status.state).toBe("failed");
    expect(status.reason).toBe("failed");
    expect(status.error).toContain("unexpected scraper failure");
    expect(status.finished_at).not.toBeNull();
  });

  test("handleTabClosed() transitions to cancelled terminal state", () => {
    startAndBeginScraping(runner);
    runner.handleTabClosed();

    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.reason).toBe("browser_closed");
    expect(status.finished_at).not.toBeNull();
  });

  test("cancel() followed by handleError() transitions to cancelled terminal state", () => {
    startAndBeginScraping(runner);
    const cancelStatus = runner.cancel();
    expect(cancelStatus.state).toBe("cancelling");

    runner.handleError({ name: "Cancelled" });
    const status = runner.status();
    expect(status.state).toBe("cancelled");
    expect(status.reason).toBe("user_cancelled");
    expect(status.finished_at).not.toBeNull();
  });
});
