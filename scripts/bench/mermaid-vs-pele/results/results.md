# Mermaid vs Pele benchmark

Mermaid 11.15.0 via @streamdown/mermaid 1.0.2, Pele 1.8.0, Chromium 141.0.7390.37, Intel(R) Xeon(R) Processor @ 2.10GHz ×4, CPU throttle 1×, 5 cold runs per cell, 2026-10-21.

## Bundle size (esbuild, minified ESM with code splitting)

| Bundle | Entry chunk (raw / gzip / brotli) | All chunks (files, raw / gzip / brotli) |
| --- | --- | --- |
| mermaid | 26.7 KB / 10.4 KB / 9.0 KB | 92, 3165.5 KB / 862.9 KB / 651.9 KB |
| pele | 9.3 KB / 3.9 KB / 3.4 KB | 57, 677.6 KB / 256.3 KB / 209.9 KB |
| pele-full | 667.3 KB / 249.6 KB / 201.8 KB | 1, 667.3 KB / 249.6 KB / 201.8 KB |

## Render time per diagram

Cold is a fresh browser context: import the chunk plus first render, median of 5. "JS fetched" is the uncompressed JavaScript that cold render pulled in. Warm is the median of repeated renders on a page that has already rendered that diagram.

| Diagram | Mermaid cold | Pele cold | Cold speedup | Mermaid JS fetched | Pele JS fetched | Mermaid warm | Pele warm | Warm speedup | Pele result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01-test-smoke | 120.0 ms | 41.4 ms | 2.9× | 774.6 KB | 135.0 KB | 12.3 ms | 0.02 ms | 492.0× | ok |
| 02-gallery-sentinel | 139.4 ms | 41.4 ms | 3.4× | 774.6 KB | 135.0 KB | 18.5 ms | 0.05 ms | 348.2× | ok |
| 03-app-architecture | 160.4 ms | 46.0 ms | 3.5× | 774.6 KB | 135.0 KB | 35.1 ms | 0.12 ms | 295.6× | ok |
| 04-sequence-chat-turn | 135.6 ms | 37.1 ms | 3.7× | 755.0 KB | 110.0 KB | 26.9 ms | 0.11 ms | 253.2× | ok |
| 05-state-thread | 213.6 ms | 38.8 ms | 5.5× | 749.9 KB | 123.3 KB | 86.4 ms | 0.32 ms | 265.8× | ok |
| 06-class-subsystems | 202.4 ms | 41.8 ms | 4.8× | 763.5 KB | 128.7 KB | 101.9 ms | 0.20 ms | 509.5× | ok |
| 07-er-core-schema | 221.7 ms | 41.0 ms | 5.4× | 739.2 KB | 108.2 KB | 66.2 ms | 0.17 ms | 378.3× | ok |
| 08-xychart-latency | 100.6 ms | 29.0 ms | 3.5× | 677.0 KB | 50.1 KB | 8.9 ms | 0.04 ms | 237.3× | ok |
| 09-flowchart-large | 277.7 ms | 62.1 ms | 4.5× | 774.6 KB | 135.0 KB | 112.5 ms | 2.8 ms | 40.2× | ok |
| 10-flowchart-styled | 160.3 ms | 44.8 ms | 3.6× | 774.6 KB | 135.0 KB | 35.2 ms | 0.17 ms | 201.1× | ok |
| 11-flowchart-cjk | 152.8 ms | 51.0 ms | 3.0× | 774.6 KB | 135.0 KB | 30.6 ms | 0.10 ms | 296.7× | ok |
| 12-pie-off-list | 171.4 ms | 24.9 ms | 6.9× | 1311.3 KB | 44.1 KB | 4.1 ms | 0.02 ms | 216.0× | ok |
| 13-gantt-off-list | 87.6 ms | 28.7 ms | 3.1× | 687.8 KB | 66.8 KB | 5.6 ms | 0.03 ms | 166.7× | ok |
| 14-mindmap-off-list | 222.7 ms | 26.9 ms | 8.3× | 1176.1 KB | 57.7 KB | 47.5 ms | 0.04 ms | 1147.2× | ok |
| 15-invalid-syntax | 68.0 ms | 32.9 ms | 2.1× | 701.4 KB | 135.0 KB | — | — | — | fails: Parse error on line 3: (Mermaid fails too) |

Cold split, median across diagrams: Mermaid import 55.7 ms + first render 95.8 ms; Pele import 9.2 ms + first render 31.9 ms.
Warm total for the 14 diagrams both render: Mermaid 591.7 ms, Pele 4.2 ms.

## JS heap (after forced GC, delta over an empty page, median)

| Library | After import | After rendering the set 3× | Peak while rendering |
| --- | --- | --- | --- |
| mermaid | 1.27 MB | 11.79 MB | 29.04 MB |
| pele | 0.04 MB | 3.52 MB | 6.07 MB |

