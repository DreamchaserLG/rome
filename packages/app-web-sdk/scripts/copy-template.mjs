// Copies packages/app-template/template into templates/app before publish, so
// `rome create` outside the monorepo scaffolds from the same tree Rome's own
// app_management create uses.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "templates", "app");
rmSync(dest, { recursive: true, force: true });
cpSync(join(root, "..", "app-template", "template"), dest, { recursive: true });
