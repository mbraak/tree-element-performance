// Local benchmark server for tree-element.
// No dependencies: serves the benchmark page, the tree-element bundle,
// generates large tree data, and stores benchmark results.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const VENDOR_DIR = path.join(__dirname, "node_modules", "tree-element");
// Packages exposed under /vendor/<name>/ (only these, nothing else from node_modules).
const VENDOR_PACKAGES = ["tree-element", "jstree", "jquery"];
const RESULTS_FILE = path.join(__dirname, "results", "results.ndjson");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const treeElementVersion = JSON.parse(
  fs.readFileSync(path.join(VENDOR_DIR, "package.json"), "utf8"),
).version;

// Files a page has to load to use each library, exactly as index.html does.
// jsTree needs jQuery, so that is counted as part of its bundle.
const BUNDLES = [
  {
    library: "tree-element",
    files: ["tree-element/tree_element.js", "tree-element/tree_element.css"],
  },
  {
    library: "jstree",
    files: [
      "jstree/dist/jstree.min.js",
      "jstree/dist/themes/default/style.min.css",
      "jquery/dist/jquery.min.js",
    ],
  },
];

function packageVersion(pkg) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "node_modules", pkg, "package.json"), "utf8"),
  ).version;
}

/** Raw and gzipped size of every file in BUNDLES, computed once at startup. */
function measureBundles() {
  return BUNDLES.map(({ library, files }) => {
    const entries = files.map((file) => {
      const data = fs.readFileSync(path.join(__dirname, "node_modules", file));
      return {
        file,
        package: file.split("/")[0],
        version: packageVersion(file.split("/")[0]),
        bytes: data.length,
        gzipBytes: zlib.gzipSync(data, { level: 9 }).length,
      };
    });
    return {
      library,
      files: entries,
      bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
      gzipBytes: entries.reduce((sum, e) => sum + e.gzipBytes, 0),
    };
  });
}

const bundles = measureBundles();

/**
 * Builds a balanced tree with `total` nodes where each folder gets up to
 * `childrenPerNode` children (breadth first). Deterministic, so every run
 * renders exactly the same data.
 */
export function generateTree({ total, childrenPerNode, nameLength }) {
  const roots = [];
  const queue = [];
  let id = 0;

  const makeNode = (depth, index) => {
    id += 1;
    const node = { id, name: `Node ${id} (d${depth}.${index})` };
    if (nameLength > node.name.length) {
      node.name = node.name.padEnd(nameLength, "·");
    }
    return node;
  };

  // Top level gets the same branching as every other level.
  for (let i = 0; i < childrenPerNode && id < total; i++) {
    const node = makeNode(0, i);
    roots.push(node);
    queue.push({ node, depth: 0 });
  }

  while (id < total && queue.length > 0) {
    const { node, depth } = queue.shift();
    node.children = [];
    for (let i = 0; i < childrenPerNode && id < total; i++) {
      const child = makeNode(depth + 1, i);
      node.children.push(child);
      queue.push({ node: child, depth: depth + 1 });
    }
  }

  return roots;
}

function treeStats(roots) {
  let count = 0;
  let maxDepth = 0;
  let folders = 0;
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      count++;
      if (depth > maxDepth) maxDepth = depth;
      if (n.children && n.children.length) {
        folders++;
        walk(n.children, depth + 1);
      }
    }
  };
  walk(roots, 0);
  return { count, maxDepth, folders };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

async function serveFile(res, baseDir, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, safe);
  if (!filePath.startsWith(baseDir)) {
    return send(res, 403, "Forbidden");
  }
  try {
    const data = await fsp.readFile(filePath);
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") {
      send(res, 404, `Not found: ${relPath}`);
    } else {
      send(res, 500, String(err));
    }
  }
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clampInt(value, def, min, max) {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // ---- API -------------------------------------------------------------
    if (pathname === "/api/info") {
      return sendJson(res, 200, {
        treeElementVersion,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
      });
    }

    if (pathname === "/api/bundles") {
      return sendJson(res, 200, bundles);
    }

    if (pathname === "/api/tree") {
      const total = clampInt(url.searchParams.get("nodes"), 10000, 1, 2_000_000);
      const childrenPerNode = clampInt(url.searchParams.get("children"), 10, 1, 100000);
      const nameLength = clampInt(url.searchParams.get("nameLength"), 0, 0, 1000);
      const t0 = performance.now();
      const roots = generateTree({ total, childrenPerNode, nameLength });
      const stats = treeStats(roots);
      const body = JSON.stringify(roots);
      res.setHeader("X-Generate-Ms", (performance.now() - t0).toFixed(1));
      res.setHeader("X-Tree-Count", String(stats.count));
      res.setHeader("X-Tree-Max-Depth", String(stats.maxDepth));
      res.setHeader("X-Tree-Folders", String(stats.folders));
      return send(res, 200, body, {
        "Content-Type": "application/json; charset=utf-8",
      });
    }

    if (pathname === "/api/results") {
      if (req.method === "POST") {
        const raw = await readBody(req);
        const result = JSON.parse(raw);
        result.savedAt = new Date().toISOString();
        result.treeElementVersion = treeElementVersion;
        await fsp.mkdir(path.dirname(RESULTS_FILE), { recursive: true });
        await fsp.appendFile(RESULTS_FILE, JSON.stringify(result) + "\n");
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        await fsp.rm(RESULTS_FILE, { force: true });
        return sendJson(res, 200, { ok: true });
      }
      let lines = [];
      try {
        const text = await fsp.readFile(RESULTS_FILE, "utf8");
        lines = text
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      return sendJson(res, 200, lines);
    }

    // ---- Static files ----------------------------------------------------
    if (pathname.startsWith("/vendor/")) {
      const [, , pkg, ...rest] = pathname.split("/");
      if (!VENDOR_PACKAGES.includes(pkg)) return send(res, 404, `Unknown vendor package: ${pkg}`);
      return serveFile(res, path.join(__dirname, "node_modules", pkg), rest.join("/"));
    }

    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    return serveFile(res, PUBLIC_DIR, rel);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`tree-element ${treeElementVersion} benchmark`);
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log(`  results are appended to ${path.relative(process.cwd(), RESULTS_FILE)}`);
});
