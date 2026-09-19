// extensionBridge.js is exercised with a fake `window` and a fake db client
// instead of a real extension/DOM (see createExtensionBridge's injectable
// `win`/`db`), so these run under the same Node test environment as the rest
// of web/'s Vitest suite. Focus: the outbox-ack dedupe contract from the
// phase-5 porting brief -- "dedupe by seq so re-sends are idempotent-safe
// (if seq already acked, ack again with the previous result)".

import { describe, expect, test, vi } from "vitest";
import { createExtensionBridge } from "./extensionBridge.js";

const ORIGIN = "https://coopjobs.example";

/** A minimal window stand-in: postMessage records what was sent, and
 * dispatch() lets the test simulate a message arriving from the extension's
 * bridge content script the way a real `message` event would. */
function makeFakeWindow() {
  const listeners = new Set();
  return {
    location: { origin: ORIGIN },
    posted: [],
    postMessage(data, targetOrigin) {
      this.posted.push({ data, targetOrigin });
    },
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
    dispatch(data, origin = ORIGIN) {
      const event = { source: this, origin, data };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function makeFakeDb({ insertResult = 1, insertError = null } = {}) {
  return {
    inserted: [],
    insertJobs(jobs) {
      this.inserted.push(...jobs);
      if (insertError) return Promise.reject(insertError);
      return Promise.resolve(insertResult);
    },
  };
}

describe("createExtensionBridge outbox handling", () => {
  test("a new outbox job is inserted once and acked with the insert result", async () => {
    const win = makeFakeWindow();
    const db = makeFakeDb({ insertResult: 1 });
    const bridge = createExtensionBridge({ win, db });
    bridge.subscribe(() => {});

    const job = { job_number: "J1", title: "Dev" };
    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", outbox: [{ seq: 0, job }] } });
    await vi.waitFor(() => expect(db.inserted).toHaveLength(1));

    expect(db.inserted).toEqual([job]);
    const acks = win.posted.filter((m) => m.data.type === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0].data).toMatchObject({ seq: 0, inserted: 1, error: "" });
  });

  test("re-sending the same seq before it resolves does not insert twice", async () => {
    const win = makeFakeWindow();
    let resolveInsert;
    const db = {
      inserted: [],
      insertJobs(jobs) {
        this.inserted.push(...jobs);
        return new Promise((resolve) => {
          resolveInsert = () => resolve(1);
        });
      },
    };
    const bridge = createExtensionBridge({ win, db });
    bridge.subscribe(() => {});

    const job = { job_number: "J1", title: "Dev" };
    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", outbox: [{ seq: 0, job }] } });
    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", outbox: [{ seq: 0, job }] } });

    expect(db.inserted).toHaveLength(1); // the in-flight seq was not re-inserted
    resolveInsert();
    await vi.waitFor(() => expect(win.posted.filter((m) => m.data.type === "ack")).toHaveLength(1));
  });

  test("acking an already-acked seq again replays the SAME result without re-inserting", async () => {
    const win = makeFakeWindow();
    const db = makeFakeDb({ insertResult: 0 }); // e.g. "database already has that job number"
    const bridge = createExtensionBridge({ win, db });
    bridge.subscribe(() => {});

    const job = { job_number: "J1", title: "Dev" };
    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", outbox: [{ seq: 7, job }] } });
    await vi.waitFor(() => expect(db.inserted).toHaveLength(1));

    // The extension didn't see our first ack (e.g. it reconnected) and
    // re-sends the same still-unacknowledged-from-its-view entry.
    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", outbox: [{ seq: 7, job }] } });
    await vi.waitFor(() => {
      const acks = win.posted.filter((m) => m.data.type === "ack");
      expect(acks).toHaveLength(2);
    });

    expect(db.inserted).toHaveLength(1); // never inserted a second time
    const acks = win.posted.filter((m) => m.data.type === "ack");
    expect(acks[0].data).toMatchObject({ seq: 7, inserted: 0 });
    expect(acks[1].data).toMatchObject({ seq: 7, inserted: 0 }); // identical replayed result
  });

  test("distinct seqs in the same outbox are all inserted and acked", async () => {
    const win = makeFakeWindow();
    const db = makeFakeDb({ insertResult: 1 });
    const bridge = createExtensionBridge({ win, db });
    bridge.subscribe(() => {});

    const outbox = [
      { seq: 0, job: { job_number: "J1" } },
      { seq: 1, job: { job_number: "J2" } },
    ];
    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", outbox } });
    await vi.waitFor(() => expect(db.inserted).toHaveLength(2));

    const acks = win.posted.filter((m) => m.data.type === "ack").map((m) => m.data.seq);
    expect(new Set(acks)).toEqual(new Set([0, 1]));
  });

  test("a db error is reported back as an ack error string, not thrown", async () => {
    const win = makeFakeWindow();
    const db = makeFakeDb({ insertError: Object.assign(new Error("disk full"), { name: "SQLite3Error" }) });
    const bridge = createExtensionBridge({ win, db });
    bridge.subscribe(() => {});

    win.dispatch({
      source: "coopjobs-ext",
      type: "status",
      status: { state: "scraping", outbox: [{ seq: 0, job: { job_number: "J1" } }] },
    });
    await vi.waitFor(() => expect(win.posted.some((m) => m.data.type === "ack")).toBe(true));

    const ack = win.posted.find((m) => m.data.type === "ack").data;
    expect(ack.inserted).toBe(0);
    expect(ack.error).toBe("disk full");
  });

  test("a job is not acked when the database cannot be opened, so it stays queued", async () => {
    const win = makeFakeWindow();
    const db = makeFakeDb({ insertError: new Error("Access Handles cannot be created") });
    const bridge = createExtensionBridge({ win, db });
    bridge.subscribe(() => {});

    win.dispatch({
      source: "coopjobs-ext",
      type: "status",
      status: { state: "scraping", outbox: [{ seq: 0, job: { job_number: "J1" } }] },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(win.posted.some((m) => m.data.type === "ack")).toBe(false);
  });

  test("status listeners receive the status without the outbox field", async () => {
    const win = makeFakeWindow();
    const db = makeFakeDb();
    const bridge = createExtensionBridge({ win, db });
    const seen = [];
    bridge.subscribe((status) => seen.push(status));

    win.dispatch({ source: "coopjobs-ext", type: "status", status: { state: "scraping", jobs_saved: 2, outbox: [] } });

    expect(seen).toEqual([{ state: "scraping", jobs_saved: 2 }]);
  });
});

describe("createExtensionBridge detection", () => {
  test("resolves installed:true from a prompt pong", async () => {
    const win = makeFakeWindow();
    const bridge = createExtensionBridge({ win, db: makeFakeDb() });

    const detectPromise = bridge.detect();
    win.dispatch({ source: "coopjobs-ext", type: "pong", extensionVersion: "1.2.3", protocolVersion: 1 });

    await expect(detectPromise).resolves.toEqual({ installed: true, outdated: false, extensionVersion: "1.2.3" });
  });

  test("resolves outdated:true when the extension's protocolVersion is behind", async () => {
    const win = makeFakeWindow();
    const bridge = createExtensionBridge({ win, db: makeFakeDb() });

    const detectPromise = bridge.detect();
    win.dispatch({ source: "coopjobs-ext", type: "pong", extensionVersion: "0.9.0", protocolVersion: 0 });

    await expect(detectPromise).resolves.toEqual({ installed: true, outdated: true, extensionVersion: "0.9.0" });
  });

  test("resolves installed:false after ~1s of silence", async () => {
    vi.useFakeTimers();
    try {
      const win = makeFakeWindow();
      const bridge = createExtensionBridge({ win, db: makeFakeDb() });
      const detectPromise = bridge.detect();
      vi.advanceTimersByTime(1000);
      await expect(detectPromise).resolves.toEqual({ installed: false, outdated: false, extensionVersion: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
