/* global TreeElement, jQuery */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const form = $("#form");
  const runButton = $("#run");
  const stopButton = $("#stop");
  const statusEl = $("#status");
  const summaryEl = $("#summary");
  const runsBody = $("#runsTable tbody");
  const historyBody = $("#history tbody");
  const treeHost = $("#treeHost");

  let stopRequested = false;
  let running = false;
  let lastHandle = null; // tree of the final run, kept visible on the page
  let lastAdapter = null;

  // ---- helpers -----------------------------------------------------------

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n, digits = 1) =>
    n == null || Number.isNaN(n) ? "–" : Number(n).toFixed(digits);
  const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));

  function stats(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const variance =
      sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
    return {
      median,
      mean,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      stdev: Math.sqrt(variance),
      n: sorted.length,
    };
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function readConfig() {
    const fd = new FormData(form);
    const autoOpenRaw = fd.get("autoOpen");
    const autoOpen =
      autoOpenRaw === "true" ? true : autoOpenRaw === "false" ? false : Number(autoOpenRaw);
    return {
      library: fd.get("library"),
      nodes: Number(fd.get("nodes")),
      children: Number(fd.get("children")),
      nameLength: Number(fd.get("nameLength")),
      scenario: fd.get("scenario"),
      autoOpen,
      runs: Number(fd.get("runs")),
      warmup: fd.get("warmup") === "on",
      dragAndDrop: fd.get("dragAndDrop") === "on",
      keyboardSupport: fd.get("keyboardSupport") === "on",
      showEmptyFolder: fd.get("showEmptyFolder") === "on",
      save: fd.get("save") === "on",
    };
  }

  function applyQueryToForm() {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of params) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === "checkbox") {
        field.checked = value === "1" || value === "true" || value === "on";
      } else {
        field.value = value;
      }
    }
  }

  /** Is a node at `depth` (0 = top level) opened for this autoOpen value? */
  function isOpenedAtDepth(autoOpen, depth) {
    if (autoOpen === true) return true;
    if (autoOpen === false) return false;
    return depth <= autoOpen;
  }

  // ---- data --------------------------------------------------------------

  async function fetchTree(config) {
    const qs = new URLSearchParams({
      nodes: config.nodes,
      children: config.children,
      nameLength: config.nameLength,
    });
    const t0 = performance.now();
    const res = await fetch(`/api/tree?${qs}`);
    if (!res.ok) throw new Error(`Data request failed: ${res.status}`);
    const text = await res.text();
    const t1 = performance.now();
    const data = JSON.parse(text);
    const t2 = performance.now();
    return {
      data,
      info: {
        bytes: text.length,
        fetchMs: t1 - t0,
        parseMs: t2 - t1,
        generateMs: Number(res.headers.get("X-Generate-Ms")),
        count: Number(res.headers.get("X-Tree-Count")),
        maxDepth: Number(res.headers.get("X-Tree-Max-Depth")),
        folders: Number(res.headers.get("X-Tree-Folders")),
      },
    };
  }

  // ---- library adapters ----------------------------------------------------
  //
  // Every adapter gets the same generated data ({ id, name, children }) and
  // implements the four scenarios. `prepare` runs outside the timer and
  // converts/clones the data into whatever the library wants. Methods that
  // the library completes asynchronously return a promise that resolves when
  // the library reports it is done.

  const adapters = {
    "tree-element": {
      label: "tree-element",
      available: () => typeof TreeElement === "function",
      version: () =>
        new TreeElement({ htmlElement: document.createElement("div"), data: [] }).getVersion(),

      prepare(data) {
        return structuredClone(data); // the library must not see reused objects
      },

      options(config, data, autoOpen = config.autoOpen) {
        return {
          data,
          autoOpen,
          slide: false,
          animationSpeed: 0,
          dragAndDrop: config.dragAndDrop,
          keyboardSupport: config.keyboardSupport,
          showEmptyFolder: config.showEmptyFolder,
          saveState: false,
          useContextMenu: false,
        };
      },

      create(container, data, config, autoOpen) {
        return new TreeElement({ htmlElement: container, ...this.options(config, data, autoOpen) });
      },
      refresh(tree) {
        tree.refresh();
      },
      firstFolder(tree) {
        return tree.getTree().children.find((n) => n.children && n.children.length) || null;
      },
      isOpen(tree, node) {
        return Boolean(node.is_open);
      },
      open(tree, node) {
        return tree.openNode(node, false);
      },
      close(tree, node) {
        tree.closeNode(node, false);
      },
      destroy(tree) {
        tree.deinit();
      },
    },

    jstree: {
      label: "jsTree",
      available: () => typeof jQuery === "function" && Boolean(jQuery.jstree),
      version: () => jQuery.jstree.version,

      prepare(data, config) {
        // Convert to jsTree's format; the open state lives on each node.
        const convert = (nodes, depth) =>
          nodes.map((n) => {
            const out = { id: String(n.id), text: n.name };
            if (n.children && n.children.length) {
              out.children = convert(n.children, depth + 1);
              out.state = { opened: isOpenedAtDepth(config.autoOpen, depth) };
            }
            return out;
          });
        return convert(data, 0);
      },

      create(container, data, config, autoOpen = config.autoOpen) {
        if (autoOpen !== config.autoOpen) {
          // Scenario needs a different open state than the prepared data has.
          const setOpened = (nodes, depth) => {
            for (const n of nodes) {
              if (n.children) {
                n.state = { opened: isOpenedAtDepth(autoOpen, depth) };
                setOpened(n.children, depth + 1);
              }
            }
          };
          setOpened(data, 0);
        }
        const $el = jQuery(container);
        const plugins = [];
        if (config.dragAndDrop) plugins.push("dnd");
        const ready = new Promise((resolve) => $el.one("ready.jstree", () => resolve()));
        $el.jstree({
          core: {
            data,
            animation: 0,
            check_callback: true,
            themes: { responsive: false },
            keyboard: config.keyboardSupport ? undefined : {},
          },
          plugins,
        });
        const inst = $el.jstree(true);
        return ready.then(() => inst);
      },
      refresh(inst) {
        const done = new Promise((resolve) => inst.element.one("refresh.jstree", () => resolve()));
        inst.refresh(true, true);
        return done;
      },
      firstFolder(inst) {
        const root = inst.get_node(jQuery.jstree.root);
        const id = root.children.find((c) => inst.is_parent(c));
        return id ? inst.get_node(id) : null;
      },
      isOpen(inst, node) {
        return inst.is_open(node);
      },
      open(inst, node) {
        // With animation 0 and loaded children this completes synchronously.
        inst.open_node(node, null, 0);
      },
      close(inst, node) {
        inst.close_node(node, 0);
      },
      destroy(inst) {
        inst.destroy();
      },
    },
  };

  // ---- measuring ---------------------------------------------------------

  function makeContainer() {
    treeHost.replaceChildren();
    const el = document.createElement("div");
    treeHost.appendChild(el);
    return el;
  }

  /**
   * Times `action` (sync or async) and then measures forced layout and the
   * time until the browser has presented a frame. Returns the action's value
   * as `value`.
   */
  async function measure(label, container, action) {
    const startMark = `${label}-start`;
    performance.mark(startMark);
    const t0 = performance.now();
    let value = action();
    const tSync = performance.now();
    if (value && typeof value.then === "function") {
      value = await value;
    }
    const tAction = performance.now();

    // Force style + layout.
    container.getBoundingClientRect();
    const tLayout = performance.now();

    // First rAF runs before the next frame's style/layout/paint; the second
    // runs after that frame has been committed.
    await nextFrame();
    await nextFrame();
    const tFrame = performance.now();
    performance.measure(label, startMark);

    return {
      value,
      result: {
        construct: tAction - t0,
        constructSync: tSync - t0,
        layout: tLayout - tAction,
        toFrame: tFrame - t0,
        total: tFrame - t0,
        liCount: container.querySelectorAll("li").length,
      },
    };
  }

  async function settle() {
    await nextFrame();
    await nextFrame();
  }

  async function runOnce(adapter, config, data, runIndex, keep = false) {
    const label = `bench-${config.library}-${config.scenario}-${runIndex}`;
    const container = makeContainer();
    const prepared = adapter.prepare(data, config);
    let handle = null;
    let result;

    try {
      if (config.scenario === "render") {
        const m = await measure(label, container, () => adapter.create(container, prepared, config));
        handle = m.value;
        result = m.result;
      } else if (config.scenario === "refresh") {
        handle = await adapter.create(container, prepared, config);
        await settle();
        result = (await measure(label, container, () => adapter.refresh(handle))).result;
      } else if (config.scenario === "open") {
        // Start closed, then open the first top-level folder.
        handle = await adapter.create(container, prepared, config, false);
        await settle();
        const first = adapter.firstFolder(handle);
        if (!first) throw new Error("No folder to open");
        result = (await measure(label, container, () => adapter.open(handle, first))).result;
      } else if (config.scenario === "toggle") {
        handle = await adapter.create(container, prepared, config);
        await settle();
        const first = adapter.firstFolder(handle);
        if (!first) throw new Error("No folder to toggle");
        if (!adapter.isOpen(handle, first)) {
          await adapter.open(handle, first);
          await settle();
        }
        result = (
          await measure(label, container, async () => {
            await adapter.close(handle, first);
            await adapter.open(handle, first);
          })
        ).result;
      } else {
        throw new Error(`Unknown scenario ${config.scenario}`);
      }
    } finally {
      // Give the browser a moment before tearing down so the measurement
      // is not competing with cleanup of the previous run.
      await sleep(30);
      if (keep) {
        lastHandle = handle;
        lastAdapter = adapter;
      } else {
        if (handle) adapter.destroy(handle);
        container.remove();
        await sleep(60);
      }
    }
    return result;
  }

  // ---- rendering results -------------------------------------------------

  function statBox(k, v, cls = "") {
    return `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  }

  function renderSummary(result) {
    const s = result.stats;
    const ms = (n) => `${fmt(n)}<small> ms</small>`;
    summaryEl.innerHTML = [
      statBox("library", `${result.libraryLabel}<small> ${result.libraryVersion}</small>`),
      statBox("median total", ms(s.total.median), "primary"),
      statBox("mean total", ms(s.total.mean)),
      statBox("min / max", `${fmt(s.total.min)} / ${fmt(s.total.max)}<small> ms</small>`),
      statBox("stdev", ms(s.total.stdev)),
      statBox("median construct", ms(s.construct.median)),
      statBox("median layout", ms(s.layout.median)),
      statBox("li rendered", fmtInt(result.liCount)),
      statBox("nodes in data", `${fmtInt(result.data.count)}<small> depth ${result.data.maxDepth}</small>`),
      statBox("data payload", `${fmt(result.data.bytes / 1024 / 1024, 2)}<small> MB</small>`),
      statBox("fetch + parse", `${fmt(result.data.fetchMs + result.data.parseMs, 0)}<small> ms (not counted)</small>`),
    ].join("");
  }

  function renderRuns(runs, warmup) {
    runsBody.innerHTML = "";
    const all = warmup ? [{ ...warmup, warm: true }, ...runs] : runs;
    all.forEach((r, i) => {
      const tr = document.createElement("tr");
      const idx = r.warm ? "warm-up" : String(warmup ? i : i + 1);
      tr.innerHTML = `<td>${idx}</td><td>${fmt(r.construct)}</td><td>${fmt(r.layout)}</td><td>${fmt(r.toFrame)}</td><td><b>${fmt(r.total)}</b></td><td>${fmtInt(r.liCount)}</td>`;
      if (r.warm) tr.style.color = "var(--muted)";
      runsBody.appendChild(tr);
    });
  }

  function browserLabel() {
    const ua = navigator.userAgent;
    const m =
      ua.match(/(Firefox)\/([\d.]+)/) ||
      ua.match(/(Edg)\/([\d.]+)/) ||
      ua.match(/(Chrome)\/([\d.]+)/) ||
      ua.match(/(Version)\/([\d.]+).*Safari/);
    if (!m) return ua;
    const name = m[1] === "Version" ? "Safari" : m[1] === "Edg" ? "Edge" : m[1];
    return `${name} ${m[2].split(".")[0]}`;
  }

  // ---- history -----------------------------------------------------------

  async function loadHistory() {
    const res = await fetch("/api/results");
    const rows = await res.json();
    historyBody.innerHTML = "";
    rows
      .slice()
      .reverse()
      .forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${new Date(r.savedAt).toLocaleString()}</td>
          <td class="left">${r.libraryLabel ?? r.config.library ?? "tree-element"}</td>
          <td class="left">${r.libraryVersion ?? r.treeElementVersion ?? ""}</td>
          <td class="left">${r.config.scenario}</td>
          <td>${fmtInt(r.data.count)}</td>
          <td>${r.config.children}</td>
          <td>${String(r.config.autoOpen)}</td>
          <td>${r.stats.total.n}</td>
          <td><b>${fmt(r.stats.total.median)}</b></td>
          <td>${fmt(r.stats.total.mean)}</td>
          <td>${fmt(r.stats.total.min)}</td>
          <td>${fmt(r.stats.total.max)}</td>
          <td>${fmtInt(r.liCount)}</td>
          <td class="left">${r.browser}</td>`;
        historyBody.appendChild(tr);
      });
  }

  async function saveResult(result) {
    await fetch("/api/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    await loadHistory();
  }

  // ---- main --------------------------------------------------------------

  async function runBenchmark(config) {
    running = true;
    stopRequested = false;
    runButton.disabled = true;
    stopButton.disabled = false;
    summaryEl.innerHTML = `<p class="muted">Running…</p>`;
    runsBody.innerHTML = "";
    if (lastHandle) {
      lastAdapter.destroy(lastHandle);
      lastHandle = null;
      lastAdapter = null;
    }

    try {
      const adapter = adapters[config.library];
      if (!adapter) throw new Error(`Unknown library ${config.library}`);
      if (!adapter.available()) throw new Error(`${config.library} is not loaded`);

      setStatus(`Fetching ${fmtInt(config.nodes)} nodes…`);
      const { data, info } = await fetchTree(config);
      setStatus(
        `Got ${fmtInt(info.count)} nodes (${fmt(info.bytes / 1024 / 1024, 1)} MB) in ${fmt(info.fetchMs + info.parseMs, 0)} ms`,
      );
      await sleep(100);

      let warmup = null;
      if (config.warmup) {
        setStatus(`${adapter.label}: warm-up run…`);
        warmup = await runOnce(adapter, config, data, 0);
        renderRuns([], warmup);
      }

      const runs = [];
      for (let i = 1; i <= config.runs; i++) {
        if (stopRequested) break;
        setStatus(`${adapter.label}: run ${i} of ${config.runs}…`);
        const r = await runOnce(adapter, config, data, i, i === config.runs);
        runs.push(r);
        renderRuns(runs, warmup);
      }

      if (!runs.length) {
        setStatus("Stopped before any run finished.");
        summaryEl.innerHTML = `<p class="muted">No result.</p>`;
        return null;
      }

      const pick = (k) => stats(runs.map((r) => r[k]));
      const result = {
        config,
        library: config.library,
        libraryLabel: adapter.label,
        libraryVersion: adapter.version(),
        data: info,
        browser: browserLabel(),
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio: window.devicePixelRatio,
        liCount: runs[0].liCount,
        stats: {
          total: pick("total"),
          construct: pick("construct"),
          layout: pick("layout"),
          toFrame: pick("toFrame"),
        },
        runs,
        warmup,
      };

      renderSummary(result);
      setStatus(
        stopRequested
          ? `Stopped after ${runs.length} run(s).`
          : `Done: ${adapter.label}, ${runs.length} run(s), median ${fmt(result.stats.total.median)} ms.`,
      );
      window.__benchResult = result;
      console.log("benchmark result", JSON.stringify(result));

      if (config.save) {
        await saveResult(result);
      }
      return result;
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
      summaryEl.innerHTML = `<p class="muted">Error: ${err.message}</p>`;
      return null;
    } finally {
      running = false;
      runButton.disabled = false;
      stopButton.disabled = true;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!running) runBenchmark(readConfig());
  });
  stopButton.addEventListener("click", () => {
    stopRequested = true;
    setStatus("Stopping after the current run…");
  });
  $("#reload").addEventListener("click", loadHistory);
  $("#clear").addEventListener("click", async () => {
    if (!confirm("Delete all saved results?")) return;
    await fetch("/api/results", { method: "DELETE" });
    await loadHistory();
  });

  async function init() {
    applyQueryToForm();
    const versions = Object.values(adapters)
      .filter((a) => a.available())
      .map((a) => `${a.label} ${a.version()}`)
      .join(" · ");
    $("#meta").textContent =
      `${versions} · ${browserLabel()} · ${navigator.hardwareConcurrency ?? "?"} cores · dpr ${window.devicePixelRatio}`;
    await loadHistory();

    if (new URLSearchParams(location.search).get("auto") === "1") {
      const result = await runBenchmark(readConfig());
      window.__benchDone = true;
      document.body.dataset.benchDone = "1";
      if (result) document.title = `done ${fmt(result.stats.total.median)}ms`;
    }
  }

  init();
})();
