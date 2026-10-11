import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AppManifestData } from "@rome-os/app-runtime/packaging";
import { createTestApp, type TestApp } from "@rome-os/app-runtime/testing";
import { handleRunRequest, type RunContext } from "./run.js";

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function get(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...init.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end(init.body);
  });
}

describe("rome run server", () => {
  let root: string;
  let testApp: TestApp;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "rome-run-"));
    write(root, "secret.txt", "not for the browser");
    write(root, "web/manifest.json", JSON.stringify({ entry: "app.js" }));
    write(root, "web/app.js", "export const mounted = true;");

    testApp = await createTestApp({ appId: "@me/demo", tablePrefix: "demo" });
    await testApp.action("ping", async (config) => ({
      config,
      execute: async (args: Record<string, unknown>) => ({ status: "ok", data: args }),
    }));

    const ctx: RunContext = {
      app: {
        appDir: root,
        builtRoot: root,
        manifest: {
          id: "@me/demo",
          version: "0.1.0",
          web: { manifest: "web/manifest.json" },
        } as AppManifestData,
        tablePrefix: "demo",
      },
      testApp,
      createApiHandler: () => ({
        handle: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("one,"));
                controller.enqueue(new TextEncoder().encode("two"));
                controller.close();
              },
            }),
          ),
      }),
      options: { port: 0, build: false, theme: "light", themeName: "ember" },
      actionNames: ["ping"],
    };
    server = createServer((req, res) => void handleRunRequest(req, res, ctx));
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    port = (server.address() as AddressInfo).port;
    ctx.options.port = port;
  });

  afterEach(async () => {
    await new Promise((closed) => server.close(closed));
    testApp.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses another host name and another site's page", async () => {
    const rebound = await get(port, "/__rome", { headers: { host: `evil.example:${port}` } });
    const crossSite = await get(port, "/__rome/actions/ping", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: "{}",
    });
    const sandboxed = await get(port, "/__rome", { headers: { origin: "null" } });
    const sameOrigin = await get(port, "/__rome", {
      headers: { origin: `http://127.0.0.1:${port}` },
    });

    expect([rebound.status, crossSite.status, sandboxed.status]).toEqual([403, 403, 403]);
    expect(sameOrigin.status).toBe(200);
  });

  it("serves a scoped app's assets under its encoded id, and nothing outside the web dir", async () => {
    const page = await get(port, "/apps/%40me%2Fdemo");
    const asset = await get(port, "/app-assets/%40me%2Fdemo/0.1.0/app.js");
    const escape = await get(port, "/app-assets/%40me%2Fdemo/0.1.0/..%2Fsecret.txt");

    expect(page.body).toContain("/app-assets/%40me%2Fdemo/0.1.0/app.js");
    expect(asset).toEqual({ status: 200, body: "export const mounted = true;" });
    expect(escape.status).toBe(404);
  });

  it("runs an action through the dev endpoint, and 404s a name the app does not have", async () => {
    const ran = await get(port, "/__rome/actions/ping", {
      method: "POST",
      body: JSON.stringify({ args: { n: 1 } }),
    });
    const typo = await get(port, "/__rome/actions/pnig", { method: "POST", body: "{}" });

    expect(ran.status).toBe(200);
    expect(JSON.parse(ran.body)).toEqual({ status: "ok", data: { n: 1 } });
    expect(typo.status).toBe(404);
  });

  it("passes a streamed API response through", async () => {
    const response = await get(port, "/api/apps/%40me%2Fdemo/events");

    expect(response).toEqual({ status: 200, body: "one,two" });
  });
});
