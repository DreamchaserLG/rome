import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { findTemplateDir, runCreate } from "./create.js";

describe("rome create", () => {
  let cwd: string;
  const previous = process.cwd();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "rome-create-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(previous);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("finds the monorepo template", () => {
    expect(existsSync(join(findTemplateDir(), "app.yaml"))).toBe(true);
  });

  it("scaffolds the template with the app's id, name and table prefix", async () => {
    await runCreate(["sales-agent", "--name", "Sales Copilot"]);

    const appYaml = readFileSync(join(cwd, "sales-agent", "app.yaml"), "utf8");
    expect(appYaml).toContain("id: sales-agent");
    expect(appYaml).toContain("name: Sales Copilot");
    expect(appYaml).toContain("tablePrefix: sales_agent");
    expect(existsSync(join(cwd, "sales-agent", ".gitignore"))).toBe(true);
    expect(existsSync(join(cwd, "sales-agent", "pnpm-workspace.yaml"))).toBe(true);
    expect(readFileSync(join(cwd, "sales-agent", "test", "app.test.ts"), "utf8")).not.toContain(
      "__APP_ID__",
    );
  });

  it("refuses a directory that already has files", async () => {
    await runCreate(["one", "--dir", "target"]);
    writeFileSync(join(cwd, "target", "extra"), "");

    await expect(runCreate(["two", "--dir", "target"])).rejects.toThrow(/is not empty/);
  });

  it("rejects an id the host would reject", async () => {
    await expect(runCreate(["Not_Valid"])).rejects.toThrow(/not a valid app id/);
  });
});
