// Renders every diagram in ./diagrams with Mermaid and with Pele under each of the
// dashboard's built-in themes, in light and dark, and saves a side-by-side
// screenshot per theme and mode. Mermaid gets the config Rome's Markdown builds
// (Rome's own theme code is bundled from packages/ui and packages/web, so the
// palette stays in sync with the source). Pele gets ./pele-rome-theme.css.
//
//   pnpm install && pnpm themes
//
// Set CHROME to a Chromium/Chrome binary when Playwright's own download is absent.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const out = join(here, "out-themes");
const resultsDir = join(here, "results");
const FONTS =
  "https://fonts.googleapis.com/css2?family=Funnel+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

const diagrams = readdirSync(join(here, "diagrams"))
  .filter((f) => f.endsWith(".mmd") && !f.includes("invalid"))
  .sort()
  .map((f) => ({
    name: f.replace(/\.mmd$/, ""),
    source: readFileSync(join(here, "diagrams", f), "utf8"),
  }));

// Rome's theme modules import React, Streamdown and the router at the top level.
// Only their pure functions run here, so every bare import resolves to an inert stub.
const stubBareImports = {
  name: "stub-bare-imports",
  setup(build) {
    build.onResolve({ filter: /^[^./]|\.css$/ }, (args) =>
      args.resolveDir.startsWith(repo) && !args.resolveDir.startsWith(here)
        ? { path: args.path, namespace: "stub" }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      // esbuild copies a CommonJS module's own keys and keeps its prototype, so
      // the stub answers every named import through a Proxy prototype.
      contents:
        "const f = new Proxy(function () {}, { get: () => f, apply: () => f });" +
        "module.exports = Object.create(new Proxy({}, { get: (_, k) => (k === '__esModule' ? undefined : f) }));",
      loader: "js",
    }));
  },
};

const ENTRIES = {
  mermaid: `import { mermaid } from "@streamdown/mermaid"; export const plugin = mermaid;`,
  pele: `export { renderAsync } from "pele/lazy";`,
  rome: `
    export { readMarkdownMermaidTheme } from "${repo}/packages/ui/src/markdown.tsx";
    export { getBuiltinMermaidTheme } from "${repo}/packages/web/src/components/markdown.tsx";
    export { buildThemeCss, getThemeDefinitions } from "${repo}/packages/web/src/lib/theme.ts";`,
};

async function build() {
  rmSync(out, { recursive: true, force: true });
  for (const [name, contents] of Object.entries(ENTRIES)) {
    await esbuild.build({
      stdin: { contents, resolveDir: here, loader: "js", sourcefile: `${name}-entry.js` },
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      outdir: join(out, name),
      entryNames: "entry",
      chunkNames: "chunks/[name]-[hash]",
      plugins: name === "rome" ? [stubBareImports] : [],
      logLevel: "error",
    });
  }
  const uiTokens = readFileSync(join(repo, "packages/ui/src/styles.css"), "utf8").match(
    /--rome-font-sans:[^;]+;|--rome-font-mono:[^;]+;/g,
  );
  writeFileSync(
    join(out, "index.html"),
    `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${FONTS}">
<style>
:root{${uiTokens.join("")}--font-sans:var(--rome-font-sans);--font-mono:var(--rome-font-mono)}
${readFileSync(join(here, "pele-rome-theme.css"), "utf8")}
body{margin:0;background:var(--chat-canvas);color:var(--foreground);font-family:var(--font-sans)}
h2{margin:0;padding:16px 16px 0;font-weight:600}
table{border-collapse:separate;border-spacing:16px;width:100%;table-layout:fixed}
th{text-align:left;font-weight:600;color:var(--muted-foreground)}
td{vertical-align:top;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}
td.name{background:none;border:0;padding:0 4px;font-size:13px;color:var(--muted-foreground)}
td svg{max-width:100%;height:auto;display:block;margin:0 auto;border-spacing:0}
</style><body><div id="host"></div>`,
  );
}

