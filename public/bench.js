/* global TreeElement */
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
  let libraryVersion = null;
  let lastTree = null; // tree of the final run, kept visible on the page

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

  // ---- measuring ---------------------------------------------------------

  function treeOptions(config, data) {
    return {
      data,
      autoOpen: config.autoOpen,
      slide: false,
      animationSpeed: 0,
      dragAndDrop: config.dragAndDrop,
      keyboardSupport: config.keyboardSupport,
      showEmptyFolder: config.showEmptyFolder,
      saveState: false,
      useContextMenu: false,
    };
  }

  function makeContainer() {
    treeHost.replaceChildren();
    const el = document.createElement("div");
    treeHost.appendChild(el);
    return el;
  }

  /**
   * Times `action` (sync or async) and then measures forced layout and the
   * time until the browser has presented a frame.
   */
  async function measure(label, container, action) {
    const startMark = `${label}-start`;
    performance.mark(startMark);
    const t0 = performance.now();
    const maybePromise = action();
    const tConstruct = performance.now();
    if (maybePromise && typeof maybePromise.then === "function") {
      await maybePromise;
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
      construct: tAction - t0,
      constructSync: tConstruct - t0,
      layout: tLayout - tAction,
      toFrame: tFrame - t0,
      total: tFrame - t0,
      liCount: container.querySelectorAll("li").length,
    };
  }

  async function runOnce(config, data, runIndex, keep = false) {
    const label = `bench-${config.scenario}-${runIndex}`;
    const container = makeContainer();
    const cloned = structuredClone(data); // the library must not see reused objects
    let tree = null;
    let result;

    try {
      if (config.scenario === "render") {
        result = await measure(label, container, () => {
          tree = new TreeElement({ htmlElement: container, ...treeOptions(config, cloned) });
        });
      } else if (config.scenario === "refresh") {
        tree = new TreeElement({ htmlElement: container, ...treeOptions(config, cloned) });
        await nextFrame();
        await nextFrame();
        result = await measure(label, container, () => tree.refresh());
      } else if (config.scenario === "open") {
        // Start closed, then open the first top-level folder.
        const opts = treeOptions(config, cloned);
        opts.autoOpen = false;
        tree = new TreeElement({ htmlElement: container, ...opts });
        await nextFrame();
        await nextFrame();
        const first = tree.getTree().children.find((n) => n.children && n.children.length);
        if (!first) throw new Error("No folder to open");
        result = await measure(label, container, () => tree.openNode(first, false));
      } else if (config.scenario === "toggle") {
        tree = new TreeElement({ htmlElement: container, ...treeOptions(config, cloned) });
        await nextFrame();
        await nextFrame();
        const first = tree.getTree().children.find((n) => n.children && n.children.length);
        if (!first) throw new Error("No folder to toggle");
        if (!first.is_open) {
          tree.openNode(first, false);
          await nextFrame();
        }
        result = await measure(label, container, () => {
          tree.toggle(first, false); // close
          tree.toggle(first, false); // open
        });
      } else {
        throw new Error(`Unknown scenario ${config.scenario}`);
      }
    } finally {
      // Give the browser a moment before tearing down so the measurement
      // is not competing with cleanup of the previous run.
      await sleep(30);
      if (keep) {
        lastTree = tree;
      } else {
        if (tree) tree.deinit();
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
          <td class="left">${r.treeElementVersion ?? ""}</td>
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
    if (lastTree) {
      lastTree.deinit();
      lastTree = null;
    }

    try {
      setStatus(`Fetching ${fmtInt(config.nodes)} nodes…`);
      const { data, info } = await fetchTree(config);
      setStatus(
        `Got ${fmtInt(info.count)} nodes (${fmt(info.bytes / 1024 / 1024, 1)} MB) in ${fmt(info.fetchMs + info.parseMs, 0)} ms`,
      );
      await sleep(100);

      let warmup = null;
      if (config.warmup) {
        setStatus("Warm-up run…");
        warmup = await runOnce(config, data, 0);
        renderRuns([], warmup);
      }

      const runs = [];
      for (let i = 1; i <= config.runs; i++) {
        if (stopRequested) break;
        setStatus(`Run ${i} of ${config.runs}…`);
        const r = await runOnce(config, data, i, i === config.runs);
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
        data: info,
        treeElementVersion: libraryVersion,
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
          : `Done: ${runs.length} run(s), median ${fmt(result.stats.total.median)} ms.`,
      );
      window.__benchResult = result;
      console.log("tree-element benchmark result", JSON.stringify(result));

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
    try {
      const info = await fetch("/api/info").then((r) => r.json());
      libraryVersion =
        typeof TreeElement === "function"
          ? new TreeElement({ htmlElement: document.createElement("div"), data: [] }).getVersion()
          : info.treeElementVersion;
      $("#meta").textContent =
        `tree-element ${libraryVersion} (npm ${info.treeElementVersion}) · ${browserLabel()} · ` +
        `${navigator.hardwareConcurrency ?? "?"} cores · dpr ${window.devicePixelRatio}`;
    } catch (err) {
      $("#meta").textContent = `Could not load info: ${err.message}`;
    }
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
