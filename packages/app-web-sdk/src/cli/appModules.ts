import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Action, ActionConfig } from "@rome-os/app-runtime";
import {
  ActionConfigSchema,
  type AppManifestData,
  formatZodIssues,
  parseAppManifest,
  parseManifestObject,
} from "@rome-os/app-runtime/packaging";
import { parse as parseYaml } from "yaml";
import { findAppDir } from "./loadAppYaml.js";

/** An app's `app.yaml` plus where its built output lives. */
export interface AppOnDisk {
  appDir: string;
  /** `appRoot` resolved against `appDir`: the tree the host loads modules from. */
  builtRoot: string;
  manifest: AppManifestData;
  tablePrefix: string;
}

export async function readAppOnDisk(startDir: string): Promise<AppOnDisk> {
  const appDir = findAppDir(startDir);
  if (!appDir) {
    throw new Error(`rome: could not locate app.yaml searching upward from ${startDir}`);
  }
  const manifestPath = join(appDir, "app.yaml");
  const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
  return {
    appDir,
    builtRoot: resolve(appDir, manifest.appRoot ?? "."),
    manifest,
    tablePrefix: manifest.db?.tablePrefix ?? manifest.id.replaceAll("-", "_"),
  };
}

/** The relative paths `app.yaml` lists under `key`, whether written as a
 *  string or as `{ path }`. */
export function artifactPaths(manifest: AppManifestData, key: "actions" | "hooks"): string[] {
  return (manifest[key] ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
}

type ActionFactory = (config: ActionConfig, deps: unknown) => Action | Promise<Action>;

interface ActionModule {
  path: string;
  config: ActionConfig;
  factory: ActionFactory;
}

/**
 * Import every action the manifest lists from the built tree, the way the
 * host resolves them: the directory's `action.yaml`, then `createAction`,
 * `create<Name>Action`, a default export, or the one `create*Action` export.
 */
export async function loadActionModules(app: AppOnDisk): Promise<ActionModule[]> {
  const loaded: ActionModule[] = [];
  for (const path of artifactPaths(app.manifest, "actions")) {
    const dir = join(app.builtRoot, path);
    const yamlPath = join(dir, "action.yaml");
    const parsed = ActionConfigSchema.safeParse(parseYaml(readFileSync(yamlPath, "utf8")));
    if (!parsed.success) {
      throw new Error(`Invalid ${yamlPath}:\n${formatZodIssues(parsed.error)}`);
    }
    const config = parsed.data as ActionConfig;
    const module = await importEntry(dir, config.entry);
    loaded.push({ path, config, factory: resolveActionFactory(module, config.name, dir) });
  }
  return loaded;
}

/** Import a hook directory's module and return its `createHook`. */
export async function loadHookFactory(app: AppOnDisk, path: string): Promise<unknown> {
  const dir = join(app.builtRoot, path);
  const module = await importEntry(dir);
  if (typeof module.createHook !== "function") {
    throw new Error(`Hook "${path}" must export createHook(deps) from ${dir}`);
  }
  return module.createHook;
}

/** Import the API entry and return its `createApiHandler`, or null when the app has no API. */
export async function loadApiFactory(app: AppOnDisk): Promise<unknown> {
  if (!app.manifest.api) return null;
  const entry = app.manifest.api.entry ?? "api/index";
  const module = await importFile(join(app.builtRoot, entry));
  if (typeof module.createApiHandler !== "function") {
    throw new Error(`The API module ${entry} must export createApiHandler(ctx)`);
  }
  return module.createApiHandler;
}

async function importEntry(dir: string, entry?: string): Promise<Record<string, unknown>> {
  return importFile(join(dir, entry ?? "index"));
}

async function importFile(entry: string): Promise<Record<string, unknown>> {
  // An action.yaml written against the source names `index.ts`; the build
  // emits `index.js` beside where it was.
  const base = entry.replace(/\.([cm]?)tsx?$/, ".$1js");
  const candidates = /\.[cm]?js$/.test(base)
    ? [base]
    : [`${base}.js`, `${base}.mjs`, join(base, "index.js")];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No built module at ${base} (looked for ${candidates.join(", ")}). Run rome build first.`,
    );
  }
  return (await import(pathToFileURL(found).href)) as Record<string, unknown>;
}

function resolveActionFactory(
  module: Record<string, unknown>,
  actionName: string,
  dir: string,
): ActionFactory {
  const pascal = actionName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
  for (const candidate of [module.createAction, module[`create${pascal}Action`], module.default]) {
    if (typeof candidate === "function") return candidate as ActionFactory;
  }
  const named = Object.entries(module).filter(
    ([name, value]) => /^create[A-Za-z0-9_]*Action$/.test(name) && typeof value === "function",
  );
  if (named.length === 1) return named[0]![1] as ActionFactory;
  throw new Error(
    `No action factory found for "${actionName}" in ${dir}. Export createAction(config, deps) or a single create*Action function.`,
  );
}
