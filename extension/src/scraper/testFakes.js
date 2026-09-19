// Shared test fakes for pager.test.js / portal.panelMatching.test.js /
// portal.retry.test.js -- the JS equivalents of the fakes each Python test
// module defines locally (no shared conftest fixtures are used by those
// three Python files beyond pytest's own `monkeypatch`/`caplog`).

/**
 * A clock with virtual time: `sleep(ms)` advances `now()` by `ms` and only
 * yields a microtask (no real timer), so a test can configure
 * minutes-long timeouts (e.g. PAGE_READY_TIMEOUT_MS) and still run
 * instantly. Mirrors what the ported Selenium tests got for free by not
 * calling `time.sleep` themselves (WebDriverWait was always faked out at a
 * higher level); JobPortalScraper's waitUntil/panel-poll loops need a real
 * `clock` object to have a deadline to advance past.
 */
export class FakeClock {
  constructor(start = 0) {
    this.time = start;
  }

  now() {
    return this.time;
  }

  async sleep(ms) {
    this.time += ms;
    await Promise.resolve();
  }
}

export const neverCancelled = () => false;
