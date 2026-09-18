# tree-element render benchmark

Measures how fast [tree-element](https://github.com/mbraak/tree-element) renders
a very big tree in a real browser, and runs the identical benchmark against
[jsTree](https://www.jstree.com/) for comparison. A tiny dependency-free Node
server serves the page and the libraries, generates the tree data and stores
results.

## Run

```sh
npm install
npm start          # http://127.0.0.1:3000/   (PORT=4000 npm start for another port)
```

Open the page, pick the library, size and scenario, press **Run benchmark**.

## Libraries

| Library        | Loaded from                     | Notes                                                     |
| -------------- | ------------------------------- | --------------------------------------------------------- |
| `tree-element` | `node_modules/tree-element`     | `slide: false`, `saveState: false`                        |
| `jstree`       | `node_modules/jstree` + jQuery  | `core.animation: 0`, default theme, `dnd` plugin if asked |

Both get the same generated data. For jsTree it is converted to its own format
(`text`, `state.opened`) *before* the timer starts. Because jsTree loads and
refreshes asynchronously, those scenarios wait for its `ready.jstree` /
`refresh.jstree` event; opening and closing with animation 0 is synchronous.

The **li rendered** number shows a difference in strategy: tree-element puts
the whole tree in the DOM and hides closed folders with CSS, jsTree only
renders the children of open folders. Keep that in mind when comparing the
`open` scenario.

Adding another library means adding one adapter object in `public/bench.js`
(`prepare`, `create`, `refresh`, `firstFolder`, `isOpen`, `open`, `close`,
`destroy`), a `<script>`/`<link>` in `index.html`, the package name in
`VENDOR_PACKAGES` and its files in `BUNDLES` in `server.js` and an option in
the Library select.

## Bundle size

The **Bundle size** panel lists the files a page has to load for each library
(JS and CSS as served from `node_modules`, jQuery counted with jsTree), with
their raw and gzipped (level 9) size. The server measures them once at startup
and serves them at `GET /api/bundles`.

## What is measured

Each run creates a fresh container, then times one of these scenarios:

| Scenario  | Measured call                                    |
| --------- | ------------------------------------------------ |
| `render`  | create the tree: `new TreeElement({ data, autoOpen })` / `$(el).jstree({ core: { data } })` |
| `refresh` | re-render an existing tree: `tree.refresh()` / `inst.refresh()` |
| `open`    | open the first top-level folder of a fully closed tree |
| `toggle`  | close and reopen the first top-level folder |

Per run it reports, in milliseconds:

- **construct**: time of the call until the library reports it is done
  (synchronous for tree-element, event-based for jsTree).
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
http://127.0.0.1:3000/?auto=1&library=jstree&nodes=100000&children=10&scenario=render&autoOpen=true&runs=5&save=1
```

When done, the page sets `window.__benchDone = true` and puts the full result
in `window.__benchResult` (also logged to the console as JSON).

## Headless from the command line (optional)

```sh
npm i -D playwright && npx playwright install chromium
node bench-headless.mjs --nodes=100000 --runs=5
node bench-headless.mjs --browser=firefox --scenario=refresh --headed --save
node bench-headless.mjs --library=jstree --nodes=100000 --runs=5
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
- `GET /api/bundles` raw and gzipped size of each library's files.
- `/vendor/<package>/*` files from the installed `tree-element`, `jstree` and
  `jquery` packages.