function serve() {
  const types = { ".js": "text/javascript", ".html": "text/html" };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    try {
      const body = readFileSync(join(out, path === "/" ? "index.html" : path));
      res.writeHead(200, {
        "content-type": types[extname(path) || ".html"] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

// Runs in the page for one theme and mode. Returns how long Mermaid took to
// re-render the set for it, which a theme switch costs Mermaid and not Pele.
async function renderTheme({ theme, mode, diagrams, peleSvgs }) {
  const [rome, mermaidModule] = await Promise.all([
    import("/rome/entry.js"),
    import("/mermaid/entry.js"),
  ]);
  if (!document.getElementById("rome-themes")) {
    const style = document.createElement("style");
    style.id = "rome-themes";
    style.textContent = rome.buildThemeCss(rome.getThemeDefinitions());
    document.head.append(style);
  }
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("dark", mode === "dark");
  await document.fonts.ready;

  // The config Markdown hands @streamdown/mermaid (packages/ui/src/markdown.tsx).
  const { fontFamily, themeVariables } = rome.readMarkdownMermaidTheme(
    rome.getBuiltinMermaidTheme(theme, mode),
  );
  const mermaid = mermaidModule.plugin.getMermaid({
    theme: "base",
    fontFamily,
    themeVariables,
    sequence: {
      actorFontFamily: fontFamily,
      messageFontFamily: fontFamily,
      noteFontFamily: fontFamily,
    },
  });
  const rows = [];
  const start = performance.now();
  for (const d of diagrams) {
    try {
      rows.push((await mermaid.render(`${theme}-${mode}-${d.name}`, d.source)).svg);
    } catch (e) {
      rows.push(`<pre>${String(e?.message ?? e)}</pre>`);
    }
  }
  const mermaidMs = performance.now() - start;

  document.getElementById("host").innerHTML =
    `<h2>${theme} · ${mode}</h2><table><tr><th>Mermaid</th><th>Pele</th></tr>` +
    diagrams
      .map(
        (d, i) =>
          `<tr><td class="name" colspan="2">${d.name}</td></tr><tr><td>${rows[i]}</td><td>${peleSvgs[i]}</td></tr>`,
      )
      .join("") +
    "</table>";
  return { mermaidMs, svgs: rows };
}

await build();
const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await page.goto(url);
  // Pele renders once. Its SVG reads colors from CSS, so every theme reuses it.
  const peleSvgs = await page.evaluate(async (list) => {
    await document.fonts.ready;
    const font = getComputedStyle(document.body).fontFamily;
    const { renderAsync } = await import("/pele/entry.js");
    const svgs = [];
    for (const d of list)
      svgs.push((await renderAsync(d.source, { fontFamily: font, idPrefix: d.name })).svg);
    return svgs;
  }, diagrams);

  const themes = await page.evaluate(async () =>
    (await import("/rome/entry.js")).getThemeDefinitions().map((t) => t.id),
  );
  const timings = [];
  for (const theme of themes) {
    for (const mode of ["light", "dark"]) {
      const { mermaidMs, svgs } = await page.evaluate(renderTheme, {
        theme,
        mode,
        diagrams,
        peleSvgs,
      });
      mkdirSync(join(out, "svg"), { recursive: true });
      svgs.forEach((svg, i) =>
        writeFileSync(join(out, "svg", `${diagrams[i].name}.${theme}-${mode}.mermaid.svg`), svg),
      );
      await page.screenshot({ path: join(out, `${theme}-${mode}.png`), fullPage: true });
      timings.push({ theme, mode, mermaidMs });
      process.stderr.write(`${theme} ${mode}: Mermaid re-render ${mermaidMs.toFixed(0)} ms\n`);
    }
  }
  mkdirSync(resultsDir, { recursive: true });
  const md = [
    "# Theme switch cost",
    "",
    `Time for Mermaid to re-render the ${diagrams.length} valid diagrams after a theme or mode switch. ` +
      "Pele renders once and repaints from CSS variables, so its cost is zero renders.",
    "",
    "| Theme | Mode | Mermaid re-render |",
    "| --- | --- | --- |",
    ...timings.map((t) => `| ${t.theme} | ${t.mode} | ${t.mermaidMs.toFixed(0)} ms |`),
    "",
  ].join("\n");
  writeFileSync(join(resultsDir, "themes.md"), md);
  console.log(md);
} finally {
  await browser.close();
  server.close();
}
