# Theme switch cost

Time for Mermaid to re-render the 14 valid diagrams after a theme or mode switch. Pele renders once and repaints from CSS variables, so its cost is zero renders.

| Theme | Mode | Mermaid re-render |
| --- | --- | --- |
| ember | light | 1088 ms |
| ember | dark | 705 ms |
| ash | light | 732 ms |
| ash | dark | 876 ms |
| slate | light | 672 ms |
| slate | dark | 688 ms |
