import { join } from "node:path";
import { packArtifact } from "@rome-os/app-runtime/packaging";
import {
  artifactPaths,
  loadActionModules,
  loadApiFactory,
  loadHookFactory,
  readAppOnDisk,
} from "./appModules.js";
import { runBuild } from "./build.js";
import { CliError } from "./store/config.js";

const HELP = `rome validate — check an app the way an install does, without a Rome

Usage: rome validate [--no-build]

  1. Builds the app (rome build), unless --no-build.
  2. Packs it into .rome/artifact with the same strict app.yaml schema and
     per-artifact checks the daemon runs on install.
  3. Imports every action, hook and the API entry from the build, and checks
     each exports the factory the host calls.

Exits 1 with the first problem found.
`;

export async function runValidate(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--no-build");
  if (unknown.length > 0)
    throw new CliError(`rome validate: unknown argument(s): ${unknown.join(" ")}`, 2);

  const app = await readAppOnDisk(process.cwd());
  if (!argv.includes("--no-build")) {
    process.chdir(app.appDir);
    await runBuild();
  }

  const outDir = join(app.appDir, ".rome", "artifact");
  try {
    await packArtifact(app.appDir, outDir, { clean: true });
  } catch (err) {
    throw new CliError(`✗ pack: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
  process.stdout.write(`✓ pack: ${app.manifest.id}@${app.manifest.version} → ${outDir}\n`);

  try {
    const actions = await loadActionModules(app);
    for (const path of artifactPaths(app.manifest, "hooks")) await loadHookFactory(app, path);
    const api = await loadApiFactory(app);
    process.stdout.write(
      `✓ modules: ${actions.length} action(s), ${artifactPaths(app.manifest, "hooks").length} hook(s)${api ? ", API entry" : ""}\n`,
    );
  } catch (err) {
    throw new CliError(`✗ modules: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
}
