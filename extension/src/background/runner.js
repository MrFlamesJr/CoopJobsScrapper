// Port of app/scraper/runner.py's ScrapeRunner as a plain state machine, with
// no chrome.* dependency at all (that lives in ./index.js, the service
// worker that wires this class to chrome.windows/tabs/storage/runtime.ports).
// This split is what makes the class unit-testable with an in-memory fake
// storage and transport, the same way test_runner.py drives ScrapeRunner
// directly against a FakeScraper.
//
// Execution-model mapping from the Python original:
//   * There is no worker thread here -- the "worker" is the portal content
//     script (src/content/portal.js), running JobPortalScraper in its own
//     execution context and reporting back over a chrome.runtime.Port. This
//     class only reacts to that reporting, via the handle*() methods below,
//     which stand in for runner.py's on_ready/on_event/on_page callbacks and
//     the tail of `_run`'s try/except.
//   * threading.Condition + wait_for_change() (used by the old SSE stream) is
//     replaced by subscribe(listener): every bump() calls every subscriber
//     with the fresh snapshot, which is what index.js uses to push status to
//     bridge ports, and what runner.test.js uses in place of wait_for_change.
//   * db.set_last_run has no equivalent here: this class has no access to the
//     SQLite database (that lives in the *web app's* worker, a different
//     origin entirely). Writing `last_run` is web/src/api.js's job now (see
//     its startScraper/subscribe wiring) -- this class only tracks its own
//     in-memory + chrome.storage-persisted status.
//   * Saving a scraped job is no longer synchronous (save_job in Python ran
//     on the same thread against the same sqlite connection). Each `scraped`
//     event instead becomes a persistent outbox entry handed to `transport`;
//     the jobs_saved counter and the "saved"/"could not be saved" log line
//     are only written once ack() is called for that entry -- see the module
//     docstring in the phase-5 porting brief.

// "cancelling" counts as running: a new scrape (or a re-check that the
// outbox is empty) stays blocked until the run actually reaches "cancelled".
export const RUNNING_STATES = new Set(["starting", "waiting_for_login", "scraping", "cancelling"]);

// How many lines of the human-readable activity log are kept (oldest dropped).
export const EVENT_LOG_MAX = 200;

// Level for the `events` log, per portal event type; anything else is "info".
const EVENT_LEVELS = { retry: "warn", skipped: "error" };

// Kept verbatim from Python's _BROWSER_CLOSED_MARKERS for parity, in case an
// error message (rather than a dedicated error name) is what reports a
// closed tab -- see handleError().
const BROWSER_CLOSED_MARKERS = [
  "invalid session id",
  "not connected to devtools",
  "target window already closed",
  "no such window",
  "connection refused",
  "browser window was closed",
  "extension context invalidated",
  "could not establish connection",
  "receiving end does not exist",
];

const DEFAULT_STORAGE_KEY = "coopjobs.scraper.runner";

export class ScraperError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScraperError";
    this.code = "scraper_error";
  }
}

export class AlreadyRunning extends ScraperError {
  constructor(message) {
    super(message);
    this.name = "AlreadyRunning";
    this.code = "already_running";
  }
}

export class OutboxNotEmpty extends ScraperError {
  constructor(message) {
    super(message);
    this.name = "OutboxNotEmpty";
    this.code = "outbox_not_empty";
  }
}

function now() {
  return new Date().toISOString();
}

function isBrowserClosedMessage(message) {
  const text = String(message || "").toLowerCase();
  return BROWSER_CLOSED_MARKERS.some((marker) => text.includes(marker));
}

/** One short, readable line for the `events` log -- verbatim port of
 * runner.py's _event_message, including never mentioning the job dict. */
