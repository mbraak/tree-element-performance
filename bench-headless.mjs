// Optional: run the benchmark from the command line in a real (headless)
// browser via Playwright. The browser page does all measuring; this script
// only starts the server, opens the page with ?auto=1 and prints the result.
//
//   npm i -D playwright && npx playwright install chromium
//   node bench-headless.mjs --nodes=100000 --children=10 --runs=5
//   node bench-headless.mjs --browser=firefox --scenario=refresh --headed --save
//   node bench-headless.mjs --library=jstree --nodes=20000

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);

if (args.help) {
  console.log(`Usage: node bench-headless.mjs [options]
  --library=L        tree-element | jstree (default tree-element)
  --nodes=N          total nodes (default 50000)
  --children=N       children per folder (default 10)
  --nameLength=N     pad node names to this length (default 0)
  --scenario=S       render | refresh | open | toggle (default render)
  --autoOpen=V       true | false | 0 | 1 | 2 | 3 (default true)
  --runs=N           measured runs (default 5)
  --no-warmup        skip the warm-up run
  --dragAndDrop      enable drag and drop option
  --save             append the result to results/results.ndjson
  --browser=B        chromium | firefox | webkit (default chromium)
  --headed           show the browser window
  --url=URL          use an already running server instead of starting one
  --json             print the full result as JSON`);
  process.exit(0);
}

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error(
    "Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium\n" +
      "Or just run `npm start` and open the page in your browser.",
  );
  process.exit(1);
}

const browserName = args.browser || "chromium";
let serverProcess = null;
let baseUrl = args.url;

if (!baseUrl) {
  const port = Number(args.port) || 3000 + Math.floor(Math.random() * 1000);
  serverProcess = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    serverProcess.stdout.on("data", (d) => {
      if (String(d).includes("http://")) resolve();
    });
    serverProcess.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
  baseUrl = `http://127.0.0.1:${port}`;
}

const params = new URLSearchParams({
  auto: "1",
  library: args.library ?? "tree-element",
  nodes: args.nodes ?? "50000",
  children: args.children ?? "10",
  nameLength: args.nameLength ?? "0",
  scenario: args.scenario ?? "render",
  autoOpen: args.autoOpen ?? "true",
  runs: args.runs ?? "5",
  warmup: args["no-warmup"] ? "0" : "1",
  dragAndDrop: args.dragAndDrop ? "1" : "0",
  keyboardSupport: "1",
  showEmptyFolder: args.showEmptyFolder ? "1" : "0",
  save: args.save ? "1" : "0",
});
const url = `${baseUrl}/?${params}`;

const browser = await playwright[browserName].launch({ headless: !args.headed });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("console:", m.text());
  });

  console.log(`Opening ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__benchDone === true, null, { timeout: 30 * 60 * 1000 });
  const result = await page.evaluate(() => window.__benchResult);

  if (!result) {
    console.error("Benchmark produced no result (see errors above).");
    process.exitCode = 1;
  } else if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const s = result.stats;
    const f = (n) => n.toFixed(1).padStart(9);
    console.log(`\n${result.browser} · ${result.libraryLabel} ${result.libraryVersion} · scenario ${result.config.scenario} · autoOpen ${result.config.autoOpen}`);
    console.log(`nodes ${result.data.count.toLocaleString()} · depth ${result.data.maxDepth} · li rendered ${result.liCount.toLocaleString()} · ${s.total.n} runs\n`);
    console.log(`               median      mean       min       max     stdev`);
    for (const k of ["construct", "layout", "toFrame"]) {
      console.log(`${k.padEnd(10)} ${f(s[k].median)} ${f(s[k].mean)} ${f(s[k].min)} ${f(s[k].max)} ${f(s[k].stdev)}`);
    }
    console.log(`${"total".padEnd(10)} ${f(s.total.median)} ${f(s.total.mean)} ${f(s.total.min)} ${f(s.total.max)} ${f(s.total.stdev)}   (ms)`);
    if (args.save) console.log("\nSaved to results/results.ndjson");
  }
} finally {
  await browser.close();
  if (serverProcess) serverProcess.kill();
}
