# tree-element render benchmark

Measures how fast [tree-element](https://github.com/mbraak/tree-element) renders
a very big tree in a real browser. A tiny dependency-free Node server serves the
page and the library, generates the tree data and stores results.

## Run

```sh
npm install
npm start          # http://127.0.0.1:3000/   (PORT=4000 npm start for another port)
```

Open the page, pick the size and scenario, press **Run benchmark**.

## What is measured

Each run creates a fresh container, then times one of these scenarios:

| Scenario  | Measured call                                    |
| --------- | ------------------------------------------------ |
| `render`  | `new TreeElement({ data, autoOpen, ... })`       |
| `refresh` | `tree.refresh()` on an already rendered tree     |
| `open`    | `tree.openNode(firstFolder)` on a closed tree    |
| `toggle`  | `toggle()` the first folder closed and open again |

Per run it reports, in milliseconds:

- **construct**: synchronous JavaScript time of the call (DOM built).
- **layout**: a forced `getBoundingClientRect()` right after (style + layout).
- **to frame / total**: from the start of the call until the browser has
  presented a frame (two `requestAnimationFrame`s).

Data is fetched from `/api/tree` *before* the timer starts, so network and
JSON parsing are never part of the result. Animations (`slide`) are off. An
optional warm-up run is not counted. Summary shows median, mean, min, max and
standard deviation. `performance.mark/measure` entries are emitted, so the runs
also show up in the DevTools Performance panel.

Ticking **Save result to server** appends the result to
`results/results.ndjson` and the History table lets you compare runs, e.g.
across library versions or browsers.

## URL parameters

Every form field can be preset through the query string, and `auto=1` runs
immediately on load:

```
http://127.0.0.1:3000/?auto=1&nodes=100000&children=10&scenario=render&autoOpen=true&runs=5&save=1
```

When done, the page sets `window.__benchDone = true` and puts the full result
in `window.__benchResult` (also logged to the console as JSON).

## Headless from the command line (optional)

```sh
npm i -D playwright && npx playwright install chromium
node bench-headless.mjs --nodes=100000 --runs=5
node bench-headless.mjs --browser=firefox --scenario=refresh --headed --save
node bench-headless.mjs --help
```

It starts the server, opens the page with `auto=1` in a real browser and
prints a summary table.

## Testing another version of tree-element

The page loads the bundle from `node_modules/tree-element`, so:

```sh
npm i tree-element@<version>        # or:  npm link ../tree-element
```

then reload the page. Saved results record the version.

## Endpoints

- `GET /api/tree?nodes=N&children=C&nameLength=L` balanced tree as JSON.
  Response headers `X-Tree-Count`, `X-Tree-Max-Depth`, `X-Tree-Folders`,
  `X-Generate-Ms`.
- `GET|POST|DELETE /api/results` stored results (NDJSON on disk).
- `GET /api/info` versions.
- `/vendor/tree-element/*` files from the installed package.
