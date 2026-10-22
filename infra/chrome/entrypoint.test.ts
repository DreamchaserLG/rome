import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@rstest/core";

const ENTRYPOINT = resolve(dirname(fileURLToPath(import.meta.url)), "entrypoint.sh");

let tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs) {
    const pidDir = join(tempDir, "pids");
    for (const name of existsSync(pidDir) ? readdirSync(pidDir) : []) {
      try {
        process.kill(Number(readFileSync(join(pidDir, name), "utf8")), "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeExecutable(path: string, content: string) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

// Leaves a bound unix socket file behind, as an X server killed with its container does.
function bindStaleSocket(path: string) {
  const result = spawnSync(process.execPath, [
    "-e",
    "require('net').createServer().listen(process.argv[1], () => process.exit(0))",
    path,
  ]);
  expect(result.status).toBe(0);
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
}

describe("infra/chrome/entrypoint.sh", () => {
  // `restart: unless-stopped` reuses the container, so /tmp still holds the previous boot's
  // X lock and socket. The fake Xtigervnc refuses to start while the lock exists, the way the
  // real one does when the PID in the lock belongs to a live process in the new namespace.
  it("starts the X server when a previous boot left its lock and socket behind", async () => {
    // A short prefix keeps the socket path under the 104-byte sun_path limit on macOS.
    const tempDir = mkdtempSync(join(tmpdir(), "rce-"));
    tempDirs.push(tempDir);
    const binDir = join(tempDir, "bin");
    const pidDir = join(tempDir, "pids");
    const x11Dir = join(tempDir, ".X11-unix");
    const lockPath = join(tempDir, ".X99-lock");
    const socketPath = join(x11Dir, "X99");
    const xStateFile = join(tempDir, "xtigervnc-state");
    const supervisorFile = join(tempDir, "supervisor-state");
    mkdirSync(binDir);
    mkdirSync(pidDir);
    mkdirSync(x11Dir);
    writeFileSync(lockPath, "         7\n");
    bindStaleSocket(socketPath);

    makeExecutable(
      join(binDir, "Xtigervnc"),
      `#!/usr/bin/env bash
printf '%s' "$$" >"$FAKE_PID_DIR/xtigervnc"
if [ -e "$FAKE_LOCK" ]; then
  echo "Server is already active for display 99" >&2
  printf 'refused\\n' >"$FAKE_X_STATE"
  exit 1
fi
printf '%10d\\n' "$$" >"$FAKE_LOCK"
printf 'serving\\n' >"$FAKE_X_STATE"
exec "$FAKE_NODE" -e "require('net').createServer().listen(process.argv[1])" "$FAKE_SOCKET"
`,
    );
    for (const name of ["openbox", "websockify"]) {
      makeExecutable(
        join(binDir, name),
        `#!/usr/bin/env bash\nprintf '%s' "$$" >"$FAKE_PID_DIR/${name}"\nexec sleep 30\n`,
      );
    }
    const supervisorPath = join(tempDir, "rome-start-chrome-cdp.sh");
    makeExecutable(
      supervisorPath,
      `#!/usr/bin/env bash
if [ -S "$FAKE_SOCKET" ]; then echo socket >"$FAKE_SUPERVISOR_STATE"; else echo none >"$FAKE_SUPERVISOR_STATE"; fi
`,
    );

    // The entrypoint hard-codes /tmp and the image's supervisor path. Point both into the temp dir
    // so the test never touches the host's /tmp or a real supervisor.
    const source = readFileSync(ENTRYPOINT, "utf8");
    expect(source).toContain("exec /opt/rome/scripts/docker/rome-start-chrome-cdp.sh");
    const scriptPath = join(tempDir, "entrypoint.sh");
    writeFileSync(
      scriptPath,
      source
        .replace("exec /opt/rome/scripts/docker/rome-start-chrome-cdp.sh", `exec ${supervisorPath}`)
        .replaceAll("/tmp/", `${tempDir}/`),
    );

    const entrypoint = spawn("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DISPLAY: ":99",
        FAKE_PID_DIR: pidDir,
        FAKE_LOCK: lockPath,
        FAKE_SOCKET: socketPath,
        FAKE_X_STATE: xStateFile,
        FAKE_SUPERVISOR_STATE: supervisorFile,
        FAKE_NODE: process.execPath,
      },
    });
    let stderr = "";
    entrypoint.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolveExit) =>
      entrypoint.once("exit", (code) => resolveExit(code)),
    );

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await waitForFile(xStateFile)).toBe("serving");
    expect(await waitForFile(supervisorFile)).toBe("socket");
  });
});