export function eventMessage(event, saveError = "") {
  const kind = event.type || "";
  const where = `p${event.page} · ${event.index}/${event.total} · ${event.title || ""}`;
  if (kind === "pages_found") {
    const totalPages = event.total_pages;
    if (totalPages === null || totalPages === undefined) {
      return "Could not read the portal's page count; scraping anyway.";
    }
    return `Found ${totalPages} page(s), ${event.cards_per_page || 0} job(s) per page.`;
  }
  if (kind === "page") {
    const lastPage = event.last_page;
    return `Scraping page ${event.page}` + (lastPage ? ` of ${lastPage}.` : ".");
  }
  if (kind === "retry_pass") {
    return `Retrying ${event.cards} skipped card(s) across ${event.pages} page(s).`;
  }
  if (kind === "scraped") {
    if (saveError) return `${where}: could not be saved (${String(saveError).slice(0, 120)}).`;
    return `${where}: saved.`;
  }
  if (kind === "retry") {
    return `${where}: retry ${event.attempt} (${String(event.reason || "").slice(0, 120)}).`;
  }
  if (kind === "skipped") {
    return `${where}: skipped (${String(event.reason || "").slice(0, 120)}).`;
  }
  return kind || "event";
}

export class ScrapeRunner {
  /**
   * @param {object} [options]
   * @param {{get(keys):Promise<object>, set(items):Promise<void>}} [options.storage]
   *   chrome.storage.local-shaped; omit for a runner that persists nothing
   *   (used by most unit tests).
   * @param {{sendJob(entry):void}} [options.transport] Handed each outbox
   *   entry as it is enqueued -- index.js's implementation forwards it down
   *   the bridge port; tests use a fake that just records calls.
   * @param {string} [options.storageKey]
   */
  constructor({ storage = null, transport = null, storageKey = DEFAULT_STORAGE_KEY } = {}) {
    this.storage = storage;
    this.transport = transport;
    this._storageKey = storageKey;

    this._version = 0;
    this._status = ScrapeRunner._initialStatus();
    this._outbox = [];
    this._nextSeq = 0;
    this._cancelRequested = false;
    this._listeners = new Set();
    this._persistChain = Promise.resolve();

    // Restored asynchronously (chrome.storage is always async, even for a
    // service worker that was just woken up). Callers that care -- index.js,
    // and any test exercising restore-from-storage -- `await runner.ready`.
    this.ready = this._restore();
  }

  static _initialStatus() {
    return {
      state: "idle",
      message: "",
      pages_completed: 0,
      jobs_saved: 0,
      cards_seen: 0,
      duplicates: 0,
      failed: 0,
      failed_jobs: [],
      duplicate_jobs: [],
      anomalies: 0,
      retries: 0,
      retry_events: [],
      current: null,
      total_pages: null,
      estimated_jobs: null,
      events: [],
      error: null,
      reason: null,
      started_at: null,
      finished_at: null,
    };
  }

  get isRunning() {
    return RUNNING_STATES.has(this._status.state);
  }

  /** JSON-serialisable snapshot, including the current version and the
   * outbox (so index.js can push both to a freshly (re)connected bridge
   * port in one message -- see the protocol notes in index.js). */
  status() {
    return { ...this._status, events: [...this._status.events], version: this._version, outbox: [...this._outbox] };
  }

  /** Replaces wait_for_change()/SSE: `listener(snapshot)` fires on every
   * bump. Returns an unsubscribe function. */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Test/shutdown hook: resolves once the latest persist() has landed. */
  async flush() {
    await this._persistChain;
  }

  // -- persistence --------------------------------------------------------

  async _restore() {
    if (!this.storage) return;
    let data;
    try {
      data = await this.storage.get(this._storageKey);
    } catch {
      return; // a storage read failing must never crash construction
    }
    const saved = data && data[this._storageKey];
    if (!saved) return;
    const { events = [], version = 0, ...rest } = saved.status || {};
    this._status = { ...ScrapeRunner._initialStatus(), ...rest, events };
    this._version = version;
    this._outbox = Array.isArray(saved.outbox) ? saved.outbox : [];
    this._nextSeq = saved.nextSeq || 0;
  }

