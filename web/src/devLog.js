// Dev-only: mirrors scraper status snapshots to the Vite dev server, which
// appends them to web/.devlogs/scrape.jsonl so a scrape can be followed from
// a terminal. Only new activity-log lines are sent each time; the outbox is
// reduced to its size because it carries whole job records.
let lastEventKey = null;

export function devLogStatus(status) {
  if (!import.meta.env.DEV || !status) return;
  const events = status.events || [];
  const keyOf = (e) => `${e.time}|${e.message}`;
  const start = lastEventKey ? events.findIndex((e) => keyOf(e) === lastEventKey) + 1 : 0;
  const newEvents = events.slice(start);
  if (events.length) lastEventKey = keyOf(events[events.length - 1]);
  const { events: _events, outbox, ...rest } = status;
  const entry = { at: new Date().toISOString(), ...rest, outbox: outbox?.length ?? 0, newEvents };
  fetch("/__devlog", { method: "POST", body: JSON.stringify(entry) }).catch(() => {});
}
