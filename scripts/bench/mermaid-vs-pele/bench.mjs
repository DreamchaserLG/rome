// Renders the diagrams in ./diagrams with Mermaid (through @streamdown/mermaid, the
// plugin Rome's Markdown lazy-loads) and with Pele (through pele/lazy), in headless
// Chromium, and reports bundle size, cold and warm render time, and JS heap.
//
//   pnpm install && pnpm bench [--runs 5] [--cpu-throttle 1] [--only <substring>]
//
// Set CHROME to a Chromium/Chrome binary when Playwright's own download is absent.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const resultsDir = join(here, "results");

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RUNS = Number(option("--runs", "5"));
const CPU_THROTTLE = Number(option("--cpu-throttle", "1"));
const ONLY = option("--only", "");
const WARM_MIN_MS = 300;
const WARM_MIN_ITERS = 10;
const FONT = "Inter, ui-sans-serif, system-ui, sans-serif";

const version = (pkg) =>
  JSON.parse(readFileSync(join(here, "node_modules", pkg, "package.json"), "utf8")).version;

const diagrams = readdirSync(join(here, "diagrams"))
  .filter((f) => f.endsWith(".mmd") && f.includes(ONLY))
  .sort()
  .map((f) => ({
    name: f.replace(/\.mmd$/, ""),
    source: readFileSync(join(here, "diagrams", f), "utf8"),
  }));

// ---- Bundles --------------------------------------------------------------------------

// Each entry mirrors what Rome would ship as the lazily imported diagram chunk.
const ENTRIES = {
  mermaid: `import { mermaid } from "@streamdown/mermaid"; export const plugin = mermaid;`,
  pele: `export { renderAsync } from "pele/lazy";`,
  // Size only: the eager entry with every diagram type in one chunk.
  "pele-full": `export { render } from "pele";`,
};

