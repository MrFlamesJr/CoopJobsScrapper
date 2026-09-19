# CoopJobs Scraper (extension)

MV3 Chrome/Edge extension port of the Python Selenium scraper.

## Layout

- `manifest.json` -- MV3 manifest (source of truth; copied verbatim into `dist/` on build).
- `src/background/index.js` -- background service worker.
- `src/content/portal.js` -- content script injected on the co-op portal origin
  (`https://experiential-learning.uottawa.ca/*`); scrapes job cards/panels.
- `src/content/bridge.js` -- content script injected on the hosted app origin
  (currently `http://localhost/*` and `http://127.0.0.1/*` for local development);
  relays scraped data between the portal content script (via the background worker)
  and the existing web app.
- `src/scraper/panelParser.js` -- pure DOM-based port of `app/scraper/panel_parser.py`.

## Build

```
npm install
npm run build
```

Produces `dist/manifest.json`, `dist/background/index.js`, `dist/content/portal.js`,
and `dist/content/bridge.js`.

## Test

```
npm test
```

## TODO

- Once the scraped-job web app is deployed to its real hosted origin (not just
  `localhost`/`127.0.0.1`), add that origin to both `host_permissions` and the
  `bridge.js` content script's `matches` in `manifest.json`.
