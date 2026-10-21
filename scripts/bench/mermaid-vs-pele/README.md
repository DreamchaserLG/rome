# Mermaid vs Pele benchmark

Compares the diagram renderer Rome ships today, Mermaid through `@streamdown/mermaid` (lazy-loaded by `packages/ui/src/markdown-plugins.ts`), with [Pele](https://github.com/obsidianmd/pele), a Mermaid-syntax renderer with no runtime dependencies. It measures bundle size, cold and warm render time, and JS heap in headless Chromium, and saves both libraries' SVGs side by side so a reader can check what Pele draws.

## Run it

The bench is its own pnpm root, so its dependencies stay out of the workspace lockfile.

```bash
cd scripts/bench/mermaid-vs-pele
pnpm install
pnpm bench                       # 5 cold runs per cell, no CPU throttling
pnpm bench --cpu-throttle 4      # same, with Chromium's 4x CPU slowdown
pnpm bench --only flowchart      # diagrams whose file name contains "flowchart"
```

Set `CHROME` to a Chromium or Chrome binary when Playwright's own browser is not installed. In the cloud dev container that is `CHROME=/opt/pw-browsers/chromium`.

Each run writes:

- `results/results.md` and `results/results.json`, or `results-cpu<N>x.*` for a throttled run.
- `out/gallery.html` and `out/gallery.png`, Mermaid and Pele side by side for every diagram.
- `out/svg/<diagram>.<library>.svg`.

## What it measures

- **Bundle size.** esbuild bundles each library as minified ESM with code splitting, the way Rome's dashboard build splits lazy chunks. The `mermaid` entry is `@streamdown/mermaid`, the module Rome imports. The `pele` entry is `pele/lazy`, which loads one chunk per diagram type. `pele-full` is the eager entry, for size only.
- **Cold render.** A fresh browser context imports the entry chunk and renders one diagram. The time covers the import, the diagram-type chunks it fetches, and the first render. "JS fetched" is the uncompressed JavaScript that render pulled in.
- **Warm render.** One page per library renders each diagram three times untimed, then repeats it for at least 300 ms. Renders are timed in batches of at least 5 ms, because the page's timer is coarsened to 0.1 ms.
- **Memory.** JS heap after a forced GC, as a delta over an empty page: after the import, after rendering the set three times, and the highest pre-GC reading in between.

Both libraries render to an SVG string, which is the work that differs between them. Inserting the string into the page costs the same for either and is not timed. Mermaid uses Rome's base config (`theme: "base"`, Rome's font, `securityLevel: "strict"`), without the host's theme variables.

## Diagrams

`diagrams/` holds 15 diagrams. Rome's chat renders whatever Mermaid the agent writes, so the repo has few diagrams of its own. The set takes those it has and fills in the types the agent prompt names (`packages/core/src/core/prompt-builder.ts`).

| File | Source |
| --- | --- |
| `01-test-smoke` | The fence the Markdown tests render |
| `02-gallery-sentinel` | The component gallery's Markdown specimen |
| `03-app-architecture` | The app-building chat mock fixture |
| `04` to `08` | One per type the agent prompt lists: sequence, state, class, ER, xychart |
| `09-flowchart-large` | A 40-node flowchart with subgraphs, the size of a full architecture overview |
| `10-flowchart-styled` | `%%{init}%%`, `classDef`, `style`, `linkStyle` and `click`, which the prompt asks the agent to avoid but it can still write |
| `11-flowchart-cjk` | Chinese labels and emoji, for the zh-CN locale |
| `12` to `14` | Pie, Gantt and mindmap, which the prompt does not list but Mermaid renders |
| `15-invalid-syntax` | A parse error, to compare the failure path |

## Results

Run on 2026-10-21 in the cloud dev container: Chromium 141, a 4-core Xeon at 2.10 GHz, Mermaid 11.15.0, Pele 1.8.0. Full tables are in [`results/results.md`](results/results.md) and [`results/results-cpu4x.md`](results/results-cpu4x.md).

| Metric | Mermaid | Pele | Ratio |
| --- | --- | --- | --- |
| All chunks, gzip | 862.9 KB | 256.3 KB | 3.4x smaller |
| JS fetched to render one flowchart, uncompressed | 774.6 KB | 135.0 KB | 5.7x less |
| Cold render, median of the 15 diagrams | 160 ms | 41 ms | 3.9x faster |
| Cold render, 40-node flowchart | 278 ms | 62 ms | 4.5x faster |
| Warm render, the 14 valid diagrams in sequence | 592 ms | 4.2 ms | about 140x faster |
| Warm render, 40-node flowchart | 112.5 ms | 2.8 ms | 40x faster |
| JS heap retained after rendering the set 3 times | 11.8 MB | 3.5 MB | 3.4x less |
| JS heap peak while rendering | 29.0 MB | 6.1 MB | 4.8x less |

With 4x CPU throttling the ratios hold and the absolute gap grows. The 40-node flowchart takes 1063 ms cold with Mermaid and 209 ms with Pele, and 659 ms warm with Mermaid against 16.6 ms with Pele. A Mermaid warm render of the whole set blocks the main thread for 3.2 s, Pele's for 30 ms.

## What Pele cannot render

Pele rendered all 14 valid diagrams, and rejected the invalid one with the same parse error Mermaid gives. Its output differs from Mermaid's in these ways:

- **Large flowcharts lay out worse.** On the 40-node flowchart, Pele spreads the subgraphs apart and routes long edges around them, so the diagram is wider and harder to follow than Mermaid's. The smaller flowcharts lay out about as well as Mermaid's.
- **`%%{init}%%` themes are ignored.** Pele colors come from `--pele-*` CSS variables, so the `theme: "dark"` directive in `10-flowchart-styled` has no effect. `classDef`, `style`, and `click` still apply. The agent prompt already forbids `%%{init}%%`, so for Rome this removes a way for an agent to override the dashboard theme.
- **Mindmaps draw as a horizontal tree.** Mermaid draws a radial mindmap with filled nodes. The content is the same.

Pele themes from CSS variables, so the dashboard could point them at Rome's design tokens and let the browser resolve them. Mermaid needs the sRGB palette the dashboard computes today, because its color parser cannot read OKLCH.