async function build() {
  rmSync(out, { recursive: true, force: true });
  const sizes = {};
  for (const [name, contents] of Object.entries(ENTRIES)) {
    const dir = join(out, name);
    await esbuild.build({
      stdin: { contents, resolveDir: here, loader: "js", sourcefile: `${name}-entry.js` },
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      outdir: dir,
      entryNames: "entry",
      chunkNames: "chunks/[name]-[hash]",
      legalComments: "none",
      logLevel: "error",
    });
    const files = walk(dir).filter((f) => f.endsWith(".js"));
    const measure = (list) => {
      const buf = Buffer.concat(list.map((f) => readFileSync(f)));
      return {
        files: list.length,
        raw: buf.length,
        gzip: gzipSync(buf, { level: 9 }).length,
        brotli: brotliCompressSync(buf).length,
      };
    };
    sizes[name] = { entry: measure([join(dir, "entry.js")]), total: measure(files) };
  }
  return sizes;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ---- Page harness ---------------------------------------------------------------------

const HARNESS = `<!doctype html><meta charset="utf-8"><body style="font-family:${FONT}"><div id="host"></div>`;

function serve() {
  const types = { ".js": "text/javascript", ".html": "text/html", ".svg": "image/svg+xml" };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      return res.end(HARNESS);
    }
    try {
      const body = readFileSync(join(out, path));
      res.writeHead(200, {
        "content-type": types[extname(path)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Runs in the page. Defines window.bench.{load,render}, the only two things timed.
function installHarness({ lib, font }) {
  let mod;
  let seq = 0;
  // Rome's base config from packages/ui/src/markdown.tsx; @streamdown/mermaid adds
  // startOnLoad:false, securityLevel:"strict", suppressErrorRendering:true.
  const config = {
    theme: "base",
    fontFamily: font,
    sequence: { actorFontFamily: font, messageFontFamily: font, noteFontFamily: font },
  };
  window.bench = {
    async load() {
      mod = await import(`/${lib}/entry.js`);
      if (lib === "mermaid") mod = mod.plugin.getMermaid(config);
    },
    // Unique ids keep the saved SVGs from sharing marker and style ids in the gallery.
    async render(source, id = `d${++seq}`) {
      if (lib === "mermaid") return (await mod.render(id, source)).svg;
      return (await mod.renderAsync(source, { fontFamily: font, idPrefix: id })).svg;
    },
  };
}

async function newPage(browser, url, lib) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (CPU_THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  let bytes = 0;
  page.on("requestfinished", async (req) => {
    if (!req.url().endsWith(".js")) return;
    const sizes = await req.sizes().catch(() => null);
    if (sizes) bytes += sizes.responseBodySize;
  });
  await page.goto(url);
  await page.evaluate(installHarness, { lib, font: FONT });
  return { page, cdp, context, bytes: () => bytes };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- Measurements ---------------------------------------------------------------------

// A fresh browser context per sample: import the chunk, then render one diagram.
async function cold(browser, url, lib, diagram) {
  const samples = [];
  let error = null;
  let svg = null;
  let bytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const { page, context, bytes: loaded } = await newPage(browser, url, lib);
    const r = await page.evaluate(
      async ({ source, id }) => {
        const t0 = performance.now();
        await window.bench.load();
        const t1 = performance.now();
        try {
          const svg = await window.bench.render(source, id);
          return { load: t1 - t0, render: performance.now() - t1, svg };
        } catch (e) {
          return { load: t1 - t0, render: performance.now() - t1, error: String(e?.message ?? e) };
        }
      },
      { source: diagram.source, id: `${lib}-${diagram.name}` },
    );
    await page.waitForLoadState("networkidle");
    bytes = loaded();
    await context.close();
    if (r.error) error = r.error;
    else svg = r.svg;
    samples.push(r);
  }
  return {
    load: median(samples.map((s) => s.load)),
    render: median(samples.map((s) => s.render)),
    total: median(samples.map((s) => s.load + s.render)),
    bytes,
    error,
    svg,
  };
}

// One page per library: every diagram renders a few times untimed, then repeatedly.
async function warm(browser, url, lib, list) {
  const { page, context } = await newPage(browser, url, lib);
  await page.evaluate(() => window.bench.load());
  const result = {};
  for (const d of list) {
    result[d.name] = await page.evaluate(
      async ({ source, minMs, minIters }) => {
        try {
          for (let i = 0; i < 3; i++) await window.bench.render(source);
        } catch {
          return null;
        }
        // Renders are timed in batches of at least 5 ms, because performance.now() is
        // coarsened to 0.1 ms on a page that is not cross-origin isolated.
        let size = 1;
        for (;;) {
          const t = performance.now();
          for (let i = 0; i < size; i++) await window.bench.render(source);
          if (performance.now() - t >= 5) break;
          size *= 2;
        }
        const perRender = [];
        const start = performance.now();
        while (perRender.length < minIters || performance.now() - start < minMs) {
          const t = performance.now();
          for (let i = 0; i < size; i++) await window.bench.render(source);
          perRender.push((performance.now() - t) / size);
        }
        perRender.sort((a, b) => a - b);
        return perRender[perRender.length >> 1];
      },
      { source: d.source, minMs: WARM_MIN_MS, minIters: WARM_MIN_ITERS },
    );
  }
  await context.close();
  return result;
}

// JS heap after a forced GC: empty page, after the import, and after rendering the
// whole set three times. "peak" is the largest pre-GC reading taken between renders.
async function memory(browser, url, lib, list) {
  const samples = [];
  for (let i = 0; i < Math.max(3, Math.ceil(RUNS / 2)); i++) {
    const { page, cdp, context } = await newPage(browser, url, lib);
    const heap = async (gc = true) => {
      if (gc) await cdp.send("HeapProfiler.collectGarbage");
      return (await cdp.send("Runtime.getHeapUsage")).usedSize;
    };
    const base = await heap();
    await page.evaluate(() => window.bench.load());
    const loaded = await heap();
    let peak = loaded;
    for (let round = 0; round < 3; round++) {
      for (const d of list) {
        await page.evaluate((s) => window.bench.render(s).catch(() => null), d.source);
        peak = Math.max(peak, await heap(false));
      }
    }
    const rendered = await heap();
    await context.close();
    samples.push({ loaded: loaded - base, rendered: rendered - base, peak: peak - base });
  }
  return {
    loaded: median(samples.map((s) => s.loaded)),
    rendered: median(samples.map((s) => s.rendered)),
    peak: median(samples.map((s) => s.peak)),
  };
}

// ---- Report ---------------------------------------------------------------------------

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const ms = (n) => (n == null ? "—" : n < 1 ? `${n.toFixed(2)} ms` : `${n.toFixed(1)} ms`);
const ratio = (a, b) => (a == null || b == null || b === 0 ? "—" : `${(a / b).toFixed(1)}×`);

function report(env, sizes, rows, mem) {
  const lines = [];
  const p = (s = "") => lines.push(s);
  p(`# Mermaid vs Pele benchmark`);
  p();
  p(
    `Mermaid ${env.mermaid} via @streamdown/mermaid ${env.streamdown}, Pele ${env.pele}, ${env.browser}, ` +
      `${env.cpu}, CPU throttle ${env.throttle}×, ${env.runs} cold runs per cell, ${env.date}.`,
  );
  p();
  p(`## Bundle size (esbuild, minified ESM with code splitting)`);
  p();
  p(`| Bundle | Entry chunk (raw / gzip / brotli) | All chunks (files, raw / gzip / brotli) |`);
  p(`| --- | --- | --- |`);
  for (const [name, s] of Object.entries(sizes)) {
    p(
      `| ${name} | ${kb(s.entry.raw)} / ${kb(s.entry.gzip)} / ${kb(s.entry.brotli)} | ` +
        `${s.total.files}, ${kb(s.total.raw)} / ${kb(s.total.gzip)} / ${kb(s.total.brotli)} |`,
    );
  }
  p();
  p(`## Render time per diagram`);
  p();
  p(
    `Cold is a fresh browser context: import the chunk plus first render, median of ${env.runs}. ` +
      `"JS fetched" is the uncompressed JavaScript that cold render pulled in. ` +
      `Warm is the median of repeated renders on a page that has already rendered that diagram.`,
  );
  p();
  p(
    `| Diagram | Mermaid cold | Pele cold | Cold speedup | Mermaid JS fetched | Pele JS fetched | Mermaid warm | Pele warm | Warm speedup | Pele result |`,
  );
  p(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    const status = r.pele.error ? `fails: ${r.pele.error.split("\n")[0].slice(0, 90)}` : "ok";
    const mstat = r.mermaid.error ? " (Mermaid fails too)" : "";
    p(
      `| ${r.name} | ${ms(r.mermaid.total)} | ${ms(r.pele.total)} | ${ratio(r.mermaid.total, r.pele.total)} | ` +
        `${kb(r.mermaid.bytes)} | ${kb(r.pele.bytes)} | ${ms(r.mermaidWarm)} | ${ms(r.peleWarm)} | ` +
        `${ratio(r.mermaidWarm, r.peleWarm)} | ${status}${mstat} |`,
    );
  }
  const both = rows.filter((r) => r.mermaidWarm != null && r.peleWarm != null);
  p();
  p(
    `Cold split, median across diagrams: Mermaid import ${ms(median(rows.map((r) => r.mermaid.load)))} + ` +
      `first render ${ms(median(rows.map((r) => r.mermaid.render)))}; Pele import ` +
      `${ms(median(rows.map((r) => r.pele.load)))} + first render ${ms(median(rows.map((r) => r.pele.render)))}.`,
  );
  if (both.length) {
    p(
      `Warm total for the ${both.length} diagrams both render: Mermaid ${ms(both.reduce((a, r) => a + r.mermaidWarm, 0))}, ` +
        `Pele ${ms(both.reduce((a, r) => a + r.peleWarm, 0))}.`,
    );
  }
  p();
  p(`## JS heap (after forced GC, delta over an empty page, median)`);
  p();
  p(`| Library | After import | After rendering the set 3× | Peak while rendering |`);
  p(`| --- | --- | --- | --- |`);
  for (const [name, m] of Object.entries(mem))
    p(`| ${name} | ${mb(m.loaded)} | ${mb(m.rendered)} | ${mb(m.peak)} |`);
  p();
  return lines.join("\n");
}

function gallery(rows) {
  const cell = (r, lib) =>
    r[lib].svg
      ? `<div class="svg">${r[lib].svg}</div>`
      : `<pre class="err">${escape(r[lib].error ?? "")}</pre>`;
  return `<!doctype html><meta charset="utf-8"><style>
body{font-family:${FONT};margin:16px;background:#fff;color:#111}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;vertical-align:top;width:50%}
.svg svg{max-width:100%;height:auto}.err{color:#b91c1c;white-space:pre-wrap}h3{margin:0}
</style><table><tr><th>Mermaid</th><th>Pele</th></tr>${rows
    .map(
      (r) =>
        `<tr><td colspan="2"><h3>${r.name}</h3></td></tr><tr><td>${cell(r, "mermaid")}</td><td>${cell(r, "pele")}</td></tr>`,
    )
    .join("")}</table>`;
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ---- Main -----------------------------------------------------------------------------

const sizes = await build();
const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
try {
  const rows = [];
  for (const d of diagrams) {
    process.stderr.write(`cold ${d.name}\n`);
    rows.push({
      name: d.name,
      mermaid: await cold(browser, url, "mermaid", d),
      pele: await cold(browser, url, "pele", d),
    });
  }
  process.stderr.write("warm\n");
  const mw = await warm(browser, url, "mermaid", diagrams);
  const pw = await warm(browser, url, "pele", diagrams);
  for (const r of rows) Object.assign(r, { mermaidWarm: mw[r.name], peleWarm: pw[r.name] });
  process.stderr.write("memory\n");
  const ok = diagrams.filter((d) => !rows.find((r) => r.name === d.name).mermaid.error);
  const mem = {
    mermaid: await memory(browser, url, "mermaid", ok),
    pele: await memory(browser, url, "pele", ok),
  };

  const env = {
    mermaid: version("mermaid"),
    streamdown: version("@streamdown/mermaid"),
    pele: version("pele"),
    browser: `Chromium ${browser.version()}`,
    cpu: `${cpus()[0].model.trim()} ×${cpus().length}`,
    throttle: CPU_THROTTLE,
    runs: RUNS,
    date: new Date().toISOString().slice(0, 10),
  };
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(join(out, "svg"), { recursive: true });
  for (const r of rows) {
    for (const lib of ["mermaid", "pele"])
      if (r[lib].svg) writeFileSync(join(out, "svg", `${r.name}.${lib}.svg`), r[lib].svg);
  }
  writeFileSync(join(out, "gallery.html"), gallery(rows));
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 900 } })
  ).newPage();
  await page.goto(`${url}gallery.html`);
  await page.screenshot({ path: join(out, "gallery.png"), fullPage: true });

  const strip = (r) => ({
    ...r,
    mermaid: { ...r.mermaid, svg: undefined },
    pele: { ...r.pele, svg: undefined },
  });
  const stem = CPU_THROTTLE > 1 ? `results-cpu${CPU_THROTTLE}x` : "results";
  writeFileSync(
    join(resultsDir, `${stem}.json`),
    `${JSON.stringify({ env, sizes, rows: rows.map(strip), memory: mem }, null, 2)}\n`,
  );
  const md = report(env, sizes, rows, mem);
  writeFileSync(join(resultsDir, `${stem}.md`), `${md}\n`);
  console.log(md);
} finally {
  await browser.close();
  server.close();
}
