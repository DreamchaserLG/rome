import { defineConfig } from "@rsbuild/core";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import mockConfig from "../rsbuild.config";

const here = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  ...mockConfig,
  mode: "production",
  source: { ...mockConfig.source, entry: { index: resolve(here, "main.tsx") } },
  server: { ...mockConfig.server, publicDir: false },
  output: {
    ...mockConfig.output,
    sourceMap: false,
    assetPrefix: "./",
    distPath: { root: "dist-embed" },
  },
  performance: { chunkSplit: { strategy: "all-in-one" } },
});