  _persist() {
    if (!this.storage) return;
    const payload = { status: this.status(), outbox: this._outbox, nextSeq: this._nextSeq };
    delete payload.status.outbox; // stored separately, avoid duplicating it
    // Chained (not fire-and-forget in parallel) so writes land in order even
    // if the caller doesn't await; a failing write is logged, never thrown.
    this._persistChain = this._persistChain
      .then(() => this.storage.set({ [this._storageKey]: payload }))
      .catch((exc) => console.warn("[CoopJobs] could not persist scraper status:", exc));
  }

  _bump() {
    this._version += 1;
    this._persist();
    const snapshot = this.status();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (exc) {
        console.warn("[CoopJobs] scraper status subscriber threw:", exc);
      }
    }
  }

  _appendEvent(message, level = "info") {
    this._status.events.push({ time: now(), level, message });
    if (this._status.events.length > EVENT_LOG_MAX) {
      this._status.events.splice(0, this._status.events.length - EVENT_LOG_MAX);
    }
  }

  /** Like runner.py's _update: patch fields, bump, no log line. */
  update(fields) {
    Object.assign(this._status, fields);
    this._bump();
  }

  /** Port of runner.py's _set_state. */
  _setState(state, message, { level = "info", ...fields } = {}) {
    if (RUNNING_STATES.has(state) && this._status.state === "cancelling") {
      // An abort is already under way; a running state arriving late must
      // not undo it. Terminal states always apply -- that is how a run ends.
      return;
    }
    Object.assign(this._status, { state, message, ...fields });
    if (!RUNNING_STATES.has(state)) this._status.current = null;
    this._appendEvent(message, level);
    this._bump();
  }

  // -- lifecycle ------------------------------------------------------------

  /** Refused when a run is active, or when unacknowledged jobs from a prior
   * run are still in the outbox (draining those takes priority). The
   * database-not-empty check lives on the web side (see extensionBridge.js /
   * api.js), which is the only side with access to the SQLite database. */
  start() {
    if (this.isRunning) {
      throw new AlreadyRunning("A scrape is already running.");
    }
    if (this._outbox.length > 0) {
      throw new OutboxNotEmpty("Jobs from the previous run are still being delivered.");
    }
    this._cancelRequested = false;
    this._status = ScrapeRunner._initialStatus();
    this._status.state = "starting";
    this._status.message = "Starting the scraper browser.";
    this._status.started_at = now();
    this._appendEvent(this._status.message);
    this._bump();
    return this.status();
  }

  /** Called once the service worker has opened the portal window/tab and a
   * port to its content script exists -- the equivalent of the Python worker
   * thread reaching its first _set_state("waiting_for_login", ...) call. */
  markWaitingForLogin() {
    this._setState("waiting_for_login", "Log in to the portal in the browser window that opened.");
  }

  /** Port of runner.py's cancel(). Quitting the actual browser/tab is
   * index.js's job (it owns the chrome.tabs/windows APIs); this only flips
   * the state so every reader -- including a stale response racing the
   * worker -- already sees "cancelling". */
  cancel() {
    this._cancelRequested = true;
    if (RUNNING_STATES.has(this._status.state)) {
      this._setState("cancelling", "Aborting the scrape.", { level: "warn" });
    }
    return this.status();
  }

  /** Wipes a finished run's report (last_run/finished_at/counters/events),
   * called when the web app deletes all jobs so a stale "Scrape complete"
   * report doesn't survive an empty database. Refused while a scrape is
   * actually in flight -- there is nothing to reset yet, and clearing state
   * out from under a running scraper would corrupt its accounting. */
  reset() {
    if (this.isRunning) return this.status();
    this._status = ScrapeRunner._initialStatus();
    // The outbox and _nextSeq are persisted and restored together with
    // _status (see _persist/_restore), and status() rides the outbox along
    // in every snapshot the web app drains on connect. Clearing _status
    // alone would leave unacknowledged jobs from the wiped-out run sitting
    // in the outbox, ready to be re-inserted into the database the user
    // just emptied -- so both must be cleared in the same breath.
    this._outbox = [];
    // Resetting _nextSeq to 0 is only safe because the outbox is emptied
    // right above: with no old entries left, no future seq can collide
    // with one still in flight. These two lines look independent but
    // are not -- don't reset one without the other.
    this._nextSeq = 0;
    this._bump();
    return this.status();
  }

  // -- reporting from the portal content script ----------------------------

  /** Port of runner.py's on_ready. */
  handleReady() {
    this._setState("scraping", "Portal login detected. Scraping jobs now.");
  }

  _applyAccounting(accounting = {}) {
    if (!accounting) return;
    if ("cardsSeen" in accounting) this._status.cards_seen = accounting.cardsSeen;
    if ("duplicates" in accounting) this._status.duplicates = accounting.duplicates;
    if ("failed" in accounting) this._status.failed = accounting.failed;
    if ("failedJobs" in accounting) this._status.failed_jobs = accounting.failedJobs.slice(0, 50);
    if ("duplicateJobs" in accounting) this._status.duplicate_jobs = accounting.duplicateJobs.slice(0, 50);
  }

  /** Port of runner.py's on_event. `accounting` is the scraper's own
   * cardsSeen/duplicates/failed/failedJobs counters as read by the content
   * script in the same tick it built `event` -- the equivalent of Python's
   * sync_accounting(), which could read scraper.* directly because runner.py
   * and JobPortalScraper shared a thread; here they don't, so the content
   * script (the only side that still holds the live scraper instance) sends
   * a fresh snapshot with every event instead. */
  handleEvent(event, accounting = {}) {
    const kind = event.type || "";
    this._applyAccounting(accounting);

    if (kind === "pages_found") {
      const totalPages = event.total_pages ?? null;
      const cardsPerPage = event.cards_per_page || 0;
      this._status.total_pages = totalPages;
      this._status.estimated_jobs = totalPages && cardsPerPage ? totalPages * cardsPerPage : null;
    } else if (kind === "card") {
      this._status.current = {
        page: event.page,
        index: event.index,
        total: event.total,
        title: event.title || "",
      };
    } else if (kind === "scraped" && event.job) {
      this._enqueueOutboxEntry(event);
      this._bump(); // accounting/outbox changed even though nothing is logged yet
      return;
    } else if (kind === "retry") {
      this._status.retries += 1;
      const msg = eventMessage(event);
      this._status.retry_events.push(msg);
      if (this._status.retry_events.length > 50) {
        this._status.retry_events.splice(0, this._status.retry_events.length - 50);
      }
    }

    if (kind !== "card") {
      const level = EVENT_LEVELS[kind] || "info";
      this._appendEvent(eventMessage(event), level);
    }
    this._bump();
  }

  /** Port of runner.py's on_page: counters and the status message only --
   * jobs were already written by their own `scraped` events (main sweep and
   * retry pass alike), so this never touches jobs_saved or the outbox. */
  handlePage(pageNumber, jobsCount, accounting = {}) {
    this._applyAccounting(accounting);
    this._status.pages_completed += 1;
    this._status.message = `Finished page ${pageNumber} (${jobsCount} job(s)).`;
    this._bump();
  }

  /** Port of the tail of runner.py's _run try block: the scraper's run()
   * resolved without throwing. `failedJobs` must be the FINAL, post-retry
   * list (JobPortalScraper.failed after run() returns) -- see the module
   * docstring in portal.js and runner.py alike. */
  handleFinished({ cardsSeen = 0, duplicates = 0, failedJobs = [], duplicateJobs = [] } = {}) {
    const cappedFailedJobs = failedJobs.slice(0, 50);
    const cappedDuplicateJobs = duplicateJobs.slice(0, 50);
    const jobsSaved = this._status.jobs_saved;
    this._setState(
      "completed",
      `Saved ${jobsSaved} of ${cardsSeen} jobs (${duplicates} duplicates, ${failedJobs.length} failed).`,
      {
        cards_seen: cardsSeen,
        duplicates,
        failed: failedJobs.length,
        failed_jobs: cappedFailedJobs,
        duplicate_jobs: cappedDuplicateJobs,
        anomalies: failedJobs.length,
        finished_at: now(),
      },
    );
  }

  /** Port of runner.py's except Cancelled / except (BrowserClosed, ...) /
   * except Exception cascade. `name` is the JS error class name the content
   * script's `finished`-with-error message carries (Cancelled, TabClosed, or
   * anything else); `message` is its .message. */
  // `reason` is a machine-readable companion to `message`, so the UI (and
  // tests) don't have to string-match "Browser window was closed." to tell
  // a real cancel apart from a closed tab.
  handleError({ name = "", message = "" } = {}) {
    if (name === "Cancelled" || this._cancelRequested) {
      this._setState("cancelled", "Scrape was cancelled.", {
        level: "warn",
        reason: "user_cancelled",
        finished_at: now(),
      });
      return;
    }
    if (name === "TabClosed" || isBrowserClosedMessage(message)) {
      this._setState("cancelled", "Browser window was closed.", {
        level: "warn",
        reason: "browser_closed",
        finished_at: now(),
      });
      return;
    }
    this._setState("failed", message, { level: "error", error: message, reason: "failed", finished_at: now() });
  }

  /** Called by index.js when chrome.tabs.onRemoved (or a port disconnect)
   * fires for the tracked portal tab while a run is active -- there is no
   * content-script message at all in that case, since the tab is gone. */
  handleTabClosed() {
    if (!RUNNING_STATES.has(this._status.state)) return;
    this.handleError({ name: "TabClosed", message: "Browser window was closed." });
  }

  // -- outbox: jobs in flight to the web app's database --------------------

  _enqueueOutboxEntry(event) {
    const seq = this._nextSeq;
    this._nextSeq += 1;
    const entry = {
      seq,
      job: event.job,
      page: event.page,
      index: event.index,
      total: event.total,
      title: event.title || "",
    };
    this._outbox.push(entry);
    this._sendToTransport(entry);
  }

  _sendToTransport(entry) {
    if (!this.transport) return;
    try {
      this.transport.sendJob(entry);
    } catch (exc) {
      console.warn("[CoopJobs] could not hand a scraped job to the transport:", exc);
    }
  }

  /** Re-sends every still-unacknowledged outbox entry, in order -- called by
   * index.js once a bridge port (re)connects, draining what built up while
   * the web app tab was closed or unreachable. */
  resendOutbox() {
    for (const entry of this._outbox) this._sendToTransport(entry);
  }

  outbox() {
    return [...this._outbox];
  }

  /** The web app's ack for one outbox entry: `{inserted, error}`, the same
   * accounting runner.py's save_job produced synchronously. Unknown/already
   * -acked seqs are a silent no-op, since the web side also dedupes by seq
   * and may re-ack after a reconnect. */
  ack(seq, { inserted = 0, error = "" } = {}) {
    const index = this._outbox.findIndex((entry) => entry.seq === seq);
    if (index === -1) return this.status();
    const [entry] = this._outbox.splice(index, 1);

    let saveError = "";
    if (error) saveError = error;
    else if (!inserted) saveError = "the database already has that job number";

    if (!saveError) this._status.jobs_saved += 1;
    const level = saveError ? "error" : "info";
    this._appendEvent(
      eventMessage(
        { type: "scraped", page: entry.page, index: entry.index, total: entry.total, title: entry.title },
        saveError,
      ),
      level,
    );
    this._bump();
    return this.status();
  }
}
