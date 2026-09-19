// Web Worker: owns the actual SQLite database (sqlite-wasm, OPFS SAHPool
// VFS) and answers RPC calls {id, method, args} from client.js with
// {id, result} or {id, error}. Runs off the main thread so the UI never
// blocks on a query.
//
// The OPFS SAHPool VFS needs no COOP/COEP headers (unlike the plain OPFS
// VFS), which is why it's the one this app uses for a static, header-less
// deploy.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
// Vite: `?raw` imports the file's text content as a plain string.
import schemaSql from "./schema.sql?raw";
import * as queries from "./queries.js";

const DB_FILENAME = "coopjobs.db";

let sqlite3 = null;
let poolUtil = null;
let db = null;
let handle = null;
let readyPromise = null;

function makeHandle(sqliteDb) {
  return {
    exec(sql, params = []) {
      const rows = [];
      sqliteDb.exec({
        sql,
        bind: params,
        rowMode: "object",
        callback: (row) => rows.push(row),
      });
      return rows;
    },
    run(sql, params = []) {
      sqliteDb.exec({ sql, bind: params });
      return { changes: sqliteDb.changes() };
    },
  };
}

function openDb() {
  if (db) {
    try {
      db.close();
    } catch {
      // already closed / never opened
    }
  }
  db = new poolUtil.OpfsSAHPoolDb(DB_FILENAME);
  handle = makeHandle(db);
  queries.initDb(handle, schemaSql);
}

async function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (msg) => console.error(msg) });
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "coopjobs-sahpool" });
    openDb();
  })();
  return readyPromise;
}

// Methods that go straight through to queries.js, unpacking positional args.
const QUERY_METHODS = {
  insertJobs: (jobs) => queries.insertJobs(handle, jobs),
  countJobs: () => queries.countJobs(handle),
  lastScrapedAt: () => queries.lastScrapedAt(handle),
  queryJobs: (options) => queries.queryJobs(handle, options),
  getJob: (jobId) => queries.getJob(handle, jobId),
  getFacets: () => queries.getFacets(handle),
  clearJobs: () => queries.clearJobs(handle),
  setLastRun: (run) => queries.setLastRun(handle, run),
  getLastRun: () => queries.getLastRun(handle),
  listFavorites: () => queries.listFavorites(handle),
  addFavorite: (jobNumber) => queries.addFavorite(handle, jobNumber),
  removeFavorite: (jobNumber) => queries.removeFavorite(handle, jobNumber),
  exportJobs: () => queries.exportJobs(handle),
};

// Methods that operate on the raw db file rather than through queries.js.
const FILE_METHODS = {
  exportDbFile: () => {
    // Raw, whole-file export -- works for any live sqlite3 connection,
    // OPFS-backed or not. Takes the raw C pointer, not the JS wrapper.
    return sqlite3.capi.sqlite3_js_db_export(db.pointer);
  },
  importDbFile: async (bytes) => {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Release our handle on the pool slot before overwriting its file.
    if (db) {
      try {
        db.close();
      } catch {
        // already closed
      }
      db = null;
    }
    await poolUtil.importDb(DB_FILENAME, data);
    // Re-open on top of the imported file and re-run schema.sql: every
    // statement in it is CREATE ... IF NOT EXISTS, so this is a no-op against
    // an already-matching database and only fills in the gaps for an older one.
    openDb();
    return true;
  },
};

self.onmessage = async (event) => {
  const { id, method, args = [] } = event.data || {};
  try {
    await ensureReady();
    const fn = QUERY_METHODS[method] || FILE_METHODS[method];
    if (!fn) throw new Error(`Unknown database method: ${method}`);
    const result = await fn(...args);
    // Transfer the buffer instead of copying it for a raw db-file export.
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({
      id,
      error: { message: (error && error.message) || String(error), stack: error && error.stack },
    });
  }
};
