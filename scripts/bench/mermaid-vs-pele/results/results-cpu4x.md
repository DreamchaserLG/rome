# Mermaid vs Pele benchmark

Mermaid 11.15.0 via @streamdown/mermaid 1.0.2, Pele 1.8.0, Chromium 141.0.7390.37, Intel(R) Xeon(R) Processor @ 2.10GHz ×4, CPU throttle 4×, 5 cold runs per cell, 2026-10-21.

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
| 01-test-smoke | 455.0 ms | 119.8 ms | 3.8× | 774.6 KB | 135.0 KB | 71.2 ms | 0.50 ms | 142.4× | ok |
| 02-gallery-sentinel | 453.2 ms | 104.3 ms | 4.3× | 774.6 KB | 135.0 KB | 105.1 ms | 0.80 ms | 131.4× | ok |
| 03-app-architecture | 500.9 ms | 141.0 ms | 3.6× | 774.6 KB | 135.0 KB | 195.1 ms | 1.1 ms | 185.8× | ok |
| 04-sequence-chat-turn | 465.9 ms | 101.4 ms | 4.6× | 755.0 KB | 110.0 KB | 158.0 ms | 0.63 ms | 252.8× | ok |
| 05-state-thread | 868.2 ms | 147.3 ms | 5.9× | 749.9 KB | 123.3 KB | 437.2 ms | 2.6 ms | 168.2× | ok |
| 06-class-subsystems | 859.5 ms | 125.0 ms | 6.9× | 763.5 KB | 128.7 KB | 491.0 ms | 2.0 ms | 245.5× | ok |
| 07-er-core-schema | 887.4 ms | 118.9 ms | 7.5× | 739.2 KB | 108.2 KB | 381.7 ms | 1.9 ms | 206.3× | ok |
| 08-xychart-latency | 302.5 ms | 77.0 ms | 3.9× | 677.0 KB | 50.1 KB | 45.5 ms | 0.29 ms | 158.3× | ok |
| 09-flowchart-large | 1063.0 ms | 209.2 ms | 5.1× | 774.6 KB | 135.0 KB | 659.2 ms | 16.6 ms | 39.7× | ok |
| 10-flowchart-styled | 650.3 ms | 118.0 ms | 5.5× | 774.6 KB | 135.0 KB | 197.1 ms | 1.7 ms | 117.7× | ok |
| 11-flowchart-cjk | 557.7 ms | 172.4 ms | 3.2× | 774.6 KB | 135.0 KB | 159.7 ms | 1.3 ms | 120.5× | ok |
| 12-pie-off-list | 592.8 ms | 75.4 ms | 7.9× | 1311.3 KB | 44.1 KB | 20.5 ms | 0.14 ms | 149.1× | ok |
| 13-gantt-off-list | 339.9 ms | 93.3 ms | 3.6× | 687.8 KB | 66.8 KB | 29.6 ms | 0.24 ms | 121.4× | ok |
| 14-mindmap-off-list | 840.5 ms | 76.7 ms | 11.0× | 1176.1 KB | 57.7 KB | 278.7 ms | 0.19 ms | 1438.5× | ok |
| 15-invalid-syntax | 240.6 ms | 72.8 ms | 3.3× | 701.4 KB | 135.0 KB | — | — | — | fails: Parse error on line 3: (Mermaid fails too) |

Cold split, median across diagrams: Mermaid import 150.3 ms + first render 416.0 ms; Pele import 17.4 ms + first render 100.7 ms.
Warm total for the 14 diagrams both render: Mermaid 3229.6 ms, Pele 29.9 ms.

## JS heap (after forced GC, delta over an empty page, median)

| Library | After import | After rendering the set 3× | Peak while rendering |
| --- | --- | --- | --- |
| mermaid | 1.27 MB | 11.77 MB | 30.33 MB |
| pele | 0.04 MB | 3.51 MB | 6.08 MB |

